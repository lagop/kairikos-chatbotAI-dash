// =============================================================================
// De quién salen los correos. El fallo real: `OPERATOR_NOTIFY_FROM ?? …`
// —docker-compose declara la variable aunque el .env la tenga vacía, el
// `??` solo salta cuando NO existe, y cada envío iba con remitente en
// blanco. Resend lo rechaza con "The domain is invalid", que hace pensar
// en el DNS del dominio y no tiene nada que ver.
// Ver src/lib/email-sender.ts.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { notifyFromAddress, authFromAddress } from '@/lib/email-sender';

afterEach(() => {
  delete process.env.OPERATOR_NOTIFY_FROM;
  delete process.env.AUTH_EMAIL_FROM;
});

describe('notifyFromAddress', () => {
  it('usa OPERATOR_NOTIFY_FROM cuando tiene valor', () => {
    process.env.OPERATOR_NOTIFY_FROM = 'Avisos <avisos@kairikos.com>';
    process.env.AUTH_EMAIL_FROM = 'Portal <contacto@kairikos.com>';
    expect(notifyFromAddress()).toBe('Avisos <avisos@kairikos.com>');
  });

  // El caso de producción, el 22/09/2026.
  it('trata una variable VACÍA como si no existiera', () => {
    process.env.OPERATOR_NOTIFY_FROM = '';
    process.env.AUTH_EMAIL_FROM = 'Portal <contacto@kairikos.com>';
    expect(notifyFromAddress()).toBe('Portal <contacto@kairikos.com>');
  });

  it('trata una variable con solo espacios como si no existiera', () => {
    process.env.OPERATOR_NOTIFY_FROM = '   ';
    process.env.AUTH_EMAIL_FROM = 'Portal <contacto@kairikos.com>';
    expect(notifyFromAddress()).toBe('Portal <contacto@kairikos.com>');
  });

  it('cae en el literal cuando las dos están vacías, nunca en cadena vacía', () => {
    process.env.OPERATOR_NOTIFY_FROM = '';
    process.env.AUTH_EMAIL_FROM = '';
    expect(notifyFromAddress()).toBe('Kairikos Ops <ops@kairikos.com>');
  });

  it('nunca devuelve algo sin arroba: un remitente en blanco es un envío perdido', () => {
    process.env.OPERATOR_NOTIFY_FROM = '';
    expect(notifyFromAddress()).toContain('@');
  });

  it('quita los espacios de alrededor', () => {
    process.env.OPERATOR_NOTIFY_FROM = '  Avisos <avisos@kairikos.com>  ';
    expect(notifyFromAddress()).toBe('Avisos <avisos@kairikos.com>');
  });
});

describe('authFromAddress', () => {
  it('usa AUTH_EMAIL_FROM cuando tiene valor', () => {
    process.env.AUTH_EMAIL_FROM = 'Portal <contacto@kairikos.com>';
    expect(authFromAddress()).toBe('Portal <contacto@kairikos.com>');
  });

  it('con la variable vacía cae en el literal, no en cadena vacía', () => {
    process.env.AUTH_EMAIL_FROM = '';
    expect(authFromAddress()).toBe('Kairikos Portal <hola@kairikos.com>');
  });
});
