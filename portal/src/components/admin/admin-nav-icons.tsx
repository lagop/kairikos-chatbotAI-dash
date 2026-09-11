import type { ReactNode } from 'react';

// Mismo trazo que components/portal/portal-nav-icons.tsx (stroke 1.6,
// extremos redondeados) — un icono por GRUPO, no por página, porque en
// esta barra los grupos son la unidad visual (a diferencia del portal de
// cliente, donde cada página tiene la suya). Clave por la etiqueta del
// grupo en lib/admin-nav.ts, así que un grupo nuevo sin entrada aquí cae
// al punto neutro en vez de romper el render.

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const ADMIN_GROUP_ICON: Record<string, ReactNode> = {
  // Clientes — una persona.
  Clientes: (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2" />
    </svg>
  ),
  // Bandejas de trabajo — una bandeja de entrada.
  'Bandejas de trabajo': (
    <svg {...ICON_PROPS}>
      <path d="M4 12h4.2l1.4 2.6h4.8L15.8 12H20" />
      <path d="M4 12V6.6A1.6 1.6 0 0 1 5.6 5h12.8A1.6 1.6 0 0 1 20 6.6V12" />
      <path d="M4 12v5.4A1.6 1.6 0 0 0 5.6 19h12.8a1.6 1.6 0 0 0 1.6-1.6V12" />
    </svg>
  ),
  // Monitorización — un trazo de pulso.
  Monitorización: (
    <svg {...ICON_PROPS}>
      <path d="M3 12h3.5l2-6.5L13 18.5l2-9.5 1.8 3h3.2" />
    </svg>
  ),
  // Configuración — controles deslizantes.
  Configuración: (
    <svg {...ICON_PROPS}>
      <path d="M4 6.5h9M17 6.5h3M4 17.5h9M17 17.5h3" />
      <circle cx="15" cy="6.5" r="2.1" />
      <circle cx="7" cy="17.5" r="2.1" />
    </svg>
  ),
};

export const ADMIN_GROUP_ICON_FALLBACK: ReactNode = (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="2" />
  </svg>
);
