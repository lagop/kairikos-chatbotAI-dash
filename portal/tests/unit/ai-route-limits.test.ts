// Revisión de seguridad del 22/09/2026 — cupo por cliente en las rutas del
// portal que llaman a la API de Anthropic. Ver src/lib/ai-route-limits.ts.

import { describe, it, expect } from 'vitest';
import { takeAiRequest } from '@/lib/ai-route-limits';

describe('takeAiRequest', () => {
  it('lets a client through up to the scope limit, then refuses', () => {
    const results = Array.from({ length: 11 }, () => takeAiRequest('prospecting_suggest', 'client_limit_a'));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
  });

  it('keeps separate budgets per client and per screen', () => {
    for (let i = 0; i < 10; i += 1) takeAiRequest('prospecting_suggest', 'client_limit_b');
    expect(takeAiRequest('prospecting_suggest', 'client_limit_b')).toBe(false);
    expect(takeAiRequest('prospecting_suggest', 'client_limit_c')).toBe(true);
    expect(takeAiRequest('assistant', 'client_limit_b')).toBe(true);
  });
});
