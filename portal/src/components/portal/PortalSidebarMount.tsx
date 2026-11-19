'use client';

import { usePathname } from 'next/navigation';
import { PortalSidebar } from '@/components/portal/PortalSidebar';

export function PortalSidebarMount({ showVillas = false, showCartera = false }: { showVillas?: boolean; showCartera?: boolean }) {
  const pathname = usePathname() ?? '/portal';
  // The sidebar is portal-scoped; if the user is on an unrelated path we
  // still want to render the chrome so the layout does not flash.
  return <PortalSidebar pathname={pathname} showVillas={showVillas} showCartera={showCartera} />;
}
