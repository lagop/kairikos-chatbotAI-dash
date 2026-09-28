// =============================================================================
// Destinatarios de las alertas de operador — lib/operator-alert-settings.ts,
// su ruta de admin, y el guardia de que nadie vuelva a leer la variable de
// entorno por su cuenta.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Seguridad (22/09/2026): estas rutas piden TOTP reciente. Aquí se da por
// verificado; el rechazo sin él se prueba en stepup-gated-admin-routes.test.ts.
const stepUpState = vi.hoisted(() => ({ requireTotpStepUp: vi.fn() }));
vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => stepUpState.requireTotpStepUp(...a),
}));
beforeEach(() => {
  stepUpState.requireTotpStepUp.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1', sessionId: 's1' });
});

import type { NextRequest } from 'next/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  operatorFindUnique: vi.fn(),
  authenticateAdminRequest: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operatorAlertSettings: {
      findUnique: (...a: unknown[]) => mockState.settingsFindUnique(...a),
      upsert: (...a: unknown[]) => mockState.settingsUpsert(...a),
    },
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
  },
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  getOperatorAlertRecipients,
  getCeoAlertEmail,
  getOperatorAlertSettingsView,
  normaliseAlertSettings,
  OPERATOR_ALERT_SETTINGS_SINGLETON_ID,
} from '@/lib/operator-alert-settings';
import { GET, POST } from '@/app/api/admin/portal/settings/alerts/route';

const ROW = {
  id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID,
  operatorEmails: ['kairikos.devs@gmail.com'],
  ceoEmail: 'ceo@kairikos.com',
  updatedAt: new Date('2026-09-15T21:00:00Z'),
  updatedBy: 'op@kairikos.com',
};

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.settingsFindUnique.mockReset().mockResolvedValue(null);
  mockState.settingsUpsert.mockReset().mockResolvedValue(ROW);
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.logError.mockReset();
  vi.stubEnv('KAIRIKOS_OPERATOR_EMAILS', '');
  vi.stubEnv('KAIRIKOS_CEO_EMAIL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getOperatorAlertRecipients', () => {
  it('lo guardado en el portal manda sobre la variable de entorno', async () => {
    vi.stubEnv('KAIRIKOS_OPERATOR_EMAILS', 'viejo@kairikos.com');
    mockState.settingsFindUnique.mockResolvedValue(ROW);
    await expect(getOperatorAlertRecipients()).resolves.toEqual([{ email: 'kairikos.devs@gmail.com' }]);
  });

  it('sin fila, usa la variable de entorno', async () => {
    vi.stubEnv('KAIRIKOS_OPERATOR_EMAILS', 'a@kairikos.com, b@kairikos.com');
    await expect(getOperatorAlertRecipients()).resolves.toEqual([{ email: 'a@kairikos.com' }, { email: 'b@kairikos.com' }]);
  });

  it('una base de datos caída no deja además sin alertas: cae a la variable, sin lanzar', async () => {
    vi.stubEnv('KAIRIKOS_OPERATOR_EMAILS', 'a@kairikos.com');
    mockState.settingsFindUnique.mockRejectedValue(new Error('db down'));
    await expect(getOperatorAlertRecipients()).resolves.toEqual([{ email: 'a@kairikos.com' }]);
  });

  it('sin nada configurado, lista vacía — que es lo que cada llamante ya sabe tratar', async () => {
    await expect(getOperatorAlertRecipients()).resolves.toEqual([]);
  });
});

describe('getCeoAlertEmail', () => {
  it('portal, luego variable, luego null', async () => {
    vi.stubEnv('KAIRIKOS_CEO_EMAIL', 'env-ceo@kairikos.com');
    mockState.settingsFindUnique.mockResolvedValueOnce(ROW);
    await expect(getCeoAlertEmail()).resolves.toBe('ceo@kairikos.com');
    await expect(getCeoAlertEmail()).resolves.toBe('env-ceo@kairikos.com');
    vi.stubEnv('KAIRIKOS_CEO_EMAIL', '');
    await expect(getCeoAlertEmail()).resolves.toBeNull();
  });
});

describe('getOperatorAlertSettingsView', () => {
  it('dice de dónde sale cada valor — la parte que faltaba cuando la lista estaba vacía', async () => {
    await expect(getOperatorAlertSettingsView()).resolves.toMatchObject({ operatorSource: 'none', ceoSource: 'none' });

    vi.stubEnv('KAIRIKOS_OPERATOR_EMAILS', 'a@kairikos.com');
    await expect(getOperatorAlertSettingsView()).resolves.toMatchObject({
      operatorEmails: ['a@kairikos.com'],
      operatorSource: 'env',
    });

    mockState.settingsFindUnique.mockResolvedValue({ ...ROW, ceoEmail: null });
    await expect(getOperatorAlertSettingsView()).resolves.toMatchObject({
      operatorEmails: ['kairikos.devs@gmail.com'],
      operatorSource: 'portal',
      ceoSource: 'none',
      updatedBy: 'op@kairikos.com',
    });
  });
});

describe('normaliseAlertSettings', () => {
  it('acepta líneas, comas o punto y coma; quita espacios, duplicados y mayúsculas', () => {
    expect(
      normaliseAlertSettings({ operatorEmails: ' Kairikos.Devs@gmail.com\nops@kairikos.com; kairikos.devs@gmail.com ,', ceoEmail: ' CEO@kairikos.com ' }),
    ).toEqual({ ok: true, operatorEmails: ['kairikos.devs@gmail.com', 'ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com' });
  });

  it('el correo de escaladas es opcional', () => {
    expect(normaliseAlertSettings({ operatorEmails: 'a@kairikos.com', ceoEmail: '' })).toEqual({
      ok: true,
      operatorEmails: ['a@kairikos.com'],
      ceoEmail: null,
    });
  });

  it('señala exactamente qué direcciones están mal escritas', () => {
    expect(normaliseAlertSettings({ operatorEmails: 'kairikos.devs@gmail\nbien@kairikos.com', ceoEmail: 'ceo' })).toEqual({
      ok: false,
      error: 'invalid_email',
      invalid: ['kairikos.devs@gmail', 'ceo'],
    });
  });

  it('no deja guardar una lista vacía: la variable volvería a mandar sin que se viera', () => {
    expect(normaliseAlertSettings({ operatorEmails: ' \n ', ceoEmail: '' })).toEqual({ ok: false, error: 'no_operator_emails' });
  });

  it('como mucho 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => `op${i}@kairikos.com`).join('\n');
    expect(normaliseAlertSettings({ operatorEmails: many, ceoEmail: '' })).toEqual({ ok: false, error: 'too_many_emails' });
  });
});

describe('/api/admin/portal/settings/alerts', () => {
  it('401 sin sesión de operador, en GET y en POST', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    expect((await GET(makeRequest())).status).toBe(401);
    expect((await POST(makeRequest({ operatorEmails: 'a@kairikos.com', ceoEmail: '' }))).status).toBe(401);
    expect(mockState.settingsUpsert).not.toHaveBeenCalled();
  });

  it('400 con el detalle cuando hay una errata, sin guardar', async () => {
    const res = await POST(makeRequest({ operatorEmails: 'kairikos.devs@gmail', ceoEmail: '' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_email', invalid: ['kairikos.devs@gmail'] });
    expect(mockState.settingsUpsert).not.toHaveBeenCalled();
  });

  it('guarda la versión limpia en la fila singleton, con quién la guardó', async () => {
    mockState.settingsFindUnique.mockResolvedValue(ROW);
    const res = await POST(makeRequest({ operatorEmails: 'Kairikos.Devs@gmail.com', ceoEmail: 'kairikos.devs@gmail.com' }));
    expect(res.status).toBe(200);
    expect(mockState.settingsUpsert).toHaveBeenCalledWith({
      where: { id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID },
      create: {
        id: OPERATOR_ALERT_SETTINGS_SINGLETON_ID,
        operatorEmails: ['kairikos.devs@gmail.com'],
        ceoEmail: 'kairikos.devs@gmail.com',
        updatedBy: 'op@kairikos.com',
      },
      update: { operatorEmails: ['kairikos.devs@gmail.com'], ceoEmail: 'kairikos.devs@gmail.com', updatedBy: 'op@kairikos.com' },
    });
    expect(await res.json()).toMatchObject({ ok: true, operatorSource: 'portal' });
  });

  it('500 y log si falla la escritura', async () => {
    mockState.settingsUpsert.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest({ operatorEmails: 'a@kairikos.com', ceoEmail: '' }));
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalledWith('operator_alert_settings.save_failed', expect.any(Error), {});
  });
});

// -----------------------------------------------------------------------------
// El guardia: si alguien vuelve a leer la variable directamente, lo que se
// guarde en /admin/portal/settings/alerts dejaría de aplicarse en ese sitio,
// en silencio. Solo operator-alert-settings.ts puede tocarla.
// -----------------------------------------------------------------------------
describe('nadie lee KAIRIKOS_OPERATOR_EMAILS / KAIRIKOS_CEO_EMAIL fuera del módulo de ajustes', () => {
  const SRC = join(process.cwd(), 'src');
  const ALLOWED = new Set(['lib/operator-alert-settings.ts']);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const PATTERN = /process\.env\.KAIRIKOS_(OPERATOR_EMAILS|CEO_EMAIL)\b/;

  const readers = walk(SRC)
    .filter((file) => PATTERN.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(SRC, file).replace(/\\/g, '/'));

  it('el guardia encuentra al único lector permitido (si no, no está mirando nada)', () => {
    expect(readers).toContain('lib/operator-alert-settings.ts');
  });

  it('ningún otro archivo la lee', () => {
    expect(readers.filter((r) => !ALLOWED.has(r))).toEqual([]);
  });
});

describe('TOTP reciente (seguridad, 22/09/2026)', () => {
  it('sin TOTP reciente no deja cambiar a quién le llegan las alertas: 403 totp_step_up_required', async () => {
    stepUpState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await POST(makeRequest({ operatorEmails: 'a@kairikos.com', ceoEmail: '' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('totp_step_up_required');
  });
});
