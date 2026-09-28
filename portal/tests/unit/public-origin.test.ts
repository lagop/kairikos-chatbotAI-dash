// =============================================================================
// De dónde sale la dirección pública del portal.
//
// Escrito DESPUÉS de que el fallo llegara a producción: el primer borrador
// generado desde el formulario público devolvió
// `https://0.0.0.0:3000/mi-web/<testigo>`, porque detrás del proxy el origin
// de la petición es la red interna de Docker. El mismo fallo que ya mordió
// con el widget del chatbot, por el mismo motivo: en local funciona.
//
// Lo peor no era el enlace de la respuesta, que se ve enseguida: era que ese
// mismo origin se estaba metiendo en el formulario de las webs PUBLICADAS.
// Una web en el servidor de un cliente con un formulario apuntando a
// 0.0.0.0 no da error en ningún sitio: simplemente no envía nunca.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { publicOrigin } from '@/lib/public-origin';

function request(headers: Record<string, string> = {}, url = 'https://0.0.0.0:3000/api/x'): Request {
  return new Request(url, { headers });
}

const original = process.env.NEXT_PUBLIC_PORTAL_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_PORTAL_URL;
  else process.env.NEXT_PUBLIC_PORTAL_URL = original;
});

describe('publicOrigin', () => {
  it('la variable configurada manda sobre todo lo demás', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.cloud';
    expect(publicOrigin(request({ host: '0.0.0.0:3000' }))).toBe('https://portal.kairikos.cloud');
  });

  it('se le quita la barra final, que duplicaría barras al componer', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.cloud/';
    expect(publicOrigin(request())).toBe('https://portal.kairikos.cloud');
  });

  it('sin variable, las cabeceras del proxy', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    const origin = publicOrigin(
      request({ 'x-forwarded-host': 'portal.kairikos.cloud', 'x-forwarded-proto': 'https' }),
    );
    expect(origin).toBe('https://portal.kairikos.cloud');
  });

  it('NUNCA devuelve la dirección interna del contenedor como buena', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    // Sin variable y sin cabeceras útiles cae al origin de la petición, que
    // en desarrollo es correcto; lo que no puede pasar es que un host
    // 0.0.0.0 se tome como bueno cuando hay cabeceras.
    expect(publicOrigin(request({ host: '0.0.0.0:3000', 'x-forwarded-host': 'portal.test' }))).toBe(
      'https://portal.test',
    );
    expect(publicOrigin(request({ host: '127.0.0.1:3000', 'x-forwarded-host': 'portal.test' }))).toBe(
      'https://portal.test',
    );
  });

  it('en desarrollo, sin proxy ni variable, vale el origin de la petición', () => {
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    expect(publicOrigin(request({ host: 'localhost:3000' }, 'http://localhost:3000/api/x'))).toBe(
      'https://localhost:3000',
    );
  });
});
