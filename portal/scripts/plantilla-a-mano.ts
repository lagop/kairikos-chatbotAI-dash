// =============================================================================
// Plantillas de web escritas a mano (27/10/2026) — probarlas en local y
// subirlas a la biblioteca.
//
// Las plantillas de la biblioteca las diseña normalmente la IA desde el
// laboratorio (/admin/portal/plantillas, site-template-jobs.ts). Las de
// portal/plantillas/<carpeta>/ están escritas a mano: un archivo por pieza
// (marco.html, portada.html… las de SITE_TEMPLATE_PARTS) y plantilla.json con
// nombre, sector, variante y encargo y, si admite el color y la letra de cada
// negocio, su declaración de estilo (site-style.ts).
//
//   npx tsx scripts/plantilla-a-mano.ts comprobar plantillas/oficios-senal ../demos/plantillas
//     Valida la plantilla y la pinta con los tres contenidos de muestra (con y
//     sin su <script>) en la carpeta de salida, junto con las tipografías, la
//     foto de muestra y comprobar.html: una página que hace con ella lo mismo
//     que el laboratorio (site-template-checks.ts, mismos anchos y páginas).
//     Se abre con un servidor estático en la raíz de esa carpeta. Con
//     estilo, pinta además cada color y cada pareja de letras que el
//     laboratorio va a medir (checkPlan) y comprobar.html los mide todos.
//
//   npx tsx scripts/plantilla-a-mano.ts sql plantillas/oficios-senal ["motivo"] > plantilla.sql
//     El SQL para meterla en la biblioteca, en estado «pendiente_navegador»:
//     el laboratorio la vuelve a comprobar en el navegador del operador y,
//     si pasa, queda «lista» para que él la apruebe. Aprobarla sigue siendo
//     cosa suya. Si ya existe con ese nombre y no está aprobada ni retirada,
//     la sustituye y vuelve a comprobarse.
//
//     Si ya hay una APROBADA con ese nombre, no la toca: sube una CORRECCIÓN
//     suya («<nombre> · corrección», SiteTemplate.correccionDe) con el motivo
//     que se le dé. Se comprueba igual y el operador ve qué cambia antes de
//     aplicarla (29/10/2026; antes había que subirla con otro nombre). Una
//     corrección que aún no se ha aplicado se sustituye, no se duplica.
//
// site-template.ts arrastra seo-article-html.ts, que importa 'server-only'
// (fuera de Next no existe): se resuelve al módulo vacío de Next antes de
// cargar las libs.
// =============================================================================

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import type { SiteTemplatePart, SiteTemplateSource } from '../src/lib/site-template';
import type { SiteContentSampleName } from '../src/lib/site-content-samples';
import type { SiteContent } from '../src/lib/site-content';

const PORTAL = resolve(__dirname, '..');

const mod = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = mod._resolveFilename;
mod._resolveFilename = (request, ...rest) =>
  request === 'server-only' ? join(PORTAL, 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'empty.js') : resolveFilename(request, ...rest);

// require y no import: tiene que cargar DESPUÉS del parche de arriba.
const { renderSiteFiles, SITE_TEMPLATE_PARTS } = require('../src/lib/site-template') as typeof import('../src/lib/site-template');
const { validateSiteTemplate } = require('../src/lib/site-template-validate') as typeof import('../src/lib/site-template-validate');
const { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } = require('../src/lib/site-content-samples') as typeof import('../src/lib/site-content-samples');
const { parseTemplateStyle } = require('../src/lib/site-style') as typeof import('../src/lib/site-style');
const { checkPlan } = require('../src/lib/site-template-checks') as typeof import('../src/lib/site-template-checks');

interface Meta {
  nombre: string;
  sector: string;
  variante: string | null;
  encargo: string;
  estilo?: unknown;
}

function load(dir: string): { meta: Meta; template: SiteTemplateSource; slug: string } {
  const abs = resolve(dir);
  const meta = JSON.parse(readFileSync(join(abs, 'plantilla.json'), 'utf8')) as Meta;
  const read = (name: string) => (existsSync(join(abs, `${name}.html`)) ? readFileSync(join(abs, `${name}.html`), 'utf8').replace(/\r\n/g, '\n').trim() : '');
  const secciones: Partial<Record<SiteTemplatePart, string>> = {};
  for (const part of SITE_TEMPLATE_PARTS) {
    const body = read(part);
    if (body) secciones[part] = body;
  }
  return { meta, template: { marco: read('marco'), secciones, estilo: (meta.estilo ?? null) as SiteTemplateSource['estilo'] }, slug: abs.split(/[\\/]/).pop() as string };
}

function validate(template: SiteTemplateSource): SiteTemplateSource {
  const v = validateSiteTemplate(template);
  if (v.removedAttributes.length) console.error(`Atributos quitados: ${v.removedAttributes.join(', ')}`);
  if (!v.ok) {
    console.error(`La plantilla no pasa el validador (${v.problems.length}):`);
    for (const p of v.problems) console.error(`- ${p}`);
  }
  return v.ok ? v.template : (process.exitCode = 1, v.template);
}

/** Lo mismo que la vista previa del laboratorio
 *  (api/admin/portal/site-templates/[id]/preview): la foto del sector en vez
 *  de assets/portada.jpg. */
function sampleContent(name: SiteContentSampleName, foto: string): SiteContent {
  return JSON.parse(JSON.stringify(SITE_CONTENT_SAMPLES[name]).replaceAll('"assets/portada.jpg"', JSON.stringify(foto))) as SiteContent;
}

/** La carpeta de una variante de estilo: 'estilo-1d4ed8-x', 'estilo-x-rotulo'. */
function variantDir(acento?: string, tipografia?: string): string {
  return `estilo-${acento ? acento.slice(1) : 'x'}-${tipografia || 'x'}`;
}

function write(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function comprobar(dir: string, out: string) {
  const { meta, template, slug } = load(dir);
  const clean = validate(template);
  const root = resolve(out);
  rmSync(join(root, slug), { recursive: true, force: true });
  // La foto de su sector, como la vista previa del laboratorio.
  const foto = `/web-draft/${meta.sector === 'beauty' ? 'beauty' : 'trades'}.jpg`;
  const ctx = { ...SAMPLE_RENDER_CONTEXT, fotos: { portada: foto, equipo: null, trabajo: null } };
  const estilo = parseTemplateStyle(clean.estilo);
  const withStyle: SiteTemplateSource = { ...clean, estilo };
  const sinJs: SiteTemplateSource = { ...withStyle, marco: clean.marco.replace(/<script\b[\s\S]*?<\/script>/gi, '') };
  for (const name of Object.keys(SITE_CONTENT_SAMPLES) as SiteContentSampleName[]) {
    for (const [variant, t] of [[name, withStyle], [`${name}-sin-js`, sinJs]] as const) {
      for (const f of renderSiteFiles(t, sampleContent(name, foto), ctx)) write(join(root, slug, variant, f.path), f.content);
    }
  }
  // Las variantes de estilo que medirá el laboratorio, con y sin script (con
  // script, para mirarlas a ojo).
  const variants = new Map(checkPlan(estilo).filter((p) => p.acento || p.tipografia).map((p) => [variantDir(p.acento, p.tipografia), p]));
  for (const [vdir, { acento, tipografia }] of variants) {
    for (const name of Object.keys(SITE_CONTENT_SAMPLES) as SiteContentSampleName[]) {
      const content = { ...sampleContent(name, foto), estilo: { acento: acento ?? '', tipografia: tipografia ?? '' } };
      for (const [variant, t] of [[name, withStyle], [`${name}-sin-js`, sinJs]] as const) {
        for (const f of renderSiteFiles(t, content, ctx)) write(join(root, slug, vdir, variant, f.path), f.content);
      }
    }
  }
  write(join(root, slug, 'estilo.json'), JSON.stringify(estilo));
  // Lo que la vista previa sirve desde el portal.
  cpSync(join(PORTAL, 'public', 'fuentes'), join(root, 'fuentes'), { recursive: true });
  cpSync(join(PORTAL, 'public', 'google-maps'), join(root, 'google-maps'), { recursive: true });
  for (const f of ['trades.jpg', 'beauty.jpg']) write(join(root, 'web-draft', f), readFileSync(join(PORTAL, 'public', 'web-draft', f)));
  buildSync({
    entryPoints: [join(PORTAL, 'src', 'lib', 'site-template-checks.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'Comprobaciones',
    outfile: join(root, 'comprobaciones.js'),
    logLevel: 'error',
  });
  write(join(root, 'comprobar.html'), HARNESS);
  console.log(`Pintada en ${join(root, slug)}. Comprobar: /comprobar.html?plantilla=${slug}`);
}

/** El bucle del laboratorio (SiteTemplateLab.tsx, measure) sin el portal. */
const HARNESS = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Comprobando…</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px}pre{white-space:pre-wrap}</style></head>
<body><h1>Comprobaciones</h1><p id="estado">…</p><pre id="resultado"></pre>
<script src="comprobaciones.js"></script>
<script>
(async function () {
  var C = Comprobaciones;
  var slug = new URLSearchParams(location.search).get("plantilla");
  var estilo = await (await fetch("/" + slug + "/estilo.json")).json();
  var plan = C.checkPlan(estilo);
  var runs = [];
  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    document.getElementById("estado").textContent = (i + 1) + " / " + plan.length;
    var iframe = document.createElement("iframe");
    Object.assign(iframe.style, { position: "fixed", left: "-20000px", top: "0", width: p.ancho + "px", height: "900px", border: "0" });
    var vdir = p.acento || p.tipografia ? "estilo-" + (p.acento ? p.acento.slice(1) : "x") + "-" + (p.tipografia || "x") + "/" : "";
    iframe.src = "/" + slug + "/" + vdir + p.contenido + "-sin-js/" + (p.pagina ? p.pagina + "/" : "") + "index.html";
    document.body.appendChild(iframe);
    await new Promise(function (r) { iframe.onload = r; });
    await (iframe.contentDocument.fonts ? iframe.contentDocument.fonts.ready : null);
    await new Promise(function (r) { setTimeout(r, 300); });
    runs.push(Object.assign({}, p, { problemas: C.runSiteChecks(iframe.contentDocument, iframe.contentWindow) }));
    iframe.remove();
  }
  var resumen = C.summarizeCheckRuns(runs, 60);
  window.__resultado = { runs: runs, resumen: resumen };
  document.title = resumen.length ? resumen.length + " problemas" : "Sin problemas";
  document.getElementById("estado").textContent = document.title + " en " + runs.length + " pasadas";
  document.getElementById("resultado").textContent = resumen.join("\\n\\n");
})();
</script></body></html>
`;

function sql(dir: string, motivo?: string) {
  const { meta, template } = load(dir);
  const clean = validate(template);
  if (process.exitCode) return;
  const now = new Date().toISOString();
  const validacion = {
    encargo: meta.encargo,
    modelo: null,
    rondas: 0,
    costeUsd: 0,
    problemas: [],
    historial: [
      {
        fase: 'generacion',
        at: now,
        detalle: 'Escrita a mano (Claude Code), sin coste de API. Comprobada en local con site-template-checks.ts antes de subirla.',
      },
    ],
  };
  // Si resulta ser una corrección, su «encargo» es el porqué del cambio: es
  // lo que queda en el historial de la plantilla al aplicarla.
  const fixValidacion = { ...validacion, encargo: motivo?.trim() || 'Corrección escrita a mano' };
  const estilo = clean.estilo != null ? JSON.stringify(clean.estilo) : null;
  const all = JSON.stringify([meta, clean, validacion, fixValidacion]);
  let tag = 'plantilla';
  while (all.includes(`$${tag}$`)) tag += '_';
  const q = (s: string) => `$${tag}$${s}$${tag}$`;
  const nombre = q(meta.nombre);
  const secciones = `${q(JSON.stringify(clean.secciones))}::jsonb`;
  const estiloSql = estilo ? `${q(estilo)}::jsonb` : 'NULL';
  const variante = meta.variante ? q(meta.variante) : 'NULL';
  const open = `('pendiente_navegador', 'corrigiendo', 'lista', 'fallida')`;
  console.log(`BEGIN;
CREATE TEMP TABLE _aprobada ON COMMIT DROP AS
  SELECT id FROM "SiteTemplate" WHERE nombre = ${nombre} AND estado = 'aprobada' AND correccion_de IS NULL LIMIT 1;
-- Hay una aprobada con ese nombre: se sube (o se sustituye) su corrección abierta.
UPDATE "SiteTemplate" t SET marco = ${q(clean.marco)}, secciones = ${secciones}, estilo = ${estiloSql}, variante = ${variante},
  estado = 'pendiente_navegador', validacion = ${q(JSON.stringify(fixValidacion))}::jsonb, updated_at = now()
  FROM _aprobada a WHERE t.correccion_de = a.id AND t.estado IN ${open};
INSERT INTO "SiteTemplate" (nombre, sector, variante, origen, modelo, marco, secciones, estilo, estado, validacion, correccion_de, updated_at)
  SELECT ${nombre} || ' · corrección', ${q(meta.sector)}, ${variante}, 'manual', NULL, ${q(clean.marco)}, ${secciones}, ${estiloSql},
    'pendiente_navegador', ${q(JSON.stringify(fixValidacion))}::jsonb, a.id, now()
  FROM _aprobada a WHERE NOT EXISTS (SELECT 1 FROM "SiteTemplate" t WHERE t.correccion_de = a.id AND t.estado IN ${open});
-- No la hay: lo de siempre (se sustituye mientras no esté aprobada ni retirada).
UPDATE "SiteTemplate" SET marco = ${q(clean.marco)}, secciones = ${secciones}, estilo = ${estiloSql}, sector = ${q(meta.sector)}, variante = ${variante},
  estado = 'pendiente_navegador', validacion = ${q(JSON.stringify(validacion))}::jsonb, updated_at = now()
  WHERE nombre = ${nombre} AND origen = 'manual' AND correccion_de IS NULL AND estado NOT IN ('aprobada', 'retirada')
    AND NOT EXISTS (SELECT 1 FROM _aprobada);
INSERT INTO "SiteTemplate" (nombre, sector, variante, origen, modelo, marco, secciones, estilo, estado, validacion, updated_at)
  SELECT ${nombre}, ${q(meta.sector)}, ${variante}, 'manual', NULL, ${q(clean.marco)}, ${secciones}, ${estiloSql},
    'pendiente_navegador', ${q(JSON.stringify(validacion))}::jsonb, now()
  WHERE NOT EXISTS (SELECT 1 FROM "SiteTemplate" WHERE nombre = ${nombre});
SELECT id, nombre, estado FROM "SiteTemplate"
  WHERE (nombre = ${nombre} AND correccion_de IS NULL) OR (correccion_de IN (SELECT id FROM _aprobada) AND estado IN ${open});
COMMIT;`);
}

const [cmd, dir, out] = process.argv.slice(2);
if (cmd === 'comprobar' && dir && out) comprobar(dir, out);
else if (cmd === 'sql' && dir) sql(dir, out);
else {
  console.error('Uso: plantilla-a-mano.ts comprobar <carpeta> <salida> | sql <carpeta> ["motivo, si corrige una aprobada"]');
  process.exitCode = 2;
}
