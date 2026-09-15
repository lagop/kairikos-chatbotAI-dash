// =============================================================================
// Fase 5b — tests del asistente.
//
// Casi todo el peso está en UNA propiedad: que el modelo no pueda decidir
// de quién son los datos. El resto de este fichero son bugs; eso sería
// una brecha entre clientes, que es la categoría de fallo que el propio
// documento pone en su tabla de riesgos.
//
// Se prueba de tres formas distintas a propósito, porque una sola no
// cubre las tres maneras de romperlo:
//
//   1. Que toda consulta filtre por el clientId que se le inyecta.
//   2. Que una etiqueta inventada por el modelo no ejecute nada.
//   3. Que no exista ninguna otra puerta a los datos — comprobado
//      leyendo el código, porque una puerta nueva no la detecta ningún
//      test de comportamiento: funcionaría perfectamente.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  QUERY_CATALOGUE,
  INTENT_DESCRIPTIONS,
  isKnownIntent,
  runIntent,
  type AssistantIntent,
} from '@/lib/assistant-catalogue';
import { parseClassifierResponse } from '@/lib/assistant-ai';

const NOW = new Date('2026-09-15T12:00:00Z');

/** Un prisma que registra TODOS los `where` que recibe, para poder
 *  comprobar que ninguno se olvida del clientId. */
function spyPrisma() {
  const wheres: Array<Record<string, unknown>> = [];
  const capture = (result: unknown) => (args?: { where?: Record<string, unknown> }) => {
    if (args?.where) wheres.push(args.where);
    return Promise.resolve(result);
  };
  const model = () => ({
    findMany: capture([]),
    findFirst: capture(null),
    count: capture(0),
  });
  return {
    wheres,
    client: {
      serviceQuote: model(),
      callEvent: model(),
      job: model(),
      contact: model(),
      recoveryCampaign: model(),
    } as unknown as PrismaClient,
  };
}

const ALL_INTENTS = Object.keys(QUERY_CATALOGUE) as AssistantIntent[];

describe('el aislamiento por cliente', () => {
  // EL TEST QUE IMPORTA. Recorre TODAS las consultas del catálogo, así
  // que una nueva que se olvide del clientId se pone roja sola sin que
  // nadie tenga que acordarse de añadirle su test.
  it.each(ALL_INTENTS)('«%s» filtra SIEMPRE por el clientId inyectado', async (intent) => {
    const { wheres, client } = spyPrisma();

    await runIntent(intent, {
      prisma: client,
      clientId: 'client_1',
      now: NOW,
      subject: 'García',
    });

    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) {
      expect(where.clientId, `una consulta de ${intent} no filtra por cliente`).toBe('client_1');
    }
  });

  it('el «subject» que aporta el modelo BUSCA, nunca amplía el alcance', async () => {
    const { wheres, client } = spyPrisma();

    await runIntent('contact_history', {
      prisma: client,
      clientId: 'client_1',
      now: NOW,
      // Lo peor que podría devolver el modelo: algo con pinta de id ajeno.
      subject: 'client_2',
    });

    // Sigue filtrando por el cliente de la sesión; el subject solo entra
    // en el OR de búsqueda por nombre/teléfono.
    for (const where of wheres) {
      expect(where.clientId).toBe('client_1');
    }
  });
});

describe('el catálogo es cerrado', () => {
  it('reconoce solo las intenciones implementadas', () => {
    for (const intent of ALL_INTENTS) expect(isKnownIntent(intent)).toBe(true);
  });

  it.each([
    'drop_table',
    'pending_quotes_all_clients',
    'PENDING_QUOTES',
    '',
    'revenue_attributed',
  ])('rechaza «%s»', (value) => {
    expect(isKnownIntent(value)).toBe(false);
  });

  it('rechaza cualquier cosa que no sea una cadena', () => {
    for (const value of [null, undefined, 42, {}, ['pending_quotes']]) {
      expect(isKnownIntent(value)).toBe(false);
    }
  });

  // Las descripciones son lo que se le enseña al modelo. Si se describe
  // una intención que no existe, el modelo la devolverá y el usuario verá
  // "no puedo con eso" ante algo que se le acaba de ofrecer.
  it('lo que se le describe al modelo coincide EXACTAMENTE con lo implementado', () => {
    expect(Object.keys(INTENT_DESCRIPTIONS).sort()).toEqual(ALL_INTENTS.sort());
  });
});

describe('parseClassifierResponse', () => {
  it('acepta una clasificación válida', () => {
    expect(parseClassifierResponse('{"intent":"pending_quotes","subject":null}')).toEqual({
      intent: 'pending_quotes',
      subject: null,
    });
  });

  it('sobrevive a la valla de markdown que Haiku pone igualmente', () => {
    const parsed = parseClassifierResponse('```json\n{"intent":"daily_brief","subject":null}\n```');
    expect(parsed?.intent).toBe('daily_brief');
  });

  // LA ÚLTIMA BARRERA. No se fía de que el modelo respete el enunciado:
  // una etiqueta que no esté en el catálogo se trata como "no entendida",
  // no como algo que ejecutar.
  it('descarta una intención que el modelo se haya inventado', () => {
    expect(parseClassifierResponse('{"intent":"borrar_todo","subject":null}')).toBeNull();
    expect(parseClassifierResponse('{"intent":null,"subject":null}')).toBeNull();
  });

  it('descarta una respuesta que no es JSON', () => {
    expect(parseClassifierResponse('Claro, tienes 7 presupuestos abiertos')).toBeNull();
    expect(parseClassifierResponse('')).toBeNull();
  });

  it('recorta el subject y trata el vacío como ausente', () => {
    expect(parseClassifierResponse('{"intent":"contact_history","subject":"   "}')?.subject).toBeNull();
    const long = parseClassifierResponse(`{"intent":"contact_history","subject":"${'x'.repeat(400)}"}`);
    expect(long?.subject?.length).toBe(120);
  });
});

describe('el resultado que se devuelve', () => {
  it('sin datos devuelve un componente vacío, no una lista de cero elementos', async () => {
    const { client } = spyPrisma();
    const result = await runIntent('pending_quotes', {
      prisma: client,
      clientId: 'client_1',
      now: NOW,
    });
    expect(result.component.kind).toBe('empty');
    expect(result.facts.total).toBe(0);
  });

  it('los hechos van YA CONTADOS por el portal, para que el modelo no sume', async () => {
    const { client } = spyPrisma();
    const result = await runIntent('daily_brief', { prisma: client, clientId: 'client_1', now: NOW });
    // Un número mal sumado dentro de una frase bien escrita es
    // indistinguible de uno correcto, y aquí son euros del cliente.
    for (const value of Object.values(result.facts)) {
      expect(typeof value === 'number' || typeof value === 'string').toBe(true);
    }
    expect(result.component.kind).toBe('metric');
  });

  it('contact_history sin nombre no busca nada en vez de devolver el primero que encuentre', async () => {
    const { wheres, client } = spyPrisma();
    const result = await runIntent('contact_history', {
      prisma: client,
      clientId: 'client_1',
      now: NOW,
      subject: null,
    });
    expect(result.component.kind).toBe('empty');
    expect(wheres).toHaveLength(0);
  });
});

// El guardia estructural: que no aparezca una segunda puerta a los datos.
describe('la superficie del asistente', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('la parte de IA NO importa prisma: el modelo no tiene forma de llegar a los datos', () => {
    const ai = strip(src('src/lib/assistant-ai.ts'));
    // El guardia del guardia.
    expect(ai).toMatch(/classifyQuestion/);
    // Lo que se vigila.
    expect(ai).not.toMatch(/from ['"]@?\/?.*prisma['"]|prisma\./);
  });

  it('runIntent es la única salida del catálogo que ejecuta una consulta', () => {
    const cat = strip(src('src/lib/assistant-catalogue.ts'));
    expect(cat).toMatch(/export async function runIntent/);
    // Ninguna función exportada acepta un clientId suelto por parámetro:
    // el contexto se construye entero en la ruta, desde la sesión.
    expect(cat).not.toMatch(/export .*\(.*clientId: string.*\)/);
  });

  it('la ruta toma el clientId de la sesión y NO del cuerpo de la petición', () => {
    const route = strip(src('src/app/api/portal/assistant/route.ts'));
    expect(route).toMatch(/clientId: resolved\.clientId/);
    // Si esto apareciera, el aislamiento entero se caería.
    expect(route).not.toMatch(/clientId: body\.|body\.data\.clientId/);
  });
});
