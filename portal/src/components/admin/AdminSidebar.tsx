'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ADMIN_NAV, ADMIN_HOME_ITEM, type AdminNavGroup, type AdminNavItem } from '@/lib/admin-nav';
import { ADMIN_GROUP_ICON, ADMIN_GROUP_ICON_FALLBACK } from '@/components/admin/admin-nav-icons';

// =============================================================================
// Barra lateral del panel de operador. Mismo patrón que
// components/portal/PortalSidebar.tsx (datos en un módulo aparte,
// resaltado por ruta activa) — sin el anidado de esa, porque aquí los
// grupos son etiquetas de categoría (Clientes, Bandejas de trabajo…),
// no páginas propias con hijos.
//
// Un solo componente para escritorio y móvil: en escritorio es una
// barra fija (`lg:flex`); en móvil, la misma lista dentro de un
// <details> nativo en la cabecera — sin JS de apertura/cierre propio,
// el navegador ya lo resuelve.
//
// 03/11/2026 — tres cambios pedidos por Orlando:
// - Fija: se queda pegada arriba al bajar por la página (sticky, con su
//   propio scroll solo si aun así no cabe).
// - Grupos en acordeón: abierto el de la página en la que estás y, al
//   abrir otro, se cierra el anterior. Con todos abiertos eran 22 enlaces
//   y la barra pasaba del alto de la pantalla; así el peor caso es el
//   grupo más largo (Configuración, 11).
// - Contraída (solo iconos): el contenido gana el ancho entero. Cada
//   icono de grupo abre sus enlaces en un panel flotante. La preferencia
//   va en una cookie (no en localStorage) para que el servidor pinte ya la
//   barra como la dejaste, sin un parpadeo de la ancha a la estrecha.
// =============================================================================

function isItemActive(item: AdminNavItem, pathname: string): boolean {
  // /admin/portal (Inicio) es prefijo literal de TODAS las demás rutas
  // del panel (/admin/portal/clients, /admin/portal/recall…) — sin este
  // caso especial, "Inicio" saldría resaltado en cualquier página,
  // mismo motivo por el que PortalSidebar hace lo mismo con '/portal'.
  if (item.href === '/admin/portal') return pathname === '/admin/portal';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** El grupo de la página actual. «Nuevo cliente» (/clients/new) también
 *  empieza por /clients: da igual, los dos están en el mismo grupo. */
function activeGroupOf(pathname: string): string | null {
  return ADMIN_NAV.find((g) => g.items.some((i) => isItemActive(i, pathname)))?.label ?? null;
}

const slug = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');

const HomeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const linkClass = (active: boolean) =>
  [
    'block rounded-lg px-3 py-1 text-sm leading-tight transition',
    active ? 'bg-kairikos-surface text-kairikos-text font-medium' : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
  ].join(' ');

function GroupLinks({ group, pathname, onNavigate }: { group: AdminNavGroup; pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {group.items.map((item) => {
        const isActive = isItemActive(item, pathname);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              data-testid={`admin-sidebar-link-${item.href.replace(/\//g, '-')}`}
              onClick={onNavigate}
              className={linkClass(isActive)}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** La lista ancha, con los grupos en acordeón. `idPrefix` separa la de
 *  escritorio de la del desplegable de móvil, que conviven en el DOM (la
 *  de escritorio solo se oculta por CSS): con el mismo id o testid, un
 *  selector cogería la invisible. */
function NavList({ pathname, idPrefix, onNavigate }: { pathname: string; idPrefix: string; onNavigate?: () => void }) {
  const homeActive = isItemActive(ADMIN_HOME_ITEM, pathname);
  const activeGroup = activeGroupOf(pathname);
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroup);

  // Al llegar a otra página se abre su grupo (y se cierra el que tuvieras
  // abierto a mano): siempre se ve dónde estás.
  useEffect(() => {
    setOpenGroup(activeGroup);
  }, [activeGroup]);

  return (
    <>
      <Link
        href={ADMIN_HOME_ITEM.href}
        aria-current={homeActive ? 'page' : undefined}
        data-testid="admin-sidebar-link-admin-portal"
        onClick={onNavigate}
        className={[
          'mb-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition',
          homeActive ? 'bg-kairikos-surface text-kairikos-text' : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
        ].join(' ')}
      >
        <HomeIcon />
        {ADMIN_HOME_ITEM.label}
      </Link>
      <ul className="space-y-1">
        {ADMIN_NAV.map((group) => {
          const open = openGroup === group.label;
          const panelId = `${idPrefix}-grupo-${slug(group.label)}`;
          return (
            <li key={group.label}>
              <button
                type="button"
                onClick={() => setOpenGroup(open ? null : group.label)}
                aria-expanded={open}
                aria-controls={panelId}
                data-testid={`${idPrefix}-group-${slug(group.label)}`}
                className={[
                  'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider transition hover:bg-kairikos-surface',
                  // Cerrado, el grupo de la página actual se distingue igual.
                  activeGroup === group.label ? 'text-kairikos-text' : 'text-kairikos-muted hover:text-kairikos-text',
                ].join(' ')}
              >
                <span className="shrink-0" aria-hidden>
                  {ADMIN_GROUP_ICON[group.label] ?? ADMIN_GROUP_ICON_FALLBACK}
                </span>
                <span className="min-w-0 flex-1">{group.label}</span>
                <Chevron open={open} />
              </button>
              {open ? (
                <div id={panelId} className="mb-2 mt-1">
                  <GroupLinks group={group} pathname={pathname} onNavigate={onNavigate} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** La barra contraída: Inicio y un icono por grupo. El panel del grupo va
 *  con position: fixed, calculado del botón: dentro de la barra, que tiene
 *  su propio scroll, uno absoluto quedaría recortado. */
function MiniNav({ pathname }: { pathname: string }) {
  const activeGroup = activeGroupOf(pathname);
  const [open, setOpen] = useState<{
    label: string;
    top: number;
    left: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => setOpen(null), [pathname]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttons.current[open.label]?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      buttons.current[open.label]?.focus();
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Fijo en pantalla: si la página se mueve, se separaría de su icono.
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const iconClass = (active: boolean) =>
    [
      'grid h-10 w-10 place-items-center rounded-lg transition',
      active ? 'bg-kairikos-surface text-kairikos-text' : 'text-kairikos-muted hover:bg-kairikos-surface hover:text-kairikos-text',
    ].join(' ');

  const group = open ? ADMIN_NAV.find((g) => g.label === open.label) : undefined;
  return (
    <>
      <Link
        href={ADMIN_HOME_ITEM.href}
        aria-current={isItemActive(ADMIN_HOME_ITEM, pathname) ? 'page' : undefined}
        aria-label={ADMIN_HOME_ITEM.label}
        title={ADMIN_HOME_ITEM.label}
        data-testid="admin-sidebar-link-admin-portal"
        className={`mb-3 ${iconClass(isItemActive(ADMIN_HOME_ITEM, pathname))}`}
      >
        <HomeIcon />
      </Link>
      <ul className="space-y-1">
        {ADMIN_NAV.map((g) => (
          <li key={g.label}>
            <button
              type="button"
              ref={(el) => {
                buttons.current[g.label] = el;
              }}
              aria-label={g.label}
              title={g.label}
              aria-expanded={open?.label === g.label}
              aria-haspopup="true"
              data-testid={`admin-sidebar-mini-group-${slug(g.label)}`}
              onClick={(e) => {
                if (open?.label === g.label) return setOpen(null);
                const r = e.currentTarget.getBoundingClientRect();
                setOpen({ label: g.label, top: r.top, left: r.right + 8 });
              }}
              className={iconClass(activeGroup === g.label || open?.label === g.label)}
            >
              {ADMIN_GROUP_ICON[g.label] ?? ADMIN_GROUP_ICON_FALLBACK}
            </button>
          </li>
        ))}
      </ul>
      {open && group ? (
        <div
          ref={panelRef}
          role="region"
          aria-label={group.label}
          data-testid="admin-sidebar-flyout"
          style={{
            top: open.top,
            left: open.left,
            maxHeight: `calc(100vh - ${Math.round(open.top)}px - 12px)`,
          }}
          className="fixed z-40 w-60 overflow-y-auto rounded-xl border border-kairikos-border bg-kairikos-bg p-2 shadow-lg"
        >
          <p className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-kairikos-muted">{group.label}</p>
          <GroupLinks group={group} pathname={pathname} onNavigate={() => setOpen(null)} />
        </div>
      ) : null}
    </>
  );
}

export function AdminSidebar({ mini, onToggleMini }: { mini: boolean; onToggleMini: () => void }) {
  const pathname = usePathname() ?? '/admin/portal';
  const toggleLabel = mini ? 'Expandir el menú' : 'Contraer el menú (solo iconos)';

  return (
    <>
      {/* Escritorio — barra fija. La columna se estira al alto de la página
          (lleva el borde, que así llega hasta abajo) y la barra va pegada
          dentro con sticky: estirada ella misma no tendría dónde pegarse. */}
      <div className={`hidden shrink-0 border-r border-kairikos-border bg-kairikos-bg/60 lg:block ${mini ? 'w-16' : 'w-60'}`}>
        <nav
          aria-label="Navegación del panel de operador"
          className="sticky top-0 flex max-h-screen flex-col"
          data-testid="admin-sidebar"
          data-mini={mini ? 'true' : 'false'}
        >
          {/* Arriba y no al pie: con la página sin bajar, la barra empieza bajo
            la cabecera y su pie quedaría fuera de la pantalla. */}
          <div className={`flex px-3 pt-4 ${mini ? 'justify-center px-2' : 'justify-end'}`}>
            <button
              type="button"
              onClick={onToggleMini}
              aria-label={toggleLabel}
              title={toggleLabel}
              aria-pressed={mini}
              data-testid="admin-sidebar-toggle"
              className="grid h-8 w-8 place-items-center rounded-lg text-kairikos-muted transition hover:bg-kairikos-surface hover:text-kairikos-text"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <path d="M9.5 4.5v15" />
                <path d={mini ? 'M13.5 10l2 2-2 2' : 'M16 10l-2 2 2 2'} />
              </svg>
            </button>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto pb-6 pt-2 ${mini ? 'flex flex-col items-center px-2' : 'px-3'}`}>
            {mini ? <MiniNav pathname={pathname} /> : <NavList pathname={pathname} idPrefix="admin-sidebar" />}
          </div>
        </nav>
      </div>

      {/* Móvil/tablet — desplegable nativo, sin duplicar el estado en JS */}
      <details className="border-b border-kairikos-border bg-kairikos-bg lg:hidden" data-testid="admin-sidebar-mobile">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-kairikos-text marker:hidden">
          <span className="inline-flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            Menú
          </span>
        </summary>
        <div className="border-t border-kairikos-border px-3 py-4">
          <NavList pathname={pathname} idPrefix="admin-sidebar-mobile" />
        </div>
      </details>
    </>
  );
}
