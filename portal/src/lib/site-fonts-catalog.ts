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
      "fraunces-italic-100-900-latin-ext.woff2",
      "fraunces-italic-100-900-latin.woff2",
      "fraunces-normal-100-900-latin-ext.woff2",
      "fraunces-normal-100-900-latin.woff2"
    ]
  },
  "Playfair Display": {
    "slug": "playfair-display",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "playfair-display-italic-400-900-latin-ext.woff2",
      "playfair-display-italic-400-900-latin.woff2",
      "playfair-display-normal-400-900-latin-ext.woff2",
      "playfair-display-normal-400-900-latin.woff2"
    ]
  },
  "Lora": {
    "slug": "lora",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "lora-italic-400-700-latin-ext.woff2",
      "lora-italic-400-700-latin.woff2",
      "lora-normal-400-700-latin-ext.woff2",
      "lora-normal-400-700-latin.woff2"
    ]
  },
  "Libre Baskerville": {
    "slug": "libre-baskerville",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "libre-baskerville-italic-400-700-latin-ext.woff2",
      "libre-baskerville-italic-400-700-latin.woff2",
      "libre-baskerville-normal-400-700-latin-ext.woff2",
      "libre-baskerville-normal-400-700-latin.woff2"
    ]
  },
  "Bitter": {
    "slug": "bitter",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "bitter-italic-100-900-latin-ext.woff2",
      "bitter-italic-100-900-latin.woff2",
      "bitter-normal-100-900-latin-ext.woff2",
      "bitter-normal-100-900-latin.woff2"
    ]
  },
  "DM Serif Display": {
    "slug": "dm-serif-display",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "dm-serif-display-italic-400-latin-ext.woff2",
      "dm-serif-display-italic-400-latin.woff2",
      "dm-serif-display-normal-400-latin-ext.woff2",
      "dm-serif-display-normal-400-latin.woff2"
    ]
  },
  "Cormorant Garamond": {
    "slug": "cormorant-garamond",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "cormorant-garamond-italic-300-700-latin-ext.woff2",
      "cormorant-garamond-italic-300-700-latin.woff2",
      "cormorant-garamond-normal-300-700-latin-ext.woff2",
      "cormorant-garamond-normal-300-700-latin.woff2"
    ]
  },
  "Young Serif": {
    "slug": "young-serif",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "young-serif-normal-400-latin-ext.woff2",
      "young-serif-normal-400-latin.woff2"
    ]
  },
  "Instrument Serif": {
    "slug": "instrument-serif",
    "uso": "display",
    "categoria": "Serif",
    "files": [
      "instrument-serif-italic-400-latin-ext.woff2",
      "instrument-serif-italic-400-latin.woff2",
      "instrument-serif-normal-400-latin-ext.woff2",
      "instrument-serif-normal-400-latin.woff2"
    ]
  },
  "Bricolage Grotesque": {
    "slug": "bricolage-grotesque",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "bricolage-grotesque-normal-200-800-latin-ext.woff2",
      "bricolage-grotesque-normal-200-800-latin.woff2"
    ]
  },
  "Space Grotesk": {
    "slug": "space-grotesk",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "space-grotesk-normal-300-700-latin-ext.woff2",
      "space-grotesk-normal-300-700-latin.woff2"
    ]
  },
  "Syne": {
    "slug": "syne",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "syne-normal-400-800-latin-ext.woff2",
      "syne-normal-400-800-latin.woff2"
    ]
  },
  "Oswald": {
    "slug": "oswald",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "oswald-normal-200-700-latin-ext.woff2",
      "oswald-normal-200-700-latin.woff2"
    ]
  },
  "Bebas Neue": {
    "slug": "bebas-neue",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "bebas-neue-normal-400-latin-ext.woff2",
      "bebas-neue-normal-400-latin.woff2"
    ]
  },
  "Barlow Condensed": {
    "slug": "barlow-condensed",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "barlow-condensed-italic-100-latin-ext.woff2",
      "barlow-condensed-italic-100-latin.woff2",
      "barlow-condensed-italic-200-latin-ext.woff2",
      "barlow-condensed-italic-200-latin.woff2",
      "barlow-condensed-italic-300-latin-ext.woff2",
      "barlow-condensed-italic-300-latin.woff2",
      "barlow-condensed-italic-400-latin-ext.woff2",
      "barlow-condensed-italic-400-latin.woff2",
      "barlow-condensed-italic-500-latin-ext.woff2",
      "barlow-condensed-italic-500-latin.woff2",
      "barlow-condensed-italic-600-latin-ext.woff2",
      "barlow-condensed-italic-600-latin.woff2",
      "barlow-condensed-italic-700-latin-ext.woff2",
      "barlow-condensed-italic-700-latin.woff2",
      "barlow-condensed-italic-800-latin-ext.woff2",
      "barlow-condensed-italic-800-latin.woff2",
      "barlow-condensed-italic-900-latin-ext.woff2",
      "barlow-condensed-italic-900-latin.woff2",
      "barlow-condensed-normal-100-latin-ext.woff2",
      "barlow-condensed-normal-100-latin.woff2",
      "barlow-condensed-normal-200-latin-ext.woff2",
      "barlow-condensed-normal-200-latin.woff2",
      "barlow-condensed-normal-300-latin-ext.woff2",
      "barlow-condensed-normal-300-latin.woff2",
      "barlow-condensed-normal-400-latin-ext.woff2",
      "barlow-condensed-normal-400-latin.woff2",
      "barlow-condensed-normal-500-latin-ext.woff2",
      "barlow-condensed-normal-500-latin.woff2",
      "barlow-condensed-normal-600-latin-ext.woff2",
      "barlow-condensed-normal-600-latin.woff2",
      "barlow-condensed-normal-700-latin-ext.woff2",
      "barlow-condensed-normal-700-latin.woff2",
      "barlow-condensed-normal-800-latin-ext.woff2",
      "barlow-condensed-normal-800-latin.woff2",
      "barlow-condensed-normal-900-latin-ext.woff2",
      "barlow-condensed-normal-900-latin.woff2"
    ]
  },
  "Josefin Sans": {
    "slug": "josefin-sans",
    "uso": "display",
    "categoria": "Sans Serif",
    "files": [
      "josefin-sans-italic-100-700-latin-ext.woff2",
      "josefin-sans-italic-100-700-latin.woff2",
      "josefin-sans-normal-100-700-latin-ext.woff2",
      "josefin-sans-normal-100-700-latin.woff2"
    ]
  },
  "Inter": {
    "slug": "inter",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "inter-italic-100-900-latin-ext.woff2",
      "inter-italic-100-900-latin.woff2",
      "inter-normal-100-900-latin-ext.woff2",
      "inter-normal-100-900-latin.woff2"
    ]
  },
  "Source Sans 3": {
    "slug": "source-sans-3",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "source-sans-3-italic-200-900-latin-ext.woff2",
      "source-sans-3-italic-200-900-latin.woff2",
      "source-sans-3-normal-200-900-latin-ext.woff2",
      "source-sans-3-normal-200-900-latin.woff2"
    ]
  },
  "Manrope": {
    "slug": "manrope",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "manrope-normal-200-800-latin-ext.woff2",
      "manrope-normal-200-800-latin.woff2"
    ]
  },
  "DM Sans": {
    "slug": "dm-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "dm-sans-italic-100-1000-latin-ext.woff2",
      "dm-sans-italic-100-1000-latin.woff2",
      "dm-sans-normal-100-1000-latin-ext.woff2",
      "dm-sans-normal-100-1000-latin.woff2"
    ]
  },
  "Work Sans": {
    "slug": "work-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "work-sans-italic-100-900-latin-ext.woff2",
      "work-sans-italic-100-900-latin.woff2",
      "work-sans-normal-100-900-latin-ext.woff2",
      "work-sans-normal-100-900-latin.woff2"
    ]
  },
  "Nunito Sans": {
    "slug": "nunito-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "nunito-sans-italic-200-1000-latin-ext.woff2",
      "nunito-sans-italic-200-1000-latin.woff2",
      "nunito-sans-normal-200-1000-latin-ext.woff2",
      "nunito-sans-normal-200-1000-latin.woff2"
    ]
  },
  "Figtree": {
    "slug": "figtree",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "figtree-italic-300-900-latin-ext.woff2",
      "figtree-italic-300-900-latin.woff2",
      "figtree-normal-300-900-latin-ext.woff2",
      "figtree-normal-300-900-latin.woff2"
    ]
  },
  "Plus Jakarta Sans": {
    "slug": "plus-jakarta-sans",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "plus-jakarta-sans-italic-200-800-latin-ext.woff2",
      "plus-jakarta-sans-italic-200-800-latin.woff2",
      "plus-jakarta-sans-normal-200-800-latin-ext.woff2",
      "plus-jakarta-sans-normal-200-800-latin.woff2"
    ]
  },
  "Outfit": {
    "slug": "outfit",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "outfit-normal-100-900-latin-ext.woff2",
      "outfit-normal-100-900-latin.woff2"
    ]
  },
  "Rubik": {
    "slug": "rubik",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "rubik-italic-300-900-latin-ext.woff2",
      "rubik-italic-300-900-latin.woff2",
      "rubik-normal-300-900-latin-ext.woff2",
      "rubik-normal-300-900-latin.woff2"
    ]
  },
  "Barlow": {
    "slug": "barlow",
    "uso": "texto",
    "categoria": "Sans Serif",
    "files": [
      "barlow-italic-100-latin-ext.woff2",
      "barlow-italic-100-latin.woff2",
      "barlow-italic-200-latin-ext.woff2",
      "barlow-italic-200-latin.woff2",
      "barlow-italic-300-latin-ext.woff2",
      "barlow-italic-300-latin.woff2",
      "barlow-italic-400-latin-ext.woff2",
      "barlow-italic-400-latin.woff2",
      "barlow-italic-500-latin-ext.woff2",
      "barlow-italic-500-latin.woff2",
      "barlow-italic-600-latin-ext.woff2",
      "barlow-italic-600-latin.woff2",
      "barlow-italic-700-latin-ext.woff2",
      "barlow-italic-700-latin.woff2",
      "barlow-italic-800-latin-ext.woff2",
      "barlow-italic-800-latin.woff2",
      "barlow-italic-900-latin-ext.woff2",
      "barlow-italic-900-latin.woff2",
      "barlow-normal-100-latin-ext.woff2",
      "barlow-normal-100-latin.woff2",
      "barlow-normal-200-latin-ext.woff2",
      "barlow-normal-200-latin.woff2",
      "barlow-normal-300-latin-ext.woff2",
      "barlow-normal-300-latin.woff2",
      "barlow-normal-400-latin-ext.woff2",
      "barlow-normal-400-latin.woff2",
      "barlow-normal-500-latin-ext.woff2",
      "barlow-normal-500-latin.woff2",
      "barlow-normal-600-latin-ext.woff2",
      "barlow-normal-600-latin.woff2",
      "barlow-normal-700-latin-ext.woff2",
      "barlow-normal-700-latin.woff2",
      "barlow-normal-800-latin-ext.woff2",
      "barlow-normal-800-latin.woff2",
      "barlow-normal-900-latin-ext.woff2",
      "barlow-normal-900-latin.woff2"
    ]
  }
};
