// =============================================================================
// La trampa nº2 de CLAUDE.md, para las variables sin las que el pack 'recall'
// no funciona en producción.
//
// hostinger/deploy-on-vps REESCRIBE el .env de la VPS con lo que diga
// `environment-variables` en deploy.yml. Una variable que está en
// .env.example y en docker-compose.yml pero no en deploy.yml llega vacía al
// contenedor en cada despliegue, aunque alguien la haya puesto a mano en la
// VPS. El síntoma es idéntico a "no configurado". Así estuvo
// GOOGLE_TOKEN_ENCRYPTION_KEY hasta el 2026-09-15: reseñas, incluidas en el
// pack, no podían conectarse en producción.
//
// No es la lista de TODAS las variables: las opcionales de productos que aún
// no se venden degradan con gracia y se activan una a una (ver el comentario
// de deploy.yml). Es la lista de las que un cliente de recall necesita el
// primer día.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = (p: string) => readFileSync(join(process.cwd(), '..', p), 'utf8');
const portal = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** [nombre, secreto o variable pública] */
const RECALL_PACK_ENV: ReadonlyArray<[string, 'secrets' | 'vars']> = [
  ['META_CREDENTIAL_ENCRYPTION_KEY', 'secrets'],
  ['TWILIO_CREDENTIAL_ENCRYPTION_KEY', 'secrets'],
  ['WHISPER_API_KEY', 'secrets'],
  ['ANTHROPIC_API_KEY', 'secrets'],
  ['GOOGLE_TOKEN_ENCRYPTION_KEY', 'secrets'],
  ['VAPID_PRIVATE_KEY', 'secrets'],
  ['VAPID_PUBLIC_KEY', 'vars'],
  ['CRON_SECRET', 'secrets'],
  // Sin destinatarios, ninguna alerta de operador sale — incluida la de
  // "este negocio se ha quedado sin WhatsApp".
  ['KAIRIKOS_OPERATOR_EMAILS', 'vars'],
];

describe('las variables del pack recall llegan al contenedor en cada despliegue', () => {
  it.each(RECALL_PACK_ENV)('%s está en .env.example, docker-compose.yml y deploy.yml', (name, source) => {
    expect(portal('.env.example'), '.env.example').toMatch(new RegExp(`^${name}=`, 'm'));
    expect(repo('docker-compose.yml'), 'docker-compose.yml').toContain(`${name}:`);
    // Con el origen exacto: un secreto puesto como `vars.` se publicaría en
    // los logs del workflow, y uno que apunta al nombre equivocado llega
    // vacío sin avisar.
    expect(repo('.github/workflows/deploy.yml'), 'deploy.yml').toContain(`${name}=\${{ ${source}.${name} }}`);
  });
});

// =============================================================================
// Las claves de cifrado, TODAS. A diferencia de las variables opcionales, una
// clave que el código lee no degrada con gracia: sin ella, lo que protege no
// se puede guardar ni leer. GOOGLE_SEO_TOKEN_ENCRYPTION_KEY y
// GOOGLE_GA4_TOKEN_ENCRYPTION_KEY estaban en .env.example y en
// docker-compose.yml pero nunca en deploy.yml: en producción llegaban vacías
// y Search Console y GA4 no podían conectarse. Se vio el 28/09/2026 al
// revisar el panel de claves (lib/claves-de-cifrado.ts).
// =============================================================================

vi.mock('server-only', () => ({}));

import { CLAVES_DE_CIFRADO } from '@/lib/claves-de-cifrado';

/** Todos los *_ENCRYPTION_KEY que aparecen en src, menos la propia lista. */
function clavesQueLeeElCodigo(): string[] {
  const encontradas = new Set<string>();
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(ruta);
      else if (/\.tsx?$/.test(entrada.name) && !ruta.endsWith(join('lib', 'claves-de-cifrado.ts'))) {
        for (const m of readFileSync(ruta, 'utf8').matchAll(/\b[A-Z0-9_]+_ENCRYPTION_KEY\b/g)) encontradas.add(m[0]);
      }
    }
  };
  recorrer(join(process.cwd(), 'src'));
  return [...encontradas].sort();
}

describe('las claves de cifrado', () => {
  it('la lista del panel es exactamente la de claves que lee el código', () => {
    expect(CLAVES_DE_CIFRADO.map((c) => c.nombre).sort()).toEqual(clavesQueLeeElCodigo());
  });

  it.each(CLAVES_DE_CIFRADO.map((c) => c.nombre))(
    '%s está en .env.example, docker-compose.yml y deploy.yml (como secreto)',
    (name) => {
      expect(portal('.env.example'), '.env.example').toMatch(new RegExp(`^${name}=`, 'm'));
      expect(repo('docker-compose.yml'), 'docker-compose.yml').toContain(`${name}:`);
      expect(repo('.github/workflows/deploy.yml'), 'deploy.yml').toContain(`${name}=\${{ secrets.${name} }}`);
    },
  );
});
