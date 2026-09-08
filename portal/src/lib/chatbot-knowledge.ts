import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// Fase 3 — base de conocimiento del chatbot: troceado, ingesta y
// recuperación.
//
// Hasta aquí el bot solo sabía lo que cupiera en el paso 4 del wizard: una
// lista de FAQ escritas a mano. Eso responde bien a las diez preguntas que
// el dueño se acordó de anticipar y se queda mudo en la undécima. Esto es
// lo que separa un bot de guion de un asistente.
//
// **La recuperación es de Postgres, no de la aplicación.** `search_vector`
// es una columna generada (`to_tsvector('spanish', content)`) con índice
// GIN, y la consulta va por $queryRaw porque puntuar por relevancia
// (ts_rank) no se puede expresar con la API de Prisma. Se descartaron dos
// alternativas:
//
//   • Embeddings + pgvector: mejor recuperación, pero exige una extensión
//     que este Postgres no tiene y un proveedor de embeddings que no está
//     cableado. Un coste de infraestructura nuevo para un producto que
//     todavía no ha salido a producción.
//   • Puntuar en TypeScript cargando todos los fragmentos del cliente:
//     serían cientos de KB movidos en CADA turno de conversación, y el
//     castellano necesita lematización que habría que reimplementar a mano.
//
// La búsqueda de texto completo de Postgres es peor que los embeddings
// para preguntas parafraseadas y **eso es una limitación conocida**: si un
// cliente pregunta "¿puedo llevar a mi perro?" y el documento dice
// "admitimos mascotas", esta implementación no lo encuentra. A cambio no
// añade infraestructura, no cuesta por consulta, y es explicable. Cuando
// haya volumen real que lo justifique, el sitio donde cambiarlo es
// `retrieveKnowledge` y solo él.
// =============================================================================

/** Techo por cliente. No es una palanca comercial: es lo que impide que un
 *  cliente pegue su web entera y el índice deje de caber en memoria. */
export const MAX_DOCUMENTS_PER_CLIENT = 25;
/** Un documento más largo que esto se recorta al ingerirlo. Son ~50 folios:
 *  de sobra para el material de una pyme y suficiente para que un pegado
 *  accidental no llene la tabla. */
export const MAX_DOCUMENT_CHARS = 120_000;
/** Objetivo de tamaño de fragmento. Un párrafo suelto suele quedarse corto
 *  para dar contexto y una página entera diluye lo relevante; ~800
 *  caracteres es un par de párrafos, que es como se lee una respuesta. */
export const CHUNK_TARGET_CHARS = 800;
export const CHUNK_MAX_CHARS = 1_200;
/** Fragmentos que viajan al prompt. Más no mejora la respuesta y sí gasta
 *  contexto: con 4 ya se cubre el caso de que la respuesta esté repartida
 *  entre dos apartados. */
export const MAX_RETRIEVED_CHUNKS = 4;

export const KNOWLEDGE_SOURCES = ['manual', 'web'] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

// ---------------------------------------------------------------------------
// Troceado — puro, sin base de datos
// ---------------------------------------------------------------------------

/**
 * Parte un texto en fragmentos indexables.
 *
 * Corta por PÁRRAFOS, no por número de caracteres: partir una frase por la
 * mitad produce un fragmento que, recuperado solo, no significa nada — y
 * recuperar fragmentos sueltos es exactamente lo que hace esto. Un párrafo
 * que por sí solo pasa de CHUNK_MAX_CHARS sí se parte, por frases, porque
 * la alternativa es un fragmento que se come el prompt entero.
 *
 * Pura y exportada para poder fijar en tests los casos que de verdad se
 * dan: el documento de una sola línea, el párrafo gigante, el texto lleno
 * de saltos de línea de un copiar-pegar.
 */
export function chunkText(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length === 0) return [];

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    current = '';
  };

  for (const paragraph of paragraphs) {
    for (const piece of splitLongParagraph(paragraph)) {
      if (current.length === 0) {
        current = piece;
      } else if (current.length + piece.length + 2 <= CHUNK_TARGET_CHARS) {
        current = `${current}\n\n${piece}`;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();

  return chunks;
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_MAX_CHARS) return [paragraph];

  // Por frases. El punto seguido de espacio es el corte natural del
  // castellano; si ni así baja del máximo (una lista sin puntuación, un
  // volcado de tabla), se corta en seco antes que devolver un fragmento
  // que no cabe en el prompt.
  const sentences = paragraph.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [paragraph];
  const pieces: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const next = current + sentence;
    if (next.length <= CHUNK_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current.trim().length > 0) pieces.push(current.trim());
    current = '';
    for (let i = 0; i < sentence.length; i += CHUNK_MAX_CHARS) {
      const slice = sentence.slice(i, i + CHUNK_MAX_CHARS);
      if (slice.length === CHUNK_MAX_CHARS) pieces.push(slice.trim());
      else current = slice;
    }
  }
  if (current.trim().length > 0) pieces.push(current.trim());

  return pieces.filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Ingesta
// ---------------------------------------------------------------------------

export interface IngestKnowledgeInput {
  clientId: string;
  tenantId: string | null;
  source: KnowledgeSource;
  title: string;
  content: string;
  sourceUrl?: string | null;
  /** Documento existente a reemplazar (un recrawl). Si no, se crea uno. */
  documentId?: string;
  actorId: string;
  now?: Date;
}

export type IngestKnowledgeResult =
  | { ok: true; documentId: string; chunks: number; charCount: number }
  | { ok: false; error: 'empty_content' | 'document_limit_reached' };

/**
 * Guarda (o reemplaza) un documento y sus fragmentos en una transacción.
 *
 * Reemplazar es borrar y volver a crear los fragmentos, no reconciliarlos:
 * un recrawl de una web que cambió puede haber movido todo de sitio, y un
 * diff fragmento a fragmento sería complejidad para un caso —el documento
 * pequeño que cambia poco— que aquí no aporta nada.
 */
export async function ingestKnowledgeDocument(
  prisma: PrismaClient,
  input: IngestKnowledgeInput,
): Promise<IngestKnowledgeResult> {
  const now = input.now ?? new Date();
  const content = input.content.slice(0, MAX_DOCUMENT_CHARS);
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return { ok: false, error: 'empty_content' };
  }

  if (!input.documentId) {
    const existing = await prisma.chatbotKnowledgeDocument.count({ where: { clientId: input.clientId } });
    if (existing >= MAX_DOCUMENTS_PER_CLIENT) {
      return { ok: false, error: 'document_limit_reached' };
    }
  }

  const charCount = content.length;

  const documentId = await prisma.$transaction(async (tx) => {
    const doc = input.documentId
      ? await tx.chatbotKnowledgeDocument.update({
          where: { id: input.documentId },
          data: {
            title: input.title,
            status: 'ready',
            error: null,
            charCount,
            crawledAt: input.source === 'web' ? now : null,
          },
          select: { id: true },
        })
      : await tx.chatbotKnowledgeDocument.create({
          data: {
            clientId: input.clientId,
            tenantId: input.tenantId,
            source: input.source,
            title: input.title,
            sourceUrl: input.sourceUrl ?? null,
            status: 'ready',
            charCount,
            crawledAt: input.source === 'web' ? now : null,
          },
          select: { id: true },
        });

    if (input.documentId) {
      await tx.chatbotKnowledgeChunk.deleteMany({ where: { documentId: doc.id } });
    }

    await tx.chatbotKnowledgeChunk.createMany({
      data: chunks.map((content, ordinal) => ({
        documentId: doc.id,
        clientId: input.clientId,
        ordinal,
        content,
      })),
    });

    await tx.chatbotKnowledgeDocumentAudit.create({
      data: {
        documentId: doc.id,
        clientId: input.clientId,
        tenantId: input.tenantId,
        action: input.documentId ? 'recrawled' : 'created',
        // Metadatos, nunca el contenido: la auditoría no es una segunda
        // copia del documento.
        after: { source: input.source, title: input.title, chunks: chunks.length, charCount },
        actorId: input.actorId,
      },
    });

    return doc.id;
  });

  return { ok: true, documentId, chunks: chunks.length, charCount };
}

// ---------------------------------------------------------------------------
// Recuperación
// ---------------------------------------------------------------------------

export interface KnowledgeSnippet {
  documentTitle: string;
  content: string;
}

interface RawSnippetRow {
  content: string;
  title: string;
}

/**
 * Los fragmentos más relevantes para un mensaje, del propio cliente.
 *
 * **Nunca lanza.** La llama el orquestador en el camino caliente de un
 * turno de conversación: quedarse sin base de conocimiento degrada la
 * respuesta, pero un error aquí no puede dejar al cliente sin contestación.
 * Devuelve `[]` y lo registra.
 *
 * `websearch_to_tsquery` y no `plainto_tsquery` porque acepta sin reventar
 * la puntuación, las comillas y los signos de interrogación que trae un
 * mensaje real de chat — que es exactamente el material que le llega.
 *
 * **Los términos se unen con OR, no con AND, y ese es el detalle del que
 * depende que esto funcione.** `websearch_to_tsquery` genera una consulta
 * en AND: `'¿cómo hago una cancelación?'` se convierte en
 * `'com' & 'hag' & 'cancel'`, y como el diccionario español de Postgres no
 * considera vacías a "cómo" ni "hago", exige que las tres aparezcan en el
 * MISMO fragmento. Comprobado contra el Postgres real: con AND, esa
 * pregunta no encontraba el documento de cancelaciones aunque estuviera
 * indexado, y la base de conocimiento no habría devuelto nada nunca —
 * en silencio, porque no encontrar nada solo degrada el bot a las FAQ,
 * que es como estaba antes.
 *
 * Reescribir `&` por `|` sobre el texto YA normalizado de la tsquery es
 * seguro: la entrada del usuario pasa por websearch_to_tsquery
 * parametrizado, y lo único que se toca después es el operador. El `!`
 * (negación, de escribir `-palabra`) se quita en vez de convertirse: en OR
 * un término negado casaría con casi todo, y en un mensaje de chat
 * "-color" casi nunca significa una negación de búsqueda.
 *
 * Limitación conocida y aceptada: con OR, un mensaje cuyo único término
 * coincidente sea genérico puede traer un fragmento que no viene a cuento.
 * `ts_rank` lo deja por debajo de cualquier coincidencia mejor, el límite
 * son cuatro fragmentos, y el prompt le dice al modelo que ignore lo que no
 * responda a la pregunta.
 */
export async function retrieveKnowledge(
  prisma: PrismaClient,
  clientId: string,
  query: string,
  limit: number = MAX_RETRIEVED_CHUNKS,
): Promise<KnowledgeSnippet[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  try {
    const rows = await prisma.$queryRaw<RawSnippetRow[]>(Prisma.sql`
      WITH q AS (
        SELECT replace(replace(websearch_to_tsquery('spanish', ${trimmed})::text, '&', '|'), '!', '')::tsquery AS tsq
      )
      SELECT c."content", d."title"
        FROM "ChatbotKnowledgeChunk" c
        JOIN "ChatbotKnowledgeDocument" d ON d."id" = c."document_id"
        CROSS JOIN q
       WHERE c."client_id" = ${clientId}
         AND d."status" = 'ready'
         AND c."search_vector" @@ q.tsq
       ORDER BY ts_rank(c."search_vector", q.tsq) DESC
       LIMIT ${limit}
    `);
    return rows.map((row) => ({ documentTitle: row.title, content: row.content }));
  } catch (err) {
    logError('chatbot_knowledge.retrieve_failed', err, { clientId }, 'warn');
    return [];
  }
}
