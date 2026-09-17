// =============================================================================
// Fase 0 — tests del libro mayor de mensajes.
//
// Dos bloques con propósitos distintos:
//
//   1. El comportamiento de recordSend, incluida la parte que más importa
//      y que es fácil romper sin darse cuenta: NO LANZA NUNCA.
//   2. Un guardia de COBERTURA que lee el código fuente. La contabilidad
//      de un producto no falla porque el código esté mal, falla porque
//      alguien añade un sitio nuevo desde el que se manda un mensaje y no
//      se acuerda de apuntarlo. Eso no lo detecta ningún test normal: el
//      envío nuevo funciona perfectamente y la fila simplemente no
//      existe. Por eso este test enumera los sitios conocidos y se pone
//      rojo cuando aparece uno que no está en la lista.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { recordSend, metaMessageId } from '@/lib/message-ledger';

const state = { create: vi.fn() };
const prisma = {
  outboundMessage: { create: (...a: unknown[]) => state.create(...a) },
} as unknown as PrismaClient;

const BASE = {
  clientId: 'client_1',
  productCode: 'recall',
  channel: 'whatsapp' as const,
  kind: 'template' as const,
  toE164: '+34651234567',
  ok: true,
};

beforeEach(() => {
  state.create.mockReset().mockResolvedValue({ id: 'om_1' });
  mockState.logError.mockReset();
});

describe('recordSend', () => {
  it('escribe la fila con lo que se le pasa, normalizando los opcionales a null', async () => {
    await recordSend(prisma, BASE);
    expect(state.create.mock.calls[0][0].data).toMatchObject({
      clientId: 'client_1',
      tenantId: null,
      category: null,
      templateName: null,
      providerMessageId: null,
      error: null,
      callEventId: null,
      ok: true,
    });
  });

  it('acota el error a 500 caracteres — esta columna no es un log, y un proveedor puede devolver un cuerpo entero', async () => {
    await recordSend(prisma, { ...BASE, ok: false, error: 'x'.repeat(2000) });
    expect(state.create.mock.calls[0][0].data.error).toHaveLength(500);
  });

  // LA PROPIEDAD QUE NO SE PUEDE PERDER. Cuando esto se llama, el mensaje
  // ya salió: propagar el error haría que el barrido lo reintentara y la
  // persona recibiría el mismo mensaje dos veces por un fallo de nuestra
  // contabilidad.
  it('NUNCA lanza, aunque la escritura falle — y deja constancia en el log', async () => {
    state.create.mockRejectedValue(new Error('postgres caído'));
    await expect(recordSend(prisma, BASE)).resolves.toBeUndefined();
    expect(mockState.logError).toHaveBeenCalledWith(
      'message_ledger.record_failed',
      expect.any(Error),
      expect.objectContaining({ clientId: 'client_1' }),
      'warn',
    );
  });
});

describe('metaMessageId', () => {
  it('saca el id que hace falta para casar la fila con la factura', () => {
    expect(metaMessageId({ messages: [{ id: 'wamid.ABC' }] })).toBe('wamid.ABC');
  });

  it('devuelve null en vez de reventar cuando Meta no manda lo esperado', () => {
    expect(metaMessageId(undefined)).toBeNull();
    expect(metaMessageId({})).toBeNull();
    expect(metaMessageId({ messages: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El guardia de cobertura
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Ruta relativa a src/, siempre con '/', para que la lista de abajo se lea
 *  igual en Windows que en el CI. */
const rel = (file: string) => relative(SRC, file).split(sep).join('/');

/**
 * Cada sitio del que sale un mensaje de pago, y si está apuntado o no.
 *
 * `ledger: false` NO es un descuido: es el estado declarado. Recall es lo
 * único que factura hoy y es lo que se ha conectado. Cuando prospecting
 * empiece a mandar de verdad —y manda MARKETING, que es la categoría
 * cara— hay que ponerlo a true y conectarlo, no borrar la línea.
 */
const KNOWN_SENDERS: Record<string, { ledger: boolean; why?: string }> = {
  'lib/recall-messaging.ts': { ledger: true },
  // Fase 3 — las campañas de recuperación. Este guardia las cazó al
  // añadirlas, que es literalmente para lo que se escribió.
  'lib/recovery-campaigns.ts': { ledger: true },
  'lib/recall-reports.ts': { ledger: false, why: 'un mensaje al mes por cliente' },
  'lib/recall-reviews.ts': { ledger: false, why: 'pendiente, mismo patrón' },
  // 2026-09-17 — se reenvían al guardar el WhatsApp y al reconectar: ya no
  // es "una vez por alta", así que se apuntan.
  'lib/recall-templates.ts': { ledger: true },
  'lib/recall-callbacks.ts': { ledger: false, why: 'acuse dentro de la ventana de 24h' },
  'lib/prospecting-contact.ts': { ledger: false, why: 'MARKETING — conectar antes de vender el producto' },
  'lib/review-request-campaign.ts': { ledger: false, why: 'pendiente, mismo patrón' },
  'app/api/internal/channels/whatsapp/send/route.ts': { ledger: false, why: 'lo pide n8n, sin contexto de producto' },
};

describe('cobertura del libro mayor', () => {
  /**
   * Qué cuenta como "sitio que manda un mensaje de pago".
   *
   * sendTemplate y sendSms son inequívocos. sendMessage NO lo es: lo
   * exportan también telegram-api, messenger-api e instagram-api, y esos
   * son otro producto con otro modelo de coste. Así que el mensaje libre
   * solo cuenta cuando el fichero importa sendMessage DE whatsapp-api.
   *
   * Y cuenta, aunque hoy el mensaje libre dentro de la ventana de 24h sea
   * gratis: el cambio de tarificación que motivó todo esto es
   * precisamente que deje de serlo.
   */
  function isSender(source: string): boolean {
    if (/\bsendTemplate\(|\bsendSms\(/.test(source)) return true;
    const importsWhatsappSendMessage =
      /import\s*\{[^}]*\bsendMessage\b[^}]*\}\s*from\s*['"](?:@\/lib\/whatsapp-api|\.\/whatsapp-api)['"]/s.test(
        source,
      );
    return importsWhatsappSendMessage && /\bsendMessage\(/.test(source);
  }

  const senders = sourceFiles(SRC)
    .filter((f) => {
      const r = rel(f);
      // Los propios envoltorios del proveedor no cuentan: son el
      // transporte, no un sitio que decida mandar algo.
      if (r === 'lib/whatsapp-api.ts' || r.startsWith('lib/telephony/')) return false;
      return isSender(readFileSync(f, 'utf8'));
    })
    .map(rel)
    .sort();

  // El guardia del guardia. Sin esto, el día que alguien renombre
  // sendTemplate el escáner encontraría cero ficheros y los dos tests de
  // abajo pasarían en verde sin comprobar absolutamente nada — que es
  // peor que no tenerlos, porque además dan confianza.
  it('el escáner encuentra los sitios de envío que sabemos que existen', () => {
    expect(senders.length).toBeGreaterThanOrEqual(7);
    expect(senders).toContain('lib/recall-messaging.ts');
  });

  it('no hay ningún sitio de envío que no esté declarado en KNOWN_SENDERS', () => {
    const undeclared = senders.filter((s) => !(s in KNOWN_SENDERS));
    expect(
      undeclared,
      `Sitios de envío nuevos y sin declarar:\n  ${undeclared.join('\n  ')}\n\n` +
        'Si este envío cuesta dinero, llama a recordSend() junto al envío y añádelo ' +
        'con ledger: true. Si no, añádelo con ledger: false y el motivo. Lo que no ' +
        'vale es dejarlo fuera: un envío sin apuntar no se puede reconstruir después.',
    ).toEqual([]);
  });

  it('los sitios declarados como apuntados llaman de verdad a recordSend', () => {
    for (const [file, meta] of Object.entries(KNOWN_SENDERS)) {
      if (!meta.ledger) continue;
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source, `${file} dice llevar libro mayor pero no llama a recordSend`).toMatch(
        /recordSend\(/,
      );
    }
  });

  it('recall-messaging apunta sus CUATRO envíos: llamante por WhatsApp, llamante por SMS, recado al dueño y recordatorio de devolución', () => {
    const source = readFileSync(join(SRC, 'lib/recall-messaging.ts'), 'utf8');
    expect(source.match(/recordSend\(/g) ?? []).toHaveLength(4);
  });
});
