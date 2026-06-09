'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

export function PageViewTracker() {
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    const body = JSON.stringify({
      type: 'page_view',
      path: pathname,
      referrer: typeof document !== 'undefined' ? document.referrer || null : null,
      title: typeof document !== 'undefined' ? document.title : null,
      ts: new Date().toISOString(),
    });
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      try {
        navigator.sendBeacon('/api/portal/track', body);
        return;
      } catch {
        // fall through to fetch
      }
    }
    void fetch('/api/portal/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  }, [pathname]);
  return null;
}
