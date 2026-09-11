// Navegación lateral del panel de operador — fuente única, consumida por
// AdminSidebar (desktop y móvil comparten esta misma lista).
//
// Antes de esto, 9 de los ~14 destinos del panel solo eran alcanzables
// desde un cinturón de botones en /admin/portal/clients, y otros tres
// (flows, wizard-funnel, settings/security) no tenían NINGÚN enlace
// visible — solo escribiendo la URL a mano. Confirmado con
// `grep -rn` sobre todo src/app antes de escribir esta lista, no de
// memoria.
//
// Agrupado por el RITMO de uso, no por dónde vive el fichero: las
// bandejas se miran a diario (algo pendiente que resolver); la
// configuración se toca una vez y se queda.

export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

export interface AdminNavGroup {
  readonly label: string;
  readonly items: readonly AdminNavItem[];
}

export const ADMIN_NAV: readonly AdminNavGroup[] = [
  {
    label: 'Clientes',
    items: [
      { href: '/admin/portal/clients', label: 'Todos los clientes' },
      { href: '/admin/portal/clients/new', label: 'Nuevo cliente' },
    ],
  },
  {
    label: 'Bandejas de trabajo',
    items: [
      { href: '/admin/portal/recall', label: 'Altas de llamadas' },
      { href: '/admin/portal/leads', label: 'Leads sin cerrar' },
      { href: '/admin/portal/web-quotes', label: 'Presupuestos de web' },
      { href: '/admin/portal/support', label: 'Solicitudes de ayuda' },
    ],
  },
  {
    label: 'Monitorización',
    items: [
      { href: '/admin/portal/flows', label: 'Salud de los flujos' },
      { href: '/admin/portal/wizard-funnel', label: 'Embudo de cohortes' },
    ],
  },
  {
    label: 'Configuración',
    items: [
      { href: '/admin/portal/settings/billing', label: 'Facturación' },
      { href: '/admin/portal/settings/telephony', label: 'Telefonía' },
      { href: '/admin/portal/settings/meta', label: 'Meta' },
      { href: '/admin/portal/settings/integrations', label: 'Integraciones' },
      { href: '/admin/portal/settings/seo', label: 'SEO con IA' },
      { href: '/admin/portal/settings/security', label: 'Seguridad' },
    ],
  },
] as const;
