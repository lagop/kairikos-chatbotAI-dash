// Empaqueta src/embed/presupuestador.tsx en public/embed/presupuestador.js
// (10/11/2026): el presupuestador de Web Premium para insertarlo en kairikos.com.
//
// Va en `npm run build`, así que la imagen de Docker lo lleva siempre al día; el
// resultado no se commitea (public/embed/ está en .gitignore). En local:
//   node scripts/build-embed.mjs
//
// Dos pasadas porque el CSS tiene que ir DENTRO del JS: el componente se pinta
// en un Shadow DOM, y una hoja aparte tardaría en llegar y se vería sin estilos
// un momento. La primera pasada solo saca el CSS (el de PremiumQuoter.module.css,
// con sus clases ya renombradas); la segunda lo mete como texto en el script.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'embed', 'presupuestador.js');

const common = {
  absWorkingDir: root,
  entryPoints: ['src/embed/presupuestador.tsx'],
  bundle: true,
  format: 'iife',
  // Las rutas @/… salen de tsconfig.json, que esbuild ya lee.
  jsx: 'automatic',
  loader: { '.module.css': 'local-css' },
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  outdir: 'embed-tmp',
  write: false,
};

const first = await build({ ...common, define: { 'process.env.NODE_ENV': '"production"', __QUOTER_CSS__: '""' } });
const css = first.outputFiles.find((f) => f.path.endsWith('.css'))?.text;
if (!css) throw new Error('build-embed: el presupuestador se ha quedado sin CSS');

const second = await build({ ...common, define: { 'process.env.NODE_ENV': '"production"', __QUOTER_CSS__: JSON.stringify(css) } });
const js = second.outputFiles.find((f) => f.path.endsWith('.js'))?.text;
if (!js) throw new Error('build-embed: esbuild no ha devuelto el script');

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, js);
console.log(`build-embed: ${path.relative(root, out)} (${Math.round(js.length / 1024)} KB)`);
