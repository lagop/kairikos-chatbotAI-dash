// Generado por scripts/descargar-tipografias.mjs — no editar a mano.
// Las familias que una plantilla puede usar y los archivos de cada una, que
// están en public/fuentes/<slug>/. Ver site-fonts.ts.

export interface SiteFont {
  slug: string;
  /** display: titulares; texto: cuerpo. Es lo que se le dice a la IA. */
  uso: 'display' | 'texto';
  categoria: string;
  files: readonly string[];
}

export const SITE_FONT_CATALOG: Readonly<Record<string, SiteFont>> = {
  "Fraunces": {
    "slug": "fraunces",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-100-900-latin-ext.woff2",
      "italic-100-900-latin.woff2",
      "normal-100-900-latin-ext.woff2",
      "normal-100-900-latin.woff2"
    ]
  },
  "Playfair Display": {
    "slug": "playfair-display",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-400-900-latin-ext.woff2",
      "italic-400-900-latin.woff2",
      "normal-400-900-latin-ext.woff2",
      "normal-400-900-latin.woff2"
    ]
  },
  "Lora": {
    "slug": "lora",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-400-700-latin-ext.woff2",
      "italic-400-700-latin.woff2",
      "normal-400-700-latin-ext.woff2",
      "normal-400-700-latin.woff2"
    ]
  },
  "Libre Baskerville": {
    "slug": "libre-baskerville",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-400-700-latin-ext.woff2",
      "italic-400-700-latin.woff2",
      "normal-400-700-latin-ext.woff2",
      "normal-400-700-latin.woff2"
    ]
  },
  "Bitter": {
    "slug": "bitter",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-100-900-latin-ext.woff2",
      "italic-100-900-latin.woff2",
      "normal-100-900-latin-ext.woff2",
      "normal-100-900-latin.woff2"
    ]
  },
  "DM Serif Display": {
    "slug": "dm-serif-display",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-400-latin-ext.woff2",
      "italic-400-latin.woff2",
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2"
    ]
  },
  "Cormorant Garamond": {
    "slug": "cormorant-garamond",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-300-700-latin-ext.woff2",
      "italic-300-700-latin.woff2",
      "normal-300-700-latin-ext.woff2",
      "normal-300-700-latin.woff2"
    ]
  },
  "Young Serif": {
    "slug": "young-serif",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2"
    ]
  },
  "Instrument Serif": {
    "slug": "instrument-serif",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "italic-400-latin-ext.woff2",
      "italic-400-latin.woff2",
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2"
    ]
  },
  "Bricolage Grotesque": {
    "slug": "bricolage-grotesque",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "normal-200-800-latin-ext.woff2",
      "normal-200-800-latin.woff2"
    ]
  },
  "Space Grotesk": {
    "slug": "space-grotesk",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "normal-300-700-latin-ext.woff2",
      "normal-300-700-latin.woff2"
    ]
  },
  "Syne": {
    "slug": "syne",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "normal-400-800-latin-ext.woff2",
      "normal-400-800-latin.woff2"
    ]
  },
  "Oswald": {
    "slug": "oswald",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "normal-200-700-latin-ext.woff2",
      "normal-200-700-latin.woff2"
    ]
  },
  "Bebas Neue": {
    "slug": "bebas-neue",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2"
    ]
  },
  "Barlow Condensed": {
    "slug": "barlow-condensed",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-latin-ext.woff2",
      "italic-100-latin.woff2",
      "italic-200-latin-ext.woff2",
      "italic-200-latin.woff2",
      "italic-300-latin-ext.woff2",
      "italic-300-latin.woff2",
      "italic-400-latin-ext.woff2",
      "italic-400-latin.woff2",
      "italic-500-latin-ext.woff2",
      "italic-500-latin.woff2",
      "italic-600-latin-ext.woff2",
      "italic-600-latin.woff2",
      "italic-700-latin-ext.woff2",
      "italic-700-latin.woff2",
      "italic-800-latin-ext.woff2",
      "italic-800-latin.woff2",
      "italic-900-latin-ext.woff2",
      "italic-900-latin.woff2",
      "normal-100-latin-ext.woff2",
      "normal-100-latin.woff2",
      "normal-200-latin-ext.woff2",
      "normal-200-latin.woff2",
      "normal-300-latin-ext.woff2",
      "normal-300-latin.woff2",
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2",
      "normal-500-latin-ext.woff2",
      "normal-500-latin.woff2",
      "normal-600-latin-ext.woff2",
      "normal-600-latin.woff2",
      "normal-700-latin-ext.woff2",
      "normal-700-latin.woff2",
      "normal-800-latin-ext.woff2",
      "normal-800-latin.woff2",
      "normal-900-latin-ext.woff2",
      "normal-900-latin.woff2"
    ]
  },
  "Josefin Sans": {
    "slug": "josefin-sans",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-700-latin-ext.woff2",
      "italic-100-700-latin.woff2",
      "normal-100-700-latin-ext.woff2",
      "normal-100-700-latin.woff2"
    ]
  },
  "Inter": {
    "slug": "inter",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-900-latin-ext.woff2",
      "italic-100-900-latin.woff2",
      "normal-100-900-latin-ext.woff2",
      "normal-100-900-latin.woff2"
    ]
  },
  "Source Sans 3": {
    "slug": "source-sans-3",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-200-900-latin-ext.woff2",
      "italic-200-900-latin.woff2",
      "normal-200-900-latin-ext.woff2",
      "normal-200-900-latin.woff2"
    ]
  },
  "Manrope": {
    "slug": "manrope",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "normal-200-800-latin-ext.woff2",
      "normal-200-800-latin.woff2"
    ]
  },
  "DM Sans": {
    "slug": "dm-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-1000-latin-ext.woff2",
      "italic-100-1000-latin.woff2",
      "normal-100-1000-latin-ext.woff2",
      "normal-100-1000-latin.woff2"
    ]
  },
  "Work Sans": {
    "slug": "work-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-900-latin-ext.woff2",
      "italic-100-900-latin.woff2",
      "normal-100-900-latin-ext.woff2",
      "normal-100-900-latin.woff2"
    ]
  },
  "Nunito Sans": {
    "slug": "nunito-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-200-1000-latin-ext.woff2",
      "italic-200-1000-latin.woff2",
      "normal-200-1000-latin-ext.woff2",
      "normal-200-1000-latin.woff2"
    ]
  },
  "Figtree": {
    "slug": "figtree",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-300-900-latin-ext.woff2",
      "italic-300-900-latin.woff2",
      "normal-300-900-latin-ext.woff2",
      "normal-300-900-latin.woff2"
    ]
  },
  "Plus Jakarta Sans": {
    "slug": "plus-jakarta-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-200-800-latin-ext.woff2",
      "italic-200-800-latin.woff2",
      "normal-200-800-latin-ext.woff2",
      "normal-200-800-latin.woff2"
    ]
  },
  "Outfit": {
    "slug": "outfit",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "normal-100-900-latin-ext.woff2",
      "normal-100-900-latin.woff2"
    ]
  },
  "Rubik": {
    "slug": "rubik",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-300-900-latin-ext.woff2",
      "italic-300-900-latin.woff2",
      "normal-300-900-latin-ext.woff2",
      "normal-300-900-latin.woff2"
    ]
  },
  "Barlow": {
    "slug": "barlow",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "italic-100-latin-ext.woff2",
      "italic-100-latin.woff2",
      "italic-200-latin-ext.woff2",
      "italic-200-latin.woff2",
      "italic-300-latin-ext.woff2",
      "italic-300-latin.woff2",
      "italic-400-latin-ext.woff2",
      "italic-400-latin.woff2",
      "italic-500-latin-ext.woff2",
      "italic-500-latin.woff2",
      "italic-600-latin-ext.woff2",
      "italic-600-latin.woff2",
      "italic-700-latin-ext.woff2",
      "italic-700-latin.woff2",
      "italic-800-latin-ext.woff2",
      "italic-800-latin.woff2",
      "italic-900-latin-ext.woff2",
      "italic-900-latin.woff2",
      "normal-100-latin-ext.woff2",
      "normal-100-latin.woff2",
      "normal-200-latin-ext.woff2",
      "normal-200-latin.woff2",
      "normal-300-latin-ext.woff2",
      "normal-300-latin.woff2",
      "normal-400-latin-ext.woff2",
      "normal-400-latin.woff2",
      "normal-500-latin-ext.woff2",
      "normal-500-latin.woff2",
      "normal-600-latin-ext.woff2",
      "normal-600-latin.woff2",
      "normal-700-latin-ext.woff2",
      "normal-700-latin.woff2",
      "normal-800-latin-ext.woff2",
      "normal-800-latin.woff2",
      "normal-900-latin-ext.woff2",
      "normal-900-latin.woff2"
    ]
  }
};
