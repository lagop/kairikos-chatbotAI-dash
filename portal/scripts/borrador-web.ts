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
// Pasar un borrador antiguo (solo textos) al diseño de la biblioteca, con su
// mismo texto y sin regenerarlo:
//   propuesta <leadId> [plantilla] un script de node que se pasa al contenedor
//                                  de la APLICACIÓN, no a psql:
//       … | ssh root@VPS 'docker exec -i kairikos-portal-app node -' > propuesta.json
//                                  Sin plantilla, la elige su sector, como al
//                                  generar. No guarda nada.
//   convertir <leído> <propuesta> <nota>
//                                  junta los dos archivos, valida y guarda
//                                  como `guardar` (historial: «convertido»)
//
// El archivo de `leer` lleva una huella: si el borrador cambia antes de
// guardar (otro retoque, una regeneración), `guardar` se niega. Se vuelve a
// leer y se rehace el cambio.
//
// Ver src/lib/web-draft-edit.ts para el porqué de todo esto.
// =============================================================================

import { readFileSync } from 'node:fs';
import {
  designProposalScript,
  draftHistorySql,
  draftReadSql,
  draftRestoreSql,
  draftSaveSql,
  draftSearchSql,
  isUuid,
  mergeDesignProposal,
  parseDraftEdit,
  type DraftEditFile,
  type DraftEditResult,
} from '../src/lib/web-draft-edit';

const ACTOR = 'system:claude-code';

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

function valid(parsed: DraftEditResult) {
  if (!parsed.ok) {
    console.error(`No vale, nada se ha guardado:\n- ${parsed.errors.join('\n- ')}`);
    process.exit(1);
  }
  return parsed.edit;
}

const load = (file: string) => valid(parseDraftEdit(readJson(file)));

function describe(edit: DraftEditFile): string {
  const secciones = edit.content?.paginas.flatMap((p) => p.secciones).length ?? 0;
  return edit.content
    ? `${edit.content.paginas.length} página(s), ${secciones} secciones, ${edit.content.ejemplos.length} dato(s) de ejemplo`
    : 'diseño antiguo (solo textos)';
}

function needNota(nota: string | undefined): string {
  if (!nota?.trim()) {
    console.error('Falta la nota: qué se cambia y por qué (queda en el historial).');
    process.exit(2);
  }
  return nota.trim();
}

function needUuid(id: string | undefined, what: string): string {
  if (!id || !isUuid(id)) {
    console.error(`${what}: falta o no es un uuid`);
    process.exit(2);
  }
  return id;
}

const [cmd, a, b, c] = process.argv.slice(2);
switch (cmd) {
  case 'buscar':
    if (!a) process.exit(2);
    console.log(draftSearchSql(a));
    break;
  case 'leer':
    console.log(draftReadSql(needUuid(a, 'leadId')));
    break;
  case 'comprobar':
    console.error(`Vale: ${describe(load(a))}.`);
    break;
  case 'guardar':
    console.log(draftSaveSql(load(a), needNota(b), ACTOR));
    break;
  case 'propuesta':
    console.log(designProposalScript(needUuid(a, 'leadId'), b ? needUuid(b, 'plantilla') : null));
    break;
  case 'convertir': {
    const nota = needNota(c);
    const merged = mergeDesignProposal(readJson(a), readJson(b));
    const edit = valid(merged);
    // Sin la ampliación con IA el contenido sale solo con titular, servicios
    // y cierre: se pinta, pero pobre. Se avisa en vez de callarlo.
    console.error(`Vale: ${describe(edit)}${merged.ok && merged.expanded === false ? ' · OJO: sin ampliar con IA (falló o no hay clave)' : ''}.`);
    console.log(draftSaveSql(edit, nota, ACTOR, 'convertido'));
    break;
  }
  case 'historial':
    console.log(draftHistorySql(needUuid(a, 'leadId')));
    break;
  case 'restaurar':
    console.log(draftRestoreSql(needUuid(a, 'leadId'), b ? needUuid(b, 'versión') : null, ACTOR));
    break;
  default:
    console.error(
      'Uso: borrador-web.ts buscar <texto> | leer <leadId> | comprobar <archivo> | guardar <archivo> <nota> | historial <leadId> | restaurar <leadId> [versión] | propuesta <leadId> [plantilla] | convertir <leído> <propuesta> <nota>',
    );
    process.exitCode = 2;
}
