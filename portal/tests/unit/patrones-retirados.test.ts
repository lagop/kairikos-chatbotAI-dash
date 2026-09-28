// =============================================================================
// Lo que se retiró sigue retirado.
//
// El 22/09/2026 se quitó el id de relleno 'legacy' de las rutas de operador.
// El 24/09 se construyó el producto `web`, y sus cinco rutas de administración
// nacieron con DOCE apariciones nuevas del mismo patrón — copiadas de las rutas
// que la limpieza estaba borrando en paralelo. Se descubrió el 28/09, al
// fusionar aquella rama, contando apariciones a mano.
//
// El diff de la limpieza estaba impecable. El diff del producto `web` también:
// era código nuevo que seguía el estilo de sus vecinos. Ninguna revisión de un
// cambio aislado podía verlo, porque el fallo no estaba EN un cambio, estaba
// ENTRE dos.
//
// Esta valla existe para eso. No comprueba que el código sea bueno; comprueba
// que un patrón que alguien decidió retirar no vuelva por la puerta de atrás
// mientras se está retirando por la de delante.
//
// CÓMO AÑADIR UNO. Una entrada nueva en PATRONES, con:
//   · `busca`, lo más literal posible — un regex amplio caza cosas que no son;
//   · `porque`, que es lo que leerá quien haga fallar esto dentro de un año y
//     no tenga ni idea de qué pasó. Sin eso, la valla se salta en vez de
//     entenderse;
//   · `desde`, la fecha de la decisión.
//
// Y una regla: si un patrón aparece en un comentario que EXPLICA su historia,
// no cuenta. Las líneas que empiezan por //, * o /* se saltan. Contar esas
// haría que documentar una decisión rompiera la comprobación de esa decisión,
// que es el incentivo exactamente equivocado.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RAIZ = join(__dirname, '..', '..');
const CARPETAS = ['src', 'tests'];

interface Excepcion {
  /** Ruta relativa a portal/, con barras normales. */
  archivo: string;
  motivo: string;
}

interface PatronRetirado {
  nombre: string;
  /** Cuándo se decidió retirarlo. */
  desde: string;
  /** Qué buscar. Literal siempre que se pueda. */
  busca: RegExp[];
  /** Por qué se retiró. Lo lee quien rompa esto sin saber nada. */
  porque: string;
  excepciones?: Excepcion[];
}

const PATRONES: PatronRetirado[] = [
  {
    nombre: "el operatorId de relleno 'legacy'",
    desde: '2026-09-22',
    busca: [
      /operatorId === 'legacy'/,
      /isLegacyAuth/,
      /'legacy_operator'/,
      /'operator:legacy'/,
    ],
    porque:
      'Desde que se retiró la clave compartida de operador, authenticateAdminRequest ' +
      'solo devuelve operadores reales de una OperatorSession. El id de relleno no ' +
      'puede llegar, así que toda comparación contra él es una rama muerta en una ' +
      'ruta de administración — el peor sitio para tener código que nadie ejecuta. ' +
      'Pasa auth.operatorId tal cual.',
  },
  {
    nombre: 'la clave compartida KAIA_OPERATOR_API_KEY',
    desde: '2026-09-22',
    busca: [/KAIA_OPERATOR_API_KEY/],
    porque:
      'Abría todo el panel de administración con una sola cadena, sin segundo factor, ' +
      'sin límite de intentos y sin forma de revocarla. Ser operador sale ahora ' +
      'únicamente de una OperatorSession, que nace tras el segundo factor y se puede ' +
      'revocar. No la vuelvas a leer de process.env.',
    excepciones: [
      {
        archivo: 'tests/unit/admin-session-resolver.test.ts',
        motivo: 'La pone a propósito para comprobar que YA NO autentica. Es la valla, no el fallo.',
      },
      {
        archivo: 'tests/unit/operator-session-validity.test.ts',
        motivo: 'Ídem: comprueba que la cabecera sola da 401.',
      },
      {
        archivo: 'tests/specs/admin-editor/editor.auth.spec.ts',
        motivo:
          'Playwright. Se salta solo cuando la variable no está, o sea SIEMPRE desde que ' +
          'se retiró: es código muerto pendiente de borrar, anotado el 22/09/2026 y todavía ahí.',
      },
      {
        archivo: 'tests/specs/admin-flows.spec.ts',
        motivo: 'Ídem que el anterior.',
      },
    ],
  },
  {
    nombre: "cargar un módulo con (0, eval)('require')",
    desde: '2026-09-22',
    busca: [/\(\s*0\s*,\s*eval\s*\)\s*\(\s*['"]require['"]\s*\)/],
    porque:
      'Funciona en local (Node, CommonJS) y no en la compilación de producción de Next, ' +
      'donde `require` no existe. Entre agosto y el 22/09/2026 ningún email salió de ' +
      'producción por esto, y ninguna prueba lo vio: el envío devolvía {ok:false}, se ' +
      'anotaba como warn y la ruta respondía con éxito. Usa `await import()`, que sigue ' +
      'siendo perezoso y sí existe en el bundle. ' +
      'email-resend-loading.test.ts vigila los módulos de correo; esto vigila el resto.',
  },
];

/** Los .ts y .tsx de una carpeta, recursivo. */
function archivosDe(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      return nombre === 'node_modules' ? [] : archivosDe(ruta);
    }
    return /\.tsx?$/.test(nombre) ? [ruta] : [];
  });
}

/**
 * Una línea de comentario no cuenta.
 *
 * Se mira el principio de la línea en vez de quitar los comentarios del archivo
 * entero: un `//` dentro de una cadena —cualquier URL https:// lo tiene— haría
 * que el resto de esa línea dejara de mirarse, y eso ESCONDERÍA coincidencias.
 * Un falso negativo en una valla es peor que un falso positivo.
 */
function esComentario(linea: string): boolean {
  const t = linea.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const ESTE_ARCHIVO = relative(RAIZ, __filename).split(sep).join('/');

const FICHEROS = CARPETAS.flatMap((c) => archivosDe(join(RAIZ, c))).map((ruta) => ({
  rel: relative(RAIZ, ruta).split(sep).join('/'),
  lineas: readFileSync(ruta, 'utf8').split('\n'),
}));

describe('lo retirado sigue retirado', () => {
  it('hay algo que mirar', () => {
    // Si el barrido se queda sin archivos —una carpeta renombrada, una ruta
    // mal compuesta— los demás casos pasarían en verde sin comprobar nada.
    expect(FICHEROS.length).toBeGreaterThan(400);
  });

  for (const patron of PATRONES) {
    const exceptuados = new Map((patron.excepciones ?? []).map((e) => [e.archivo, e.motivo]));

    it(`${patron.nombre} no ha vuelto`, () => {
      const encontrados: string[] = [];

      for (const { rel, lineas } of FICHEROS) {
        if (rel === ESTE_ARCHIVO || exceptuados.has(rel)) continue;

        lineas.forEach((linea, i) => {
          if (esComentario(linea)) return;
          if (patron.busca.some((re) => re.test(linea))) {
            encontrados.push(`  ${rel}:${i + 1}\n      ${linea.trim().slice(0, 110)}`);
          }
        });
      }

      expect(
        encontrados.join('\n'),
        `\n\n«${patron.nombre}» se retiró el ${patron.desde} y ha vuelto:\n\n` +
          `${encontrados.join('\n')}\n\n` +
          `${patron.porque}\n\n` +
          'Si de verdad hace falta ahí, añádelo a las excepciones de PATRONES con su\n' +
          'motivo escrito. Una excepción sin motivo es una valla apagada.\n',
      ).toBe('');
    });

    it(`las excepciones de «${patron.nombre}» siguen haciendo falta`, () => {
      // Una excepción que sobra es peor que ninguna: deja un hueco abierto en
      // un archivo que ya nadie mira. Si el patrón desapareció de ahí, fuera.
      const sobran = [...exceptuados.keys()].filter((archivo) => {
        const f = FICHEROS.find((x) => x.rel === archivo);
        if (!f) return true; // el archivo ya no existe
        return !f.lineas.some((l) => !esComentario(l) && patron.busca.some((re) => re.test(l)));
      });

      expect(
        sobran.join(', '),
        `\n\nEstas excepciones ya no hacen falta y hay que quitarlas de PATRONES:\n` +
          `  ${sobran.join('\n  ')}\n`,
      ).toBe('');
    });
  }
});
