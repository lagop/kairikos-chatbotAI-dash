// =============================================================================
// Guardia de la página de prueba de la ventana de Meta
// (components/admin/MetaSignupDiagnosticPanel.tsx): prueba, no conecta.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/components/admin/MetaSignupDiagnosticPanel.tsx'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('MetaSignupDiagnosticPanel', () => {
  it('abre la ventana de Meta de verdad (si no, este guardia no mira nada)', () => {
    expect(code).toContain('window.FB.login(');
  });

  it('no llama a ninguna ruta del portal: no canjea el code ni guarda conexiones', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain('/api/');
  });

  it('nunca pinta el code de autorización, solo que llegó', () => {
    expect(code).toMatch(/code \? `recibido \(\$\{code\.length\} caracteres/);
    expect(code).not.toMatch(/\{code\}/);
  });

  it('el modo Coexistence usa los mismos extras que el alta real de recall', () => {
    expect(code).toContain('coexistence: COEXISTENCE_SIGNUP_EXTRAS');
  });
});
