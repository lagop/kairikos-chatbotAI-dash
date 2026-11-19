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
// La copia externa cifrada de la base de datos (29/09/2026). Las usa el
// contenedor backup, no la app, pero la trampa es la misma: si no están en
// deploy.yml, el .env de la VPS se reescribe sin ellas en cada despliegue y la
// copia externa se queda desactivada sin que nadie lo note.
// =============================================================================

const COPIA_EXTERNA: ReadonlyArray<[string, 'secrets' | 'vars']> = [
  ['BACKUP_AGE_RECIPIENT', 'vars'],
  ['BACKUP_OFFSITE_PROVIDER', 'vars'],
  ['BACKUP_OFFSITE_ENDPOINT', 'vars'],
  ['BACKUP_OFFSITE_REGION', 'vars'],
  ['BACKUP_OFFSITE_BUCKET', 'vars'],
  ['BACKUP_OFFSITE_ACCESS_KEY_ID', 'secrets'],
  ['BACKUP_OFFSITE_SECRET_ACCESS_KEY', 'secrets'],
];

describe('la copia externa de la base de datos', () => {
  it.each(COPIA_EXTERNA)('%s está en .env.example, docker-compose.yml y deploy.yml', (name, source) => {
    expect(portal('.env.example'), '.env.example').toMatch(new RegExp(`^${name}=`, 'm'));
    expect(repo('docker-compose.yml'), 'docker-compose.yml').toContain(`${name}:`);
    expect(repo('.github/workflows/deploy.yml'), 'deploy.yml').toContain(`${name}=\${{ ${source}.${name} }}`);
  });

  it('la clave PRIVADA de age no se cablea en ningún sitio: solo vive fuera de línea', () => {
    for (const f of [repo('docker-compose.yml'), repo('.github/workflows/deploy.yml'), portal('.env.example')]) {
      expect(f).not.toMatch(/AGE_SECRET_KEY|BACKUP_AGE_IDENTITY|AGE-SECRET-KEY-/);
    }
  });
});

// 30/09/2026 — la clave que cifra la URL y el secreto del webhook de leads
// (lead-webhook-crypto.ts). Es un secreto: tiene que venir de `secrets.`.
describe('LEAD_WEBHOOK_ENCRYPTION_KEY llega al contenedor', () => {
  it('está en .env.example, docker-compose.yml y deploy.yml, como secreto', () => {
    expect(portal('.env.example')).toMatch(/^LEAD_WEBHOOK_ENCRYPTION_KEY=/m);
    expect(repo('docker-compose.yml')).toContain('LEAD_WEBHOOK_ENCRYPTION_KEY:');
    expect(repo('.github/workflows/deploy.yml')).toContain('LEAD_WEBHOOK_ENCRYPTION_KEY=${{ secrets.LEAD_WEBHOOK_ENCRYPTION_KEY }}');
  });
});

// 15/11/2026 — Reserva propia para villas (docs/plan-reserva-villas.md). La
// clave que cifra la clave de Stripe de cada dueño es un secreto; el
// interruptor del modo real es una variable pública y, mientras llegue vacía,
// solo se aceptan claves de prueba: que se pierda en un despliegue apaga los
// cobros reales en vez de encenderlos.
describe('las variables de la reserva de villas llegan al contenedor', () => {
  it.each([
    ['VILLAS_STRIPE_CREDENTIAL_ENCRYPTION_KEY', 'secrets'],
    ['VILLAS_STRIPE_LIVE_ENABLED', 'vars'],
  ] as const)('%s está en .env.example, docker-compose.yml y deploy.yml', (name, source) => {
    expect(portal('.env.example'), '.env.example').toMatch(new RegExp(`^${name}=`, 'm'));
    expect(repo('docker-compose.yml'), 'docker-compose.yml').toContain(`${name}:`);
    expect(repo('.github/workflows/deploy.yml'), 'deploy.yml').toContain(`${name}=\${{ ${source}.${name} }}`);
  });

  it('el modo real viene apagado en .env.example', () => {
    expect(portal('.env.example')).toMatch(/^VILLAS_STRIPE_LIVE_ENABLED=(false)?$/m);
  });
});

// 19/11/2026 — Cartera inmobiliaria (decisión A: fotos en un volumen de la
// VPS). CARTERA_FOTOS_DIR no es un secreto: es la ruta del volumen dentro del
// contenedor, fija en deploy.yml. Si se pierde en un despliegue, el compose
// cae en el mismo valor por defecto; lo que no puede pasar es que la ruta del
// volumen y la variable dejen de coincidir, porque las fotos darían 404 sin
// error ninguno.
describe('las fotos de la cartera llegan al contenedor', () => {
  const RUTA = '/data/cartera-fotos';

  it('CARTERA_FOTOS_DIR está en .env.example, docker-compose.yml y deploy.yml', () => {
    expect(portal('.env.example')).toMatch(/^CARTERA_FOTOS_DIR=/m);
    expect(repo('docker-compose.yml')).toContain(`CARTERA_FOTOS_DIR: \${CARTERA_FOTOS_DIR:-${RUTA}}`);
    expect(repo('.github/workflows/deploy.yml')).toContain(`CARTERA_FOTOS_DIR=${RUTA}`);
  });

  it('el volumen cartera-fotos está declarado y montado en esa misma ruta', () => {
    const compose = repo('docker-compose.yml');
    expect(compose).toContain(`- cartera-fotos:${RUTA}`);
    expect(compose).toMatch(/^ {2}cartera-fotos:\s*\n\s+name: kairikos-portal-cartera-fotos/m);
  });

  it('la imagen crea el punto de montaje con dueño nextjs (el contenedor no corre como root)', () => {
    expect(portal('Dockerfile')).toContain(`mkdir -p ${RUTA} && chown nextjs:nodejs ${RUTA}`);
  });
});
