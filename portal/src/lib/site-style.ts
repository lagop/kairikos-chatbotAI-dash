import { z } from "zod";
import { SITE_FONT_CATALOG } from "./site-fonts-catalog";

// =============================================================================
// Webs con IA (27/10/2026) — el color y la tipografía de CADA negocio sobre
// una plantilla de la biblioteca.
//
// Con dos plantillas por sector, dos fontaneros del mismo pueblo tendrían la
// misma web. Lo que un dueño reconoce como suyo es su color (el de la
// furgoneta, el del rótulo) más que el diseño, así que cada web puede llevar
// el suyo, y una tipografía de las que su plantilla admite.
//
// Lo que NO se puede: cambiar cualquier color. El fondo oscuro de «Señal» o
// la crema de «Cercano» son el carácter de la plantilla. Cada plantilla
// DECLARA (SiteTemplate.estilo) qué variables CSS siguen al color del
// negocio y contra qué fondos tienen que leerse; las demás no se tocan. Una
// plantilla sin esa declaración (las de la IA, la base) no admite cambios.
//
// El color no se pone tal cual: se toma su TONO y se busca la luminosidad más
// cercana a la suya que llegue al contraste mínimo contra cada fondo
// declarado. Un azul marino en «Señal», cuyo acento va sobre negro, sale azul
// claro; un amarillo en «Cercano», cuyo acento es texto sobre crema, sale
// ocre. Así el cliente puede escribir el color que quiera sin poder dejar su
// web ilegible. Se calcula en OKLCH, donde cambiar la luminosidad no tuerce
// el tono (en HSL, aclarar un azul lo vuelve morado).
//
// Las tipografías van por PAREJAS cerradas por plantilla (titulares + texto),
// no por familia suelta: «Señal» está pensada para titulares estrechos en
// mayúsculas, y una letra ancha cualquiera le rompería el menú. Las parejas y
// los colores de muestra se miden en el laboratorio igual que el original
// (site-template-checks.ts, styleCheckVariants).
//
// Sin 'server-only' ni nada del servidor: lo usan el motor, el validador y
// scripts/plantilla-a-mano.ts.
// =============================================================================

const HEX_RE = /^#[0-9a-f]{6}$/i;
const VAR_RE = /^--[a-z][a-z0-9-]*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const accentVarSchema = z.object({
  /** La variable CSS del :root de la plantilla ('--amarillo'). */
  variable: z.string().regex(VAR_RE),
  /** 'color': toma el color del negocio. 'tono': solo su tono, con la
   *  luminosidad del valor original (los tintes claros siguen claros y el
   *  acento para texto sigue oscuro). */
  desde: z.enum(["color", "tono"]),
  /** Fondos (o textos) contra los que se tiene que leer: variables del
   *  :root ('--noche') o colores ('#ffffff'). */
  contra: z
    .array(z.string().refine((s) => VAR_RE.test(s) || HEX_RE.test(s)))
    .max(10),
  /** 4,5 si hace de texto normal; 3 si solo de texto grande o de icono. */
  minimo: z.number().min(1).max(7),
});

export const siteTemplateStyleSchema = z.object({
  acento: z
    .object({
      variables: z.array(accentVarSchema).min(1).max(8),
      /** Los colores que se ofrecen con un clic. El primero es el de la
       *  plantilla; se miden todos en el laboratorio. */
      muestras: z
        .array(
          z.object({
            nombre: z.string().min(1).max(30),
            color: z.string().regex(HEX_RE),
          }),
        )
        .min(2)
        .max(8),
    })
    .optional(),
  tipografias: z
    .object({
      /** Las variables CSS de las dos familias ('--display', '--texto'). */
      titulares: z.string().regex(VAR_RE),
      texto: z.string().regex(VAR_RE),
      /** La primera es la de la plantilla. */
      parejas: z
        .array(
          z.object({
            id: z.string().regex(SLUG_RE).max(30),
            nombre: z.string().min(1).max(30),
            titulares: z.string().min(1),
            texto: z.string().min(1),
          }),
        )
        .min(2)
        .max(5),
    })
    .optional(),
});
export type SiteTemplateStyle = z.infer<typeof siteTemplateStyleSchema>;

/** Lo que eligió el negocio (SiteContent.estilo). Vacío = el de la plantilla. */
export interface SiteContentStyle {
  acento?: string;
  tipografia?: string;
}

// ---- Color ---------------------------------------------------------------------

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Contraste WCAG 2 entre dos colores #rrggbb. */
export function contrastHex(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(a), lum(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

type Oklch = { l: number; c: number; h: number };

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** OKLCH → sRGB lineal, sin recortar (puede salirse de [0,1]). */
function oklchToLinear({ l: L, c, h }: Oklch): Rgb {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** El color de esa luminosidad y tono, bajando el croma lo justo para que
 *  exista en sRGB (un amarillo muy oscuro no existe: se vuelve ocre). */
function oklchToHex(color: Oklch): string {
  const inGamut = (c: number) =>
    oklchToLinear({ ...color, c }).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let c = color.c;
  if (!inGamut(c)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return rgbToHex(
    oklchToLinear({ ...color, c }).map((v) =>
      fromLinear(Math.min(1, Math.max(0, v))),
    ) as Rgb,
  );
}

/**
 * El color con el tono y el croma de `base` y la luminosidad más cercana a
 * la suya que llega a `minimo` contra todos los `contra`. Null si ninguna
 * llega (fondos claros y oscuros a la vez con un mínimo alto).
 */
export function nearestReadable(
  base: Oklch,
  contra: string[],
  minimo: number,
): string | null {
  const ok = (hex: string) =>
    contra.every((bg) => contrastHex(hex, bg) >= minimo);
  for (let step = 0; step <= 400; step++) {
    for (const sign of step === 0 ? [1] : [-1, 1]) {
      const l = base.l + (sign * step) / 400;
      if (l < 0 || l > 1) continue;
      const hex = oklchToHex({ ...base, l });
      if (ok(hex)) return hex;
    }
  }
  return null;
}

/** Los valores del :root de una plantilla que son colores, como #rrggbb
 *  (--blanco:#fff cuenta: las dos plantillas de oficios lo escriben así). */
export function rootColors(marco: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of marco.matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = m[2].length === 3 ? m[2].replace(/./g, (c) => c + c) : m[2];
    if (!out.has(m[1])) out.set(m[1], `#${hex.toLowerCase()}`);
  }
  return out;
}

/** Las variables del acento para el color `chosen`, ya con su contraste. */
export function deriveAccentVariables(
  marco: string,
  spec: NonNullable<SiteTemplateStyle["acento"]>,
  chosen: string,
): Record<string, string> {
  const colors = rootColors(marco);
  const target = hexToOklch(chosen);
  const out: Record<string, string> = {};
  for (const v of spec.variables) {
    const original = colors.get(v.variable);
    if (!original) continue;
    const contra = v.contra
      .map((c) => (c.startsWith("--") ? colors.get(c) : c))
      .filter((c): c is string => Boolean(c));
    const own = hexToOklch(original);
    const base =
      v.desde === "color"
        ? target
        : { l: own.l, c: Math.min(own.c, target.c), h: target.h };
    // Si no hay forma de cumplir, se queda el de la plantilla: mejor su color
    // que uno ilegible.
    out[v.variable] = nearestReadable(base, contra, v.minimo) ?? original;
  }
  return out;
}

// ---- Tipografía ----------------------------------------------------------------

/** La pila CSS de una familia del catálogo, con un respaldo de su clase. */
function fontStack(family: string): string {
  const serif = SITE_FONT_CATALOG[family]?.categoria === "Serif";
  return `"${family}",${serif ? "Georgia,serif" : "system-ui,sans-serif"}`;
}

// ---- Validación ----------------------------------------------------------------

/**
 * Lo que tiene que cumplir la declaración de estilo de una plantilla, con
 * mensajes para quien la escribe. Vacío si está bien o si no hay declaración.
 */
export function validateTemplateStyle(
  raw: unknown,
  marco: string,
  declaredFamilies: string[],
): string[] {
  if (raw == null) return [];
  const parsed = siteTemplateStyleSchema.safeParse(raw);
  if (!parsed.success)
    return parsed.error.issues.map(
      (i) => `estilo: ${i.path.join(".")}: ${i.message}`,
    );
  const style = parsed.data;
  const problems: string[] = [];
  const colors = rootColors(marco);
  const defined = (v: string) =>
    new RegExp(`${v.replace(/[-]/g, "\\-")}\\s*:`).test(marco);
  if (style.acento) {
    for (const v of style.acento.variables) {
      const original = colors.get(v.variable);
      if (!original) {
        problems.push(
          `estilo: ${v.variable} tiene que estar en el :root del marco con un color #rrggbb.`,
        );
        continue;
      }
      const contra = v.contra.map((c) =>
        c.startsWith("--") ? colors.get(c) : c,
      );
      const missing = v.contra.filter((_, i) => !contra[i]);
      if (missing.length)
        problems.push(
          `estilo: ${v.variable} se mide contra ${missing.join(", ")}, que no están en el :root con un color #rrggbb.`,
        );
      // Si el original no cumple su propio contraste, la declaración está mal
      // (o el diseño): cualquier color derivado se movería sin motivo.
      const fails = contra.filter(
        (c): c is string =>
          Boolean(c) && contrastHex(original, c as string) < v.minimo,
      );
      if (fails.length)
        problems.push(
          `estilo: ${v.variable} (${original}) no llega a ${v.minimo} contra ${fails.join(", ")}; corrige el color o la declaración.`,
        );
    }
    const first = style.acento.variables.find((v) => v.desde === "color");
    if (!first)
      problems.push(
        "estilo: el acento necesita al menos una variable con desde «color».",
      );
    else if (
      colors.get(first.variable) &&
      style.acento.muestras[0].color.toLowerCase() !==
        colors.get(first.variable)
    ) {
      problems.push(
        `estilo: la primera muestra tiene que ser el color de la plantilla (${colors.get(first.variable)}).`,
      );
    }
  }
  if (style.tipografias) {
    const t = style.tipografias;
    for (const v of [t.titulares, t.texto])
      if (!defined(v))
        problems.push(`estilo: ${v} no está definida en el marco.`);
    const ids = new Set<string>();
    for (const p of t.parejas) {
      if (ids.has(p.id))
        problems.push(`estilo: la pareja «${p.id}» está repetida.`);
      ids.add(p.id);
      for (const f of [p.titulares, p.texto])
        if (!(f in SITE_FONT_CATALOG))
          problems.push(
            `estilo: «${f}» no está en el catálogo de tipografías.`,
          );
    }
    const own = t.parejas[0];
    if (
      ![own.titulares, own.texto].every((f) => declaredFamilies.includes(f))
    ) {
      problems.push(
        `estilo: la primera pareja tiene que ser la que carga el marco (${declaredFamilies.join(", ") || "ninguna"}).`,
      );
    }
  }
  return problems;
}

/** La declaración, o null si no hay o no vale (entonces no se aplica nada). */
export function parseTemplateStyle(raw: unknown): SiteTemplateStyle | null {
  if (raw == null) return null;
  const parsed = siteTemplateStyleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---- Pintado -------------------------------------------------------------------

/**
 * Lo que cambia en una página por el estilo del negocio: las variables CSS
 * y, si cambia la tipografía, qué familia de la plantilla pasa a ser cuál.
 * Null si no cambia nada (lo de la plantilla, o una elección que esta
 * plantilla no admite: un id de pareja de otra plantilla, por ejemplo).
 */
export function resolveSiteStyle(
  marco: string,
  spec: SiteTemplateStyle | null | undefined,
  chosen: SiteContentStyle | null | undefined,
): {
  variables: Record<string, string>;
  familias: Record<string, string>;
} | null {
  if (!spec || !chosen) return null;
  const variables: Record<string, string> = {};
  const familias: Record<string, string> = {};
  const acento = chosen.acento?.toLowerCase();
  if (
    spec.acento &&
    acento &&
    HEX_RE.test(acento) &&
    acento !== spec.acento.muestras[0].color.toLowerCase()
  ) {
    Object.assign(variables, deriveAccentVariables(marco, spec.acento, acento));
  }
  const t = spec.tipografias;
  const pareja = t?.parejas.find((p) => p.id === chosen.tipografia);
  if (t && pareja && pareja !== t.parejas[0]) {
    variables[t.titulares] = fontStack(pareja.titulares);
    variables[t.texto] = fontStack(pareja.texto);
    familias[t.parejas[0].titulares] = pareja.titulares;
    familias[t.parejas[0].texto] = pareja.texto;
  }
  return Object.keys(variables).length ? { variables, familias } : null;
}

/** La hoja que va después de la de la plantilla: mismas variables en
 *  :root, así que ganan por orden. */
export function siteStyleCss(variables: Record<string, string>): string {
  const body = Object.entries(variables)
    // Defensa: los valores salen de este archivo y del catálogo, pero acaban
    // dentro de un <style>.
    .filter(([k, v]) => VAR_RE.test(k) && !/[;{}<>]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `<style id="estilo-negocio">:root{${body}}</style>`;
}

/** Lo que el editor del cliente ofrece: las muestras y las parejas, cada
 *  una con las hojas de sus letras (servidas por el portal) para enseñarla
 *  con su propia letra. Null si la plantilla no admite cambios. */
export function editorStyleOptions(spec: SiteTemplateStyle | null): {
  muestras: { nombre: string; color: string }[];
  parejas: { id: string; nombre: string; titulares: string; texto: string; hojas: string[] }[];
} | null {
  if (!spec || (!spec.acento && !spec.tipografias)) return null;
  const hoja = (family: string) => (SITE_FONT_CATALOG[family] ? [`/fuentes/${SITE_FONT_CATALOG[family].slug}/fuentes.css`] : []);
  return {
    muestras: spec.acento?.muestras.map((m) => ({ nombre: m.nombre, color: m.color.toLowerCase() })) ?? [],
    parejas: spec.tipografias?.parejas.map((p) => ({ ...p, hojas: [...hoja(p.titulares), ...hoja(p.texto)] })) ?? [],
  };
}
