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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
