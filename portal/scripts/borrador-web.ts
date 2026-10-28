// =============================================================================
// Retocar a mano el borrador de web de UN prospecto (28/10/2026).
//
// Escribe SQL y no habla con la base de datos: el Postgres de producción solo
// se alcanza desde dentro de la VPS. Cada orden se pasa a psql del contenedor:
//
//   npx tsx scripts/borrador-web.ts <orden> … \
//     | ssh root@VPS 'docker exec -i kairikos-portal-postgres sh -c \
//         "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -q -At"'
//
// Órdenes:
//   buscar <texto>                 borradores cuyo negocio lo contiene
//   leer <leadId>                  una línea de JSON: guárdala en un archivo
//   comprobar <archivo>            valida el archivo editado, sin SQL
//   guardar <archivo> <nota>       valida y guarda; lo anterior va al historial
//   historial <leadId>             las versiones guardadas, la última arriba
//   restaurar <leadId> [versión]   vuelve a una versión (sin versión: deshace
//                                  el último cambio)
//
// El archivo de `leer` lleva una huella: si el borrador cambia antes de
// guardar (otro retoque, una regeneración), `guardar` se niega. Se vuelve a
// leer y se rehace el cambio.
//
// Ver src/lib/web-draft-edit.ts para el porqué de todo esto.
// =============================================================================

import { readFileSync } from 'node:fs';
import {
  draftHistorySql,
  draftReadSql,
  draftRestoreSql,
  draftSaveSql,
  draftSearchSql,
  isUuid,
  parseDraftEdit,
} from '../src/lib/web-draft-edit';

const ACTOR = 'system:claude-code';

function load(file: string) {
  const parsed = parseDraftEdit(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
  if (!parsed.ok) {
    console.error(`No vale, nada se ha guardado:\n- ${parsed.errors.join('\n- ')}`);
    process.exit(1);
  }
  return parsed.edit;
}

function needUuid(id: string | undefined, what: string): string {
  if (!id || !isUuid(id)) {
    console.error(`${what}: falta o no es un uuid`);
    process.exit(2);
  }
  return id;
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case 'buscar':
    if (!a) process.exit(2);
    console.log(draftSearchSql(a));
    break;
  case 'leer':
    console.log(draftReadSql(needUuid(a, 'leadId')));
    break;
  case 'comprobar': {
    const edit = load(a);
    const secciones = edit.content?.paginas.flatMap((p) => p.secciones).length ?? 0;
    console.error(`Vale: ${edit.content ? `${edit.content.paginas.length} página(s), ${secciones} secciones, ${edit.content.ejemplos.length} dato(s) de ejemplo` : 'diseño antiguo (solo textos)'}.`);
    break;
  }
  case 'guardar':
    if (!b?.trim()) {
      console.error('Falta la nota: qué se cambia y por qué (queda en el historial).');
      process.exit(2);
    }
    console.log(draftSaveSql(load(a), b.trim(), ACTOR));
    break;
  case 'historial':
    console.log(draftHistorySql(needUuid(a, 'leadId')));
    break;
  case 'restaurar':
    console.log(draftRestoreSql(needUuid(a, 'leadId'), b ? needUuid(b, 'versión') : null, ACTOR));
    break;
  default:
    console.error('Uso: borrador-web.ts buscar <texto> | leer <leadId> | comprobar <archivo> | guardar <archivo> <nota> | historial <leadId> | restaurar <leadId> [versión]');
    process.exitCode = 2;
}
