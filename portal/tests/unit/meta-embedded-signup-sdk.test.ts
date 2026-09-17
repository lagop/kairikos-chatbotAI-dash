// =============================================================================
// lib/meta-embedded-signup-sdk.ts — la versión con la que se inicializa el SDK.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('loadFacebookSdk', () => {
  const init = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    init.mockReset();
    // Un SDK ya cargado: la rama que importa para cambiar de versión.
    (globalThis as unknown as { window: unknown }).window = { FB: { init, login: vi.fn() } };
  });

  it('los clientes siguen en la versión por defecto', async () => {
    const { loadFacebookSdk, DEFAULT_SDK_VERSION } = await import('@/lib/meta-embedded-signup-sdk');
    await loadFacebookSdk('app_1');
    expect(init).toHaveBeenCalledWith({ appId: 'app_1', xfbml: false, version: DEFAULT_SDK_VERSION });
    expect(DEFAULT_SDK_VERSION).toBe('v21.0');
  });

  it('cambiar de versión reinicializa el SDK una sola vez', async () => {
    const { loadFacebookSdk } = await import('@/lib/meta-embedded-signup-sdk');
    await loadFacebookSdk('app_1', 'v26.0');
    await loadFacebookSdk('app_1', 'v26.0');
    expect(init).toHaveBeenCalledTimes(1);
    await loadFacebookSdk('app_1', 'v23.0');
    expect(init).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenLastCalledWith({ appId: 'app_1', xfbml: false, version: 'v23.0' });
  });

  it('la página de prueba ofrece la versión por defecto y usa la elegida', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { SDK_VERSIONS, DEFAULT_SDK_VERSION } = await import('@/lib/meta-embedded-signup-sdk');
    expect(SDK_VERSIONS).toContain(DEFAULT_SDK_VERSION);
    const src = readFileSync(join(process.cwd(), 'src/components/admin/MetaSignupDiagnosticPanel.tsx'), 'utf8');
    expect(src).toContain('loadFacebookSdk(appId, sdkVersion)');
  });
});

describe('loadFacebookSdk cuando el script no carga', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  function fakeDom() {
    const appended: Array<{ id: string; onerror?: () => void; remove: () => void }> = [];
    const existing = { removed: false, remove() { this.removed = true; } };
    (globalThis as unknown as { window: unknown }).window = {};
    (globalThis as unknown as { document: unknown }).document = {
      getElementById: (id: string) => (id === 'facebook-jssdk' ? existing : null),
      createElement: () => ({ remove() {} }),
      body: { appendChild: (el: (typeof appended)[number]) => appended.push(el) },
    };
    return { appended, existing };
  }

  it('falla con SDK_LOAD_BLOCKED si el navegador bloquea el script, y quita el intento anterior', async () => {
    const { appended, existing } = fakeDom();
    const { loadFacebookSdk, SDK_LOAD_BLOCKED, describeSdkLoadError } = await import('@/lib/meta-embedded-signup-sdk');
    const promise = loadFacebookSdk('app_1');
    expect(existing.removed).toBe(true);
    appended[0].onerror?.();
    await expect(promise).rejects.toThrow(SDK_LOAD_BLOCKED);
    await promise.catch((err) => expect(describeSdkLoadError(err)).toMatch(/bloqueador de anuncios/));
  });

  it('falla con SDK_LOAD_TIMEOUT si no carga en 15 s, en vez de quedarse esperando para siempre', async () => {
    fakeDom();
    const { loadFacebookSdk, SDK_LOAD_TIMEOUT } = await import('@/lib/meta-embedded-signup-sdk');
    const promise = loadFacebookSdk('app_1');
    vi.advanceTimersByTime(15_000);
    await expect(promise).rejects.toThrow(SDK_LOAD_TIMEOUT);
    vi.useRealTimers();
  });
});
