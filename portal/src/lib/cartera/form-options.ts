// =============================================================================
// Cartera — las opciones de los desplegables de la ficha, con su nombre en
// español. Pura y sin zod: la usa el formulario del panel (componente de
// cliente). Los valores son los enums del formato de la web (schema.ts); un
// test (cartera-form-options.test.ts) los compara con el esquema, para que
// el formulario no ofrezca un valor que la web rechaza ni le falte uno nuevo.
// =============================================================================

export type Option = { value: string; label: string };

const TYPE_OPTIONS: Option[] = [
  { value: 'piso', label: 'Piso' },
  { value: 'atico', label: 'Ático' },
  { value: 'adosado', label: 'Adosado' },
  { value: 'duplex', label: 'Dúplex' },
  { value: 'villa', label: 'Villa' },
  { value: 'casa', label: 'Casa' },
  { value: 'cortijo', label: 'Cortijo' },
];

export const VENTA_TYPES: Option[] = [...TYPE_OPTIONS, { value: 'parcela', label: 'Parcela' }];
export const ALQUILER_TYPES: Option[] = TYPE_OPTIONS;

export const ZONES: Option[] = [
  { value: 'costa', label: 'Costa' },
  { value: 'pueblo', label: 'Pueblo' },
  { value: 'golf', label: 'Golf' },
  { value: 'interior', label: 'Interior' },
];

export const VENTA_TAGS: Option[] = [
  { value: 'primera-linea', label: 'Primera línea' },
  { value: 'vistas-mar', label: 'Vistas al mar' },
  { value: 'piscina', label: 'Piscina' },
  { value: 'sin-coche', label: 'Se vive sin coche' },
  { value: 'para-reformar', label: 'Para reformar' },
];

export const ALQUILER_INCLUDES: Option[] = [
  { value: 'comunidad', label: 'Comunidad' },
  { value: 'agua', label: 'Agua' },
  { value: 'luz', label: 'Luz' },
  { value: 'internet', label: 'Internet' },
  { value: 'limpieza', label: 'Limpieza' },
  { value: 'jardin', label: 'Jardín' },
  { value: 'piscina', label: 'Piscina' },
];

export const ALQUILER_TERMS: Option[] = [
  { value: 'larga', label: 'Larga duración (vivienda habitual)' },
  { value: 'temporada', label: 'Temporada (de 32 días a 12 meses)' },
];

export const ENERGY_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

export const MEDIA_LABELS: Record<string, string> = { matterport: 'Recorrido Matterport', youtube: 'Vídeo de YouTube', vimeo: 'Vídeo de Vimeo' };

export const MAX_MEDIA = 3;
