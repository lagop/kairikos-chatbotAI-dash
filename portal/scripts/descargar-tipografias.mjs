#!/usr/bin/env node
// =============================================================================
// Webs con IA (27/10/2026) — descarga UNA VEZ las tipografías del catálogo y
// las deja en public/fuentes/, para que las webs las sirvan ellas mismas.
//
// Por qué: cargar Google Fonts desde la web del cliente hace que el navegador
// de cada visitante le dé su IP a Google, y eso había que declararlo en la
// política de privacidad (hay sentencias alemanas que lo han sancionado). Con
// los archivos en la propia web, el visitante no habla con nadie más.
//
// Uso (desde portal/):   node scripts/descargar-tipografias.mjs
// Genera public/fuentes/<familia>/{fuentes.css,*.woff2} y
// src/lib/site-fonts-catalog.ts. Las dos cosas se commitean: en producción no
// se descarga nada. Para añadir una familia, añádela a CATALOGO y vuelve a
// ejecutarlo.
//
// - Solo los subconjuntos latin y latin-ext: el resto (cirílico, vietnamita…)
//   no lo va a pedir nunca una web de un negocio de aquí. El navegador solo
//   descarga el que usa cada página (unicode-range).
// - Variables con todo su rango de pesos (un archivo sirve 100..900); de las
//   estáticas, todos los pesos que publica Google. Solo el eje wght: los demás
//   (opsz, SOFT…) multiplican el tamaño y la plantilla no los necesita.
// - Licencias: todas son OFL o Apache 2.0, que permiten servirlas desde
//   cualquier web. Ver public/fuentes/README.md.
// =============================================================================
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** El catálogo. `uso` es lo que se le dice a la IA: display para titulares,
 *  texto para el cuerpo (ver site-template-ai.ts). */
const CATALOGO = [
  ['Fraunces', 'display'],
  ['Playfair Display', 'display'],
  ['Lora', 'display'],
  ['Libre Baskerville', 'display'],
  ['Bitter', 'display'],
  ['DM Serif Display', 'display'],
  ['Cormorant Garamond', 'display'],
  ['Young Serif', 'display'],
  ['Instrument Serif', 'display'],
  ['Bricolage Grotesque', 'display'],
  ['Space Grotesk', 'display'],
  ['Syne', 'display'],
  ['Oswald', 'display'],
  ['Bebas Neue', 'display'],
  ['Barlow Condensed', 'display'],
  ['Josefin Sans', 'display'],
  ['Inter', 'texto'],
  ['Source Sans 3', 'texto'],
  ['Manrope', 'texto'],
  ['DM Sans', 'texto'],
  ['Work Sans', 'texto'],
  ['Nunito Sans', 'texto'],
  ['Figtree', 'texto'],
  ['Plus Jakarta Sans', 'texto'],
  ['Outfit', 'texto'],
  ['Rubik', 'texto'],
  ['Barlow', 'texto'],
];

const SUBSETS = new Set(['latin', 'latin-ext']);
// Con un navegador actual, Google devuelve woff2 partido por unicode-range.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outDir = path.join(root, 'public', 'fuentes');

const slugOf = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function metadata() {
  const res = await fetch('https://fonts.google.com/metadata/fonts');
  const text = await res.text();
  const json = JSON.parse(text.replace(/^\)\]\}'/, ''));
  return new Map(json.familyMetadataList.map((f) => [f.family, f]));
}

/** El parámetro family= de css2 que pide todo lo que tiene la familia. */
function familySpec(meta) {
  const keys = Object.keys(meta.fonts);
  const italics = keys.some((k) => k.endsWith('i'));
  const wght = meta.axes?.find((a) => a.tag === 'wght');
  const name = meta.family.replace(/ /g, '+');
  if (wght) {
    const range = `${wght.min}..${wght.max}`;
    return italics ? `${name}:ital,wght@0,${range};1,${range}` : `${name}:wght@${range}`;
  }
  const tuples = keys
    .map((k) => [k.endsWith('i') ? 1 : 0, Number.parseInt(k, 10)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return italics
    ? `${name}:ital,wght@${tuples.map(([i, w]) => `${i},${w}`).join(';')}`
    : `${name}:wght@${tuples.map(([, w]) => w).join(';')}`;
}

async function download(family, meta) {
  const slug = slugOf(family);
  const url = `https://fonts.googleapis.com/css2?family=${familySpec(meta)}&display=swap`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${family}: ${res.status} ${url}`);
  const css = await res.text();
  const dir = path.join(outDir, slug);
  await mkdir(dir, { recursive: true });

  const blocks = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
  const faces = [];
  const files = [];
  const seen = new Map();
  for (const [, subset, body] of blocks) {
    if (!SUBSETS.has(subset)) continue;
    const style = /font-style:\s*(\w+)/.exec(body)[1];
    const weight = /font-weight:\s*([\d ]+);/.exec(body)[1].trim();
    const src = /url\((https:[^)]+\.woff2)\)/.exec(body)[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)[1].trim();
    let file = seen.get(src);
    if (!file) {
      file = `${slug}-${style}-${weight.replace(' ', '-')}-${subset}.woff2`;
      const bin = Buffer.from(await (await fetch(src)).arrayBuffer());
      await writeFile(path.join(dir, file), bin);
      seen.set(src, file);
      files.push(file);
    }
    faces.push(
      `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(${file}) format('woff2');unicode-range:${range}}`,
    );
  }
  if (!faces.length) throw new Error(`${family}: Google no devolvió latin`);
  // Rutas relativas al propio CSS: así vale igual en el portal
  // (/fuentes/inter/fuentes.css) que dentro de la web publicada.
  await writeFile(path.join(dir, 'fuentes.css'), `/* ${family} — ${meta.license ?? 'OFL'} — servida desde la propia web */\n${faces.join('\n')}\n`);
  return { slug, files };
}

const all = await metadata();
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = [];
let bytes = 0;
for (const [family, uso] of CATALOGO) {
  const meta = all.get(family);
  if (!meta) throw new Error(`${family} no está en Google Fonts`);
  const { slug, files } = await download(family, meta);
  entries.push({ family, slug, uso, categoria: meta.category, files });
  console.log(`${family}: ${files.length} archivos`);
}
for (const e of entries) for (const f of e.files) bytes += (await import('node:fs')).statSync(path.join(outDir, e.slug, f)).size;

await writeFile(
  path.join(outDir, 'README.md'),
  `# Tipografías servidas desde la propia web

Generado por \`scripts/descargar-tipografias.mjs\`; no se edita a mano.

Son familias de Google Fonts, todas con licencia SIL Open Font License 1.1 o
Apache 2.0, que permiten usarlas, incrustarlas y servirlas desde cualquier web.
Se sirven desde aquí (y desde cada web publicada, que lleva su copia) para que
el navegador del visitante no se conecte a Google.

${entries.map((e) => `- ${e.family} (${e.uso})`).join('\n')}
`,
);

const ts = `// Generado por scripts/descargar-tipografias.mjs — no editar a mano.
// Las familias que una plantilla puede usar y los archivos de cada una, que
// están en public/fuentes/<slug>/. Ver site-fonts.ts.

export interface SiteFont {
  slug: string;
  /** display: titulares; texto: cuerpo. Es lo que se le dice a la IA. */
  uso: 'display' | 'texto';
  categoria: string;
  files: readonly string[];
}

export const SITE_FONT_CATALOG: Readonly<Record<string, SiteFont>> = ${JSON.stringify(
  Object.fromEntries(entries.map((e) => [e.family, { slug: e.slug, uso: e.uso, categoria: e.categoria, files: e.files }])),
  null,
  2,
)};
`;
await writeFile(path.join(root, 'src', 'lib', 'site-fonts-catalog.ts'), ts);
console.log(`\n${entries.length} familias, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
