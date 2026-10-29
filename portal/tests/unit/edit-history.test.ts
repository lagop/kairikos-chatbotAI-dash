// Deshacer y rehacer en el editor de la web (29/10/2026).
import { describe, expect, it } from 'vitest';
import { COALESCE_MS, HISTORY_MAX, emptyHistory, historyCommand, recordStep, redoStep, undoStep } from '@/components/portal/edit-history';

describe('el historial del editor', () => {
  it('deshace y rehace en orden', () => {
    let h = emptyHistory<string>();
    h = recordStep(h, 'a', null, 0);
    h = recordStep(h, 'b', null, 10);
    const u1 = undoStep(h, 'c')!;
    expect(u1.value).toBe('b');
    const u2 = undoStep(u1.history, u1.value)!;
    expect(u2.value).toBe('a');
    expect(undoStep(u2.history, u2.value)).toBeNull();
    const r1 = redoStep(u2.history, u2.value)!;
    expect(r1.value).toBe('b');
    const r2 = redoStep(r1.history, r1.value)!;
    expect(r2.value).toBe('c');
    expect(redoStep(r2.history, r2.value)).toBeNull();
  });

  it('lo que se escribe seguido en el mismo campo es un solo paso', () => {
    let h = emptyHistory<string>();
    h = recordStep(h, '', 'titular', 0);
    h = recordStep(h, 'H', 'titular', 200);
    h = recordStep(h, 'Ho', 'titular', 400);
    expect(h.past).toEqual(['']);
    // Otro campo, o una pausa larga, abre paso.
    h = recordStep(h, 'Hol', 'subtitulo', 500);
    h = recordStep(h, 'Hola', 'subtitulo', 500 + COALESCE_MS + 1);
    expect(h.past).toEqual(['', 'Hol', 'Hola']);
  });

  it('un clic nunca se junta con nada', () => {
    let h = emptyHistory<string>();
    h = recordStep(h, 'a', null, 0);
    h = recordStep(h, 'b', null, 1);
    expect(h.past).toEqual(['a', 'b']);
  });

  it('después de deshacer, un cambio nuevo no se junta con lo de antes y borra lo que se podía rehacer', () => {
    let h = emptyHistory<string>();
    h = recordStep(h, 'a', 'x', 0);
    const u = undoStep(h, 'ab')!;
    h = recordStep(u.history, u.value, 'x', 100);
    expect(h.past).toEqual(['a']);
    expect(h.future).toEqual([]);
  });

  it(`guarda como mucho ${HISTORY_MAX} pasos, los últimos`, () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_MAX + 20; i++) h = recordStep(h, i, null, i);
    expect(h.past).toHaveLength(HISTORY_MAX);
    expect(h.past[0]).toBe(20);
  });
});

describe('los atajos', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    historyCommand({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it('Ctrl/⌘+Z deshace; con Mayús, o Ctrl+Y, rehace', () => {
    expect(k('z', { ctrlKey: true })).toBe('deshacer');
    expect(k('z', { metaKey: true })).toBe('deshacer');
    expect(k('Z', { ctrlKey: true, shiftKey: true })).toBe('rehacer');
    expect(k('Z', { metaKey: true, shiftKey: true })).toBe('rehacer');
    expect(k('y', { ctrlKey: true })).toBe('rehacer');
  });

  it('lo demás no es un atajo', () => {
    expect(k('z')).toBeNull();
    expect(k('z', { ctrlKey: true, altKey: true })).toBeNull();
    expect(k('y', { metaKey: true })).toBeNull();
    expect(k('s', { ctrlKey: true })).toBeNull();
  });
});
