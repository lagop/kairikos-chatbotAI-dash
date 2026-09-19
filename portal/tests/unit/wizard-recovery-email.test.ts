// =============================================================================
// Fase 4 multi-instancia — el enlace del correo de asistente abandonado.
//
// Con varios chatbots tiene que llevar al asistente del que se quedó parado;
// con uno, el enlace es el de siempre salvo por el id, que la página ignora
// sin daño si sobra.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildRecoveryEmail } from '@/lib/wizard-recovery-email';

const base = {
  clientFirstName: 'Ana',
  lastStepKey: '3',
  lastStepHuman: 'Horario',
  hoursSinceLastDraft: 50,
  portalUrl: 'https://portal.example',
};

describe('buildRecoveryEmail — enlace al asistente', () => {
  it('sin chatbot concreto, el enlace de siempre', () => {
    const { text } = buildRecoveryEmail(base);
    expect(text).toContain('https://portal.example/portal/wizard?step=3 ');
    expect(text).not.toContain('clientProductId');
  });

  it('con chatbot concreto, el enlace lleva a su asistente', () => {
    const { text, html } = buildRecoveryEmail({ ...base, clientProductId: 'cp_b' });
    expect(text).toContain('https://portal.example/portal/wizard?step=3&clientProductId=cp_b');
    // En el HTML el & va escapado dentro del href.
    expect(html).toContain('/portal/wizard?step=3&amp;clientProductId=cp_b');
  });
});
