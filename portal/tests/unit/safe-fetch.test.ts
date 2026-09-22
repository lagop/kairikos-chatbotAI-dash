// =============================================================================
// Seguridad (22/09/2026) — tests para src/lib/safe-fetch.ts.
//
// Con servidores HTTP de verdad en 127.0.0.1: lo que se prueba es a qué se
// conecta y a qué no, y eso no se puede probar con fetch mockeado. Para los
// casos que necesitan un destino "permitido", `createSafeFetch` recibe una
// regla de bloqueo propia; los de "prohibido" usan la de producción.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type dns from 'node:dns';
import { safeFetch, createSafeFetch, isBlockedAddress, BlockedUrlError } from '@/lib/safe-fetch';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
async function serve(handler: Handler): Promise<{ origin: string; hits: http.IncomingMessage[] }> {
  const hits: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits };
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

/** Todo permitido: para probar el comportamiento normal contra 127.0.0.1. */
const openFetch = createSafeFetch({ isBlocked: () => false });

function fakeLookup(table: Record<string, string>): typeof dns.lookup {
  return ((hostname: string, options: dns.LookupOptions, callback: (...a: unknown[]) => void) => {
    const address = table[hostname];
    if (!address) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const family = address.includes(':') ? 6 : 4;
    if (options && typeof options === 'object' && options.all) return callback(null, [{ address, family }]);
    callback(null, address, family);
  }) as typeof dns.lookup;
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '::7f00:1',
    'fd00::1', 'fe80::1%eth0', '64:ff9b::a00:1', 'no-es-una-ip',
  ])('prohíbe %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('deja pasar %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('safeFetch — lo que nunca sale', () => {
  let target: { origin: string; hits: http.IncomingMessage[] };
  beforeAll(async () => {
    target = await serve((_req, res) => res.end('secreto interno'));
  });

  it('no conecta a una IP interna escrita en la URL', async () => {
    await expect(safeFetch(`${target.origin}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(target.hits).toHaveLength(0);
  });

  it.each([
    ['localhost', 'http://localhost:5678/'],
    ['nombre de servicio de Docker', 'http://n8n:5678/rest/workflows'],
    ['IP en decimal', 'http://2130706433/'],
    ['IPv4 dentro de IPv6', 'http://[::ffff:127.0.0.1]/'],
    ['metadatos de la nube', 'http://169.254.169.254/latest/meta-data/'],
    ['otro protocolo', 'file:///etc/passwd'],
    ['credenciales en la URL', 'http://user:pw@example.com/'],
  ])('rechaza %s', async (_label, url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rechaza un dominio público que resuelve a una IP interna, al conectar', async () => {
    const guarded = createSafeFetch({ lookup: fakeLookup({ 'intranet.example.com': '10.0.0.5' }) });
    await expect(guarded('http://intranet.example.com/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rechaza una redirección hacia dentro — cada salto se comprueba de nuevo', async () => {
    const outside = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://intranet.example.com:5678/' });
      res.end();
    });
    const guarded = createSafeFetch({
      isBlocked: (address) => address !== '127.0.0.1' && isBlockedAddress(address),
      lookup: fakeLookup({ 'intranet.example.com': '10.0.0.5' }),
    });
    await expect(guarded(`${outside.origin}/r`)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(outside.hits).toHaveLength(1);
  });
});

describe('safeFetch — cuando el destino es válido', () => {
  it('devuelve un Response normal, con el cuerpo descomprimido', async () => {
    const { origin } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<p>Hola</p>'));
    });
    const res = await openFetch(`${origin}/`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<p>Hola</p>');
  });

  it('corta el cuerpo en maxBytes, después de descomprimir', async () => {
    const { origin } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('a'.repeat(1_000_000)));
    });
    const res = await openFetch(`${origin}/`, { maxBytes: 1000 });
    expect((await res.text()).length).toBe(1000);
  });

  it('sigue redirecciones en GET', async () => {
    const final = await serve((_req, res) => res.end('destino'));
    const hop = await serve((_req, res) => {
      res.writeHead(301, { location: `${final.origin}/fin` });
      res.end();
    });
    const res = await openFetch(`${hop.origin}/`);
    expect(await res.text()).toBe('destino');
  });

  it('no reenvía un POST con credenciales a otro sitio: devuelve la redirección tal cual', async () => {
    const final = await serve((_req, res) => res.end('no debería llegar'));
    const hop = await serve((_req, res) => {
      res.writeHead(307, { location: `${final.origin}/` });
      res.end();
    });
    const res = await openFetch(`${hop.origin}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { authorization: 'Basic c2VjcmV0bw==', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(307);
    expect(final.hits).toHaveLength(0);
  });

  it('al cambiar de origen en una redirección, quita authorization y cookie', async () => {
    const final = await serve((_req, res) => res.end('ok'));
    const hop = await serve((_req, res) => {
      res.writeHead(302, { location: `${final.origin}/` });
      res.end();
    });
    await openFetch(`${hop.origin}/`, { headers: { Authorization: 'Bearer x', Cookie: 'a=b', 'user-agent': 'kairikos' } });
    expect(final.hits[0].headers.authorization).toBeUndefined();
    expect(final.hits[0].headers.cookie).toBeUndefined();
    expect(final.hits[0].headers['user-agent']).toBe('kairikos');
  });

  it('se rinde tras demasiadas redirecciones', async () => {
    let origin = '';
    ({ origin } = await serve((_req, res) => {
      res.writeHead(302, { location: `${origin}/otra` });
      res.end();
    }));
    await expect(openFetch(`${origin}/`, { maxRedirects: 3 })).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
