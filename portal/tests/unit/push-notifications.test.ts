// =============================================================================
// Fase 5d — tests del envío de notificaciones push.
//
// Tres cosas que no pueden fallar:
//
//   1. NUNCA LANZA. El push es un canal extra; el recado ya salió por
//      WhatsApp. Un fallo aquí no puede tumbar ese flujo.
//   2. LA URL SOLO PUEDE SER DEL PORTAL. Una notificación que abra un
//      dominio ajeno convierte un aviso legítimo en phishing con nuestra
//      marca.
//   3. LAS SUSCRIPCIONES MUERTAS SE BORRAN. Sin eso la tabla crece con
//      dispositivos desinstalados y cada aviso gasta una petición por cada
//      uno, para siempre.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { readFileSync as readRepoFile } from 'node:fs';
import { join as joinPath } from 'node:path';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import {
  serialisePayload,
  isGoneStatus,
  sendPushToClient,
  isPushConfigured,
} from '@/lib/push-notifications';

const state = {
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const prisma = {
  pushSubscription: {
    findMany: (...a: unknown[]) => state.findMany(...a),
    update: (...a: unknown[]) => state.update(...a),
    delete: (...a: unknown[]) => state.delete(...a),
  },
} as unknown as PrismaClient;

const PAYLOAD = { title: 'Nueva llamada perdida', body: 'Te han dejado un recado.', url: '/portal/llamadas', tag: 'missed-calls' };
const SUB = { id: 's1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a' };

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.findMany.mockResolvedValue([SUB]);
  state.update.mockResolvedValue({});
  state.delete.mockResolvedValue({});
});

describe('serialisePayload', () => {
  it('acepta una ruta del portal', () => {
    expect(serialisePayload(PAYLOAD)).toContain('/portal/llamadas');
  });

  // El phishing con nuestra marca.
  it.each(['https://evil.example/login', '//evil.example', '/admin/portal', 'javascript:alert(1)'])(
    'RECHAZA abrir «%s»',
    (url) => {
      expect(serialisePayload({ ...PAYLOAD, url })).toBeNull();
    },
  );

  it('recorta título y cuerpo en vez de mandar algo que la pantalla de bloqueo corte a su manera', () => {
    const json = JSON.parse(serialisePayload({ ...PAYLOAD, title: 'x'.repeat(500), body: 'y'.repeat(500) })!);
    expect(json.title.length).toBe(80);
    expect(json.body.length).toBe(180);
  });
});

describe('isGoneStatus', () => {
  it('404 y 410 significan que la suscripción ya no existe', () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
  });

  it('cualquier otro error es transitorio y la fila se conserva', () => {
    for (const code of [400, 413, 429, 500, 503, undefined]) expect(isGoneStatus(code)).toBe(false);
  });
});

describe('sendPushToClient', () => {
  it('sin claves VAPID no hace nada y lo dice, sin tocar la base', async () => {
    const saved = { ...process.env };
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    try {
      expect(isPushConfigured()).toBe(false);
      await expect(sendPushToClient(prisma, 'client_1', PAYLOAD)).resolves.toMatchObject({
        skipped: 'not_configured',
      });
      expect(state.findMany).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });

  it('envía a TODOS los dispositivos del cliente y marca el éxito', async () => {
    state.findMany.mockResolvedValue([SUB, { ...SUB, id: 's2', endpoint: 'https://updates.push.services.mozilla.com/x' }]);
    const send = vi.fn().mockResolvedValue({});

    const result = await sendPushToClient(prisma, 'client_1', PAYLOAD, { send });

    expect(result).toMatchObject({ sent: 2, failed: 0, pruned: 0 });
    expect(state.findMany.mock.calls[0][0].where).toEqual({ clientId: 'client_1' });
    expect(state.update).toHaveBeenCalledTimes(2);
  });

  it('BORRA la suscripción cuando el servicio responde 410', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    const result = await sendPushToClient(prisma, 'client_1', PAYLOAD, { send });

    expect(result).toMatchObject({ sent: 0, pruned: 1, failed: 0 });
    expect(state.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('CONSERVA la suscripción ante un error transitorio', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { statusCode: 503 }));
    const result = await sendPushToClient(prisma, 'client_1', PAYLOAD, { send });

    expect(result).toMatchObject({ failed: 1, pruned: 0 });
    expect(state.delete).not.toHaveBeenCalled();
  });

  it('un dispositivo que falla no impide avisar a los demás', async () => {
    state.findMany.mockResolvedValue([SUB, { ...SUB, id: 's2', endpoint: 'https://x.example/2' }]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 503 }))
      .mockResolvedValueOnce({});
    const result = await sendPushToClient(prisma, 'client_1', PAYLOAD, { send });
    expect(result).toMatchObject({ sent: 1, failed: 1 });
  });

  it('NUNCA lanza, ni siquiera si la base de datos se cae', async () => {
    state.findMany.mockRejectedValue(new Error('postgres caído'));
    await expect(sendPushToClient(prisma, 'client_1', PAYLOAD, { send: vi.fn() })).resolves.toMatchObject({
      failed: 1,
    });
  });

  it('manda con TTL corto: un aviso de llamada que llega al día siguiente ya no es un aviso', async () => {
    const send = vi.fn().mockResolvedValue({});
    await sendPushToClient(prisma, 'client_1', PAYLOAD, { send });
    expect(send.mock.calls[0][2]).toMatchObject({ TTL: 3600 });
  });

  it('no envía un payload inválido', async () => {
    const send = vi.fn();
    const result = await sendPushToClient(prisma, 'client_1', { ...PAYLOAD, url: 'https://evil.example' }, { send });
    expect(result.skipped).toBe('invalid_payload');
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// La trampa nº2 de CLAUDE.md, para estas tres variables.
//
// Una variable que está en .env.example pero no en docker-compose.yml o
// en la plantilla de deploy.yml NUNCA llega al contenedor, y el síntoma es
// indistinguible de "no configurado": push se desactiva en silencio. En
// esta misma tanda de trabajo el primer intento de cablearlas dejó dos de
// los tres ficheros sin tocar (saltos de línea CRLF) y solo se vio
// contando.
// ---------------------------------------------------------------------------
describe('las variables VAPID llegan al contenedor', () => {
  const repo = (p: string) => readRepoFile(joinPath(process.cwd(), '..', p), 'utf8');

  it.each(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])('%s está en los tres sitios', (name) => {
    expect(readRepoFile(joinPath(process.cwd(), '.env.example'), 'utf8'), '.env.example').toContain(name);
    expect(repo('docker-compose.yml'), 'docker-compose.yml').toContain(`${name}:`);
    expect(repo('.github/workflows/deploy.yml'), 'deploy.yml').toContain(`${name}=`);
  });

  it('la clave PRIVADA viaja como secreto, nunca como variable pública', () => {
    expect(repo('.github/workflows/deploy.yml')).toContain('VAPID_PRIVATE_KEY=${{ secrets.VAPID_PRIVATE_KEY }}');
  });
});
