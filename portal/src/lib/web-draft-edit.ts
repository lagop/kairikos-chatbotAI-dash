import { z } from 'zod';
import { parseSiteContent, type SiteContent } from './site-content';
import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// Retocar a mano el borrador de web de un prospecto (28/10/2026).
//
// Para qué: Orlando ve un borrador y quiere un cambio SOLO en ese («quítale
// la sección de precios», «este titular, mejor así»). Regenerarlo no sirve
// —sale otro texto entero, y cuesta una llamada a Sonnet— y tocar la fila a
// mano con SQL no valida nada: un contenido que no pase parseSiteContent no
// rompe la página, la hace caer EN SILENCIO al diseño antiguo
// (renderDesignedDraft devuelve null), y nadie se entera hasta que el
// prospecto abre el enlace.
//
// Cómo: scripts/borrador-web.ts. Este módulo es lo puro de esa herramienta
// —validar el archivo editado y escribir el SQL— y no ve la base de datos,
// porque el Postgres de producción no se publica fuera de la red de Docker
// de la VPS (CLAUDE.md, trampa 3): el SQL se pasa a psql del contenedor por
// SSH, igual que scripts/plantilla-a-mano.ts.
//
// Tres garantías:
//   * Valida antes de escribir, con el mismo esquema con el que se pinta.
//   * Guarda la versión anterior (ProspectingWebDraftVersion) y permite
//     deshacer o volver a cualquiera.
//   * La «huella» (md5 de copy + content tal como se leyeron) hace que el
//     guardado se niegue si el borrador cambió entretanto: una regeneración o
//     un retoque desde otra lectura no se pisan a ciegas.
//
// Sin 'server-only': lo importa un script de tsx y se prueba sin red.
// =============================================================================

/** Los topes de los textos del borrador. Los usa también el parseo de la
 *  respuesta del modelo (web-draft-ai.ts): un retoque a mano no puede dejar un
 *  texto que la generación no habría dejado. */
export const WEB_DRAFT_COPY_LIMITS = {
  headline: 90,
  paragraph: 400,
  services: 6,
  serviceName: 60,
  serviceText: 180,
} as const;

const L = WEB_DRAFT_COPY_LIMITS;

const copySchema = z
  .object({
    headline: z.string().trim().min(1).max(L.headline),
    subheadline: z.string().trim().max(L.paragraph),
    about: z.string().trim().max(L.paragraph),
    services: z
      .array(z.object({ name: z.string().trim().min(1).max(L.serviceName), description: z.string().trim().max(L.serviceText) }).strict())
      .max(L.services),
    callToAction: z.string().trim().max(L.headline),
    // Las citas apuntan a una reseña por referencia y posición, nunca por
    // texto (web-draft-reviews.ts). Se pueden quitar o reordenar; escribir
    // una a mano no tiene sentido, y si la huella no casa, el render la
    // descarta.
    highlights: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(60),
            reviewRef: z.string().min(1).max(200),
            start: z.number().int().min(0),
            length: z.number().int().min(1),
            hash: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Las familias de web-draft-html.ts, con o sin variante (VARIANTS_PER_THEME). */
const THEME_KEY_RE = /^(beauty|trades|health|food|professional)(-[1-8])?$/;

export const isUuid = (s: string) => UUID_RE.test(s);

/** Lo que se descarga de producción (`leer`) y se vuelve a subir (`guardar`). */
export interface DraftEditFile {
  leadId: string;
  /** md5 de copy y content al leerlo. No se edita. */
  huella: string;
  /** Solo para orientarse al editar; no se guarda. */
  negocio?: string | null;
  copy: WebDraftCopy;
  /** Null: el borrador sale con el diseño antiguo, solo desde `copy`. */
  content: SiteContent | null;
  /** La plantilla con la que se pinta `content`. Las dos o ninguna. */
  templateId: string | null;
  themeKey: string;
}

export type DraftEditResult = { ok: true; edit: DraftEditFile } | { ok: false; errors: string[] };

/** Valida un archivo editado. Devuelve los valores ya normalizados (lo que
 *  devuelve el parser, no lo que se escribió), que es lo que se guarda. */
export function parseDraftEdit(input: unknown): DraftEditResult {
  const errors: string[] = [];
  const raw = (input ?? {}) as Record<string, unknown>;
  const leadId = typeof raw.leadId === 'string' ? raw.leadId : '';
  const huella = typeof raw.huella === 'string' ? raw.huella : '';
  const themeKey = typeof raw.themeKey === 'string' ? raw.themeKey : '';
  const templateId = raw.templateId == null ? null : typeof raw.templateId === 'string' ? raw.templateId : '';
  if (!isUuid(leadId)) errors.push('leadId: no es un uuid');
  if (!/^[0-9a-f]{32}$/.test(huella)) errors.push('huella: falta o no es la que dio «leer»');
  if (!THEME_KEY_RE.test(themeKey)) errors.push(`themeKey: «${themeKey}» no es una familia conocida`);
  if (templateId !== null && !isUuid(templateId)) errors.push('templateId: no es un uuid');

  const copy = copySchema.safeParse(raw.copy);
  if (!copy.success) for (const i of copy.error.issues) errors.push(`${['copy', ...i.path].join('.')}: ${i.message}`);

  let content: SiteContent | null = null;
  if (raw.content != null) {
    const parsed = parseSiteContent(raw.content);
    if (parsed.ok) content = parsed.content;
    else for (const i of parsed.issues) errors.push(`${i.path ? `content.${i.path}` : 'content'}: ${i.message}`);
  }
  // Un contenido sin plantilla no se pinta, y una plantilla sin contenido
  // tampoco: el borrador caería al diseño antiguo sin avisar.
  if ((raw.content != null) !== (templateId !== null)) errors.push('content y templateId van juntos: los dos o ninguno');

  if (errors.length > 0 || !copy.success) return { ok: false, errors };
  return { ok: true, edit: { leadId, huella, negocio: null, copy: copy.data, content, templateId, themeKey } };
}

// --- SQL --------------------------------------------------------------------

/** Literal con dólar que no puede cerrarse desde dentro del texto. */
function quoter(...texts: string[]) {
  const all = texts.join('');
  let tag = 'b';
  while (all.includes(`$${tag}$`)) tag += '_';
  return (s: string) => `$${tag}$${s}$${tag}$`;
}

/** La huella de un borrador, en SQL sobre el alias `d`. La comparten esta
 *  herramienta y el editor del operador (web-draft-editor.ts): así ninguno de
 *  los dos pisa a ciegas lo que guardó el otro. */
export const DRAFT_HUELLA_SQL = `md5(coalesce(d.copy::text, '') || '|' || coalesce(d.content::text, ''))`;
const HUELLA = DRAFT_HUELLA_SQL;

function assertUuid(...ids: (string | null)[]) {
  for (const id of ids) if (id !== null && !isUuid(id)) throw new Error(`no es un uuid: ${id}`);
}

/** Borradores cuyo negocio contiene el texto (o el lead con ese id). */
export function draftSearchSql(text: string): string {
  const q = quoter(text);
  return `SELECT d.lead_id, l.contact_name, d.theme_key, coalesce(t.nombre, '(diseño antiguo)'), to_char(d.generated_at, 'YYYY-MM-DD HH24:MI'), d.share_token
  FROM "ProspectingWebDraft" d JOIN "Lead" l ON l.id = d.lead_id LEFT JOIN "SiteTemplate" t ON t.id = d.template_id
  WHERE l.contact_name ILIKE '%' || ${q(text)} || '%' OR d.lead_id::text = ${q(text)}
  ORDER BY d.generated_at DESC LIMIT 20;`;
}

/** Una línea de JSON con el archivo para editar (DraftEditFile). */
export function draftReadSql(leadId: string): string {
  assertUuid(leadId);
  return `SELECT json_build_object('leadId', d.lead_id, 'huella', ${HUELLA}, 'negocio', l.contact_name,
  'copy', d.copy, 'content', d.content, 'templateId', d.template_id, 'themeKey', d.theme_key)
  FROM "ProspectingWebDraft" d JOIN "Lead" l ON l.id = d.lead_id WHERE d.lead_id = '${leadId}';`;
}

/** Bloquea la fila y aborta si ya no está como se leyó. */
function guard(leadId: string, huella: string) {
  return `DO $guard$ BEGIN
  PERFORM 1 FROM "ProspectingWebDraft" d WHERE d.lead_id = '${leadId}' AND ${HUELLA} = '${huella}' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El borrador ha cambiado desde que se leyó (o no existe): vuelve a leerlo.'; END IF;
END $guard$;`;
}

/** La fila tal como está ahora pasa al historial, con el porqué. `notaSql`
 *  es ya una expresión SQL (un literal citado o un cálculo). */
function snapshot(leadId: string, accion: string, notaSql: string, actorId: string, q: (s: string) => string) {
  return `INSERT INTO "ProspectingWebDraftVersion" (draft_id, accion, nota, actor_id, copy, content, template_id, theme_key)
  SELECT d.id, ${q(accion)}, ${notaSql}, ${q(actorId)}, d.copy, d.content, d.template_id, d.theme_key
  FROM "ProspectingWebDraft" d WHERE d.lead_id = '${leadId}';`;
}

/** Cómo llega cada versión al historial desde la herramienta: un retoque de
 *  textos o el paso al diseño de la biblioteca (`convertir`). «regenerado»
 *  y «restaurado» los escriben la ruta del portal y draftRestoreSql. */
export type DraftSaveAccion = 'retoque' | 'convertido';

export function draftSaveSql(edit: DraftEditFile, nota: string, actorId: string, accion: DraftSaveAccion = 'retoque'): string {
  assertUuid(edit.leadId, edit.templateId);
  if (!/^[0-9a-f]{32}$/.test(edit.huella)) throw new Error('huella inválida');
  const copy = JSON.stringify(edit.copy);
  const content = edit.content ? JSON.stringify(edit.content) : null;
  const q = quoter(copy, content ?? '', nota, actorId, edit.themeKey);
  // Solo plantillas aprobadas: el prospecto no puede ver un diseño que el
  // laboratorio no ha medido ni Orlando ha aprobado.
  const templateCheck = edit.templateId
    ? `DO $tpl$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SiteTemplate" WHERE id = '${edit.templateId}' AND estado = 'aprobada') THEN
    RAISE EXCEPTION 'La plantilla % no existe o no está aprobada.', '${edit.templateId}'; END IF;
END $tpl$;\n`
    : '';
  return `BEGIN;
${guard(edit.leadId, edit.huella)}
${templateCheck}${snapshot(edit.leadId, accion, q(nota), actorId, q)}
UPDATE "ProspectingWebDraft" SET copy = ${q(copy)}::jsonb, content = ${content ? `${q(content)}::jsonb` : 'NULL'},
  template_id = ${edit.templateId ? `'${edit.templateId}'` : 'NULL'}, theme_key = ${q(edit.themeKey)}
  WHERE lead_id = '${edit.leadId}';
SELECT 'guardado', ${HUELLA} FROM "ProspectingWebDraft" d WHERE d.lead_id = '${edit.leadId}';
COMMIT;`;
}

export function draftHistorySql(leadId: string): string {
  assertUuid(leadId);
  return `SELECT v.id, to_char(v.created_at, 'YYYY-MM-DD HH24:MI'), v.accion, v.actor_id, coalesce(v.nota, ''), v.copy->>'headline'
  FROM "ProspectingWebDraftVersion" v JOIN "ProspectingWebDraft" d ON d.id = v.draft_id
  WHERE d.lead_id = '${leadId}' ORDER BY v.created_at DESC;`;
}

/**
 * Vuelve a una versión guardada (la última si no se dice cuál). Lo actual pasa
 * antes al historial, así que restaurar también se puede deshacer.
 */
export function draftRestoreSql(leadId: string, versionId: string | null, actorId: string): string {
  assertUuid(leadId, versionId);
  const q = quoter(actorId);
  const pick = versionId
    ? `v.id = '${versionId}'`
    : `v.id = (SELECT v2.id FROM "ProspectingWebDraftVersion" v2 WHERE v2.draft_id = d.id ORDER BY v2.created_at DESC LIMIT 1)`;
  return `BEGIN;
CREATE TEMP TABLE _elegida ON COMMIT DROP AS
  SELECT v.* FROM "ProspectingWebDraftVersion" v JOIN "ProspectingWebDraft" d ON d.id = v.draft_id
  WHERE d.lead_id = '${leadId}' AND ${pick};
DO $chk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM _elegida) THEN RAISE EXCEPTION 'No hay esa versión para este borrador.'; END IF;
END $chk$;
${snapshot(leadId, 'restaurado', `'antes de volver a la versión ' || (SELECT id::text FROM _elegida)`, actorId, q)}
UPDATE "ProspectingWebDraft" d SET copy = e.copy, content = e.content, template_id = e.template_id, theme_key = e.theme_key
  FROM _elegida e WHERE d.lead_id = '${leadId}';
SELECT 'restaurado', e.id, e.copy->>'headline' FROM _elegida e;
COMMIT;`;
}

// --- Convertir al diseño de la biblioteca -------------------------------------

/**
 * El script para `docker exec -i <app> node -`: pide al portal, desde dentro
 * del contenedor, la propuesta de diseño para un borrador
 * (/api/internal/prospecting/web-drafts/[leadId]/design). La clave interna
 * sale del entorno del propio contenedor y no viaja ni se imprime.
 */
export function designProposalScript(leadId: string, templateId: string | null): string {
  assertUuid(leadId, templateId);
  const body = JSON.stringify(templateId ? { templateId } : {});
  return `fetch('http://localhost:3000/api/internal/prospecting/web-drafts/${leadId}/design', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-kairikos-internal-key': process.env.PORTAL_API_KEY || '' },
  body: ${JSON.stringify(body)},
}).then(async (r) => {
  const t = await r.text();
  if (!r.ok) { console.error('HTTP ' + r.status + ': ' + t); process.exit(1); }
  console.log(t);
}, (e) => { console.error(String(e)); process.exit(1); });`;
}

/**
 * El archivo de `leer` con el diseño propuesto: el texto (copy) y la familia
 * se quedan como estaban, contenido y plantilla son los de la propuesta. Se
 * valida igual que un retoque, así que una propuesta que no se pintaría no
 * llega a guardarse.
 */
export function mergeDesignProposal(read: unknown, proposal: unknown): DraftEditResult & { expanded?: boolean } {
  const p = (proposal ?? {}) as Record<string, unknown>;
  if (typeof p.templateId !== 'string' || p.content == null) {
    return { ok: false, errors: ['propuesta: no trae templateId y content (¿es la salida de «propuesta»?)'] };
  }
  const merged = parseDraftEdit({ ...(read as Record<string, unknown>), content: p.content, templateId: p.templateId });
  return merged.ok ? { ...merged, expanded: p.expanded === true } : merged;
}
