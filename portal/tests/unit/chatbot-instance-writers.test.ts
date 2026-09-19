// =============================================================================
// Fase 4 multi-instancia — todo lo que ESCRIBE en una tabla del chatbot tiene
// que decir de qué chatbot es.
//
// Es la clase de fallo que más veces ha aparecido en este eje, y siempre en
// silencio:
//
//   - fase 2: el perfil de SEO nacía sin tenantId desde la ruta de guardado;
//   - fase 4: la cadencia de resúmenes y los cuatro upsert de hitos buscaban
//     por clientProductId en el `where` y lo omitían en el `create`. La fila
//     nacía con NULL, el siguiente upsert no la encontraba y creaba otra. En
//     el aviso de asistente abandonado eso rompía la deduplicación y
//     reenviaba el correo al cliente en cada reintento de n8n.
//
// Y aunque no duplique, una fila escrita con la contratación a NULL
// desaparece en cuanto la pantalla filtra por instancia: el documento de
// conocimiento que el cliente acaba de subir deja de verse, sin error.
//
// Qué comprueba: en cada `create` / `createMany` sobre estas tablas, el
// argumento menciona clientProductId; en cada `upsert`, lo menciona su bloque
// `create:` — que es donde faltaba, porque el `where` sí lo llevaba.
//
// Trinquete, como el de rutas: los escritores que aún no se han convertido
// están congelados en PENDING y cada uno sale al convertirse. Un escritor
// nuevo que se olvide la contratación hace fallar el test.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');

/** Accesores de Prisma de las tablas que ganaron clientProductId en la fase 4
 *  (y la de Telegram, que lo ganó en la 1 y aquí pasó a ser su unicidad). */
const MODELS = [
  'chatbotConfigStep',
  'chatbotActivity',
  'chatbotKnowledgeDocument',
  'chatbotKnowledgeChunk',
  'chatWebEmbed',
  'conversationDigest',
  'conversationDigestSchedule',
  'telegramConnection',
  // La conversación ganó la columna en la fase 1 como ancla de las rutas
  // internas; desde la fase 4 el motor de respuesta la rellena al crearla.
  'chatbotConversation',
];

/** Escritores sin convertir todavía. `archivo#modelo.método`. */
const PENDING = new Set<string>([
  'lib/wizard-client.ts#chatbotConfigStep.create',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Texto entre el delimitador de apertura en `start` y su pareja. */
function balanced(code: string, start: number, open: string, close: string): string {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === open) depth += 1;
    else if (code[i] === close) {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return code.slice(start);
}

interface Writer {
  id: string;
  ok: boolean;
}

function findWriters(): Writer[] {
  const re = new RegExp(`\\.(${MODELS.join('|')})\\.(create|createMany|upsert)\\(`, 'g');
  const out: Writer[] = [];
  for (const file of walk(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(SRC, file).replace(/\\/g, '/');
    for (const m of code.matchAll(re)) {
      const argStart = (m.index ?? 0) + m[0].length - 1;
      const arg = balanced(code, argStart, '(', ')');
      let scope = arg;
      if (m[2] === 'upsert') {
        const at = arg.indexOf('create:');
        scope = at === -1 ? '' : balanced(arg, arg.indexOf('{', at), '{', '}');
      }
      out.push({ id: `${rel}#${m[1]}.${m[2]}`, ok: scope.includes('clientProductId') });
    }
  }
  return out;
}

const writers = findWriters();

describe('los escritores de tablas del chatbot dicen de qué chatbot es la fila', () => {
  it('el guardia encuentra escritores (si no, no está mirando nada)', () => {
    expect(writers.length).toBeGreaterThan(8);
    expect(writers.map((w) => w.id)).toContain('lib/onboarding-actions.ts#chatbotActivity.upsert');
  });

  it('ningún escritor fuera de pendientes omite clientProductId', () => {
    const missing = writers.filter((w) => !w.ok && !PENDING.has(w.id)).map((w) => w.id);
    expect(missing).toEqual([]);
  });

  it('la lista de pendientes no se queda obsoleta', () => {
    // Un pendiente que ya escribe la contratación, o que ya no existe, hace
    // creer que queda trabajo que no queda.
    const stillMissing = new Set(writers.filter((w) => !w.ok).map((w) => w.id));
    expect([...PENDING].filter((id) => !stillMissing.has(id))).toEqual([]);
  });

  it('la guarda de la guarda: detecta un upsert cuyo create no escribe la clave', () => {
    const fake = `prisma.chatbotActivity.upsert({ where: { clientProductId_milestone: { clientProductId: x, milestone } }, create: { clientId, milestone }, update: {} })`;
    const argStart = fake.indexOf('(');
    const arg = balanced(fake, argStart, '(', ')');
    const at = arg.indexOf('create:');
    const createBlock = balanced(arg, arg.indexOf('{', at), '{', '}');
    expect(arg.includes('clientProductId')).toBe(true);
    expect(createBlock.includes('clientProductId')).toBe(false);
  });
});
