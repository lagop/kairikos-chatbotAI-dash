import { describe, expect, it } from 'vitest';
import { villaStartsOpen, villaSyncSummary } from '@/lib/villas/panel-summary';
import { pendingBadgeText } from '@/lib/villas/panel-tabs';

const ok = (label: string) => ({ label, lastStatus: 'ok' });
const error = (label: string) => ({ label, lastStatus: 'error' });
const unread = (label: string) => ({ label, lastStatus: null });

describe('resumen de sincronización de una villa plegada', () => {
  it('sin calendarios lo dice, sin alarmar', () => {
    expect(villaSyncSummary([])).toEqual({ tone: 'muted', text: 'Sin calendarios conectados' });
  });

  it('todos leídos: cuenta, en singular y en plural', () => {
    expect(villaSyncSummary([ok('Airbnb')])).toEqual({ tone: 'ok', text: '1 calendario al día' });
    expect(villaSyncSummary([ok('Airbnb'), ok('Booking')])).toEqual({ tone: 'ok', text: '2 calendarios al día' });
  });

  it('un error manda sobre los que van bien y sobre los sin leer, y nombra cuál', () => {
    expect(villaSyncSummary([ok('Airbnb'), error('Booking'), unread('Vrbo')])).toEqual({ tone: 'danger', text: 'Error al leer Booking' });
    expect(villaSyncSummary([error('Airbnb'), error('Booking')]).text).toBe('Error al leer Airbnb, Booking');
  });

  it('alguno sin leer todavía no cuenta como «al día»', () => {
    expect(villaSyncSummary([ok('Airbnb'), unread('Booking')])).toEqual({ tone: 'muted', text: 'Calendarios sin leer todavía' });
  });
});

describe('qué villas empiezan abiertas', () => {
  it('la única villa empieza abierta', () => {
    expect(villaStartsOpen(1, [])).toBe(true);
  });

  it('con varias empiezan cerradas, salvo la que tiene un calendario fallando', () => {
    expect(villaStartsOpen(3, [ok('Airbnb')])).toBe(false);
    expect(villaStartsOpen(3, [])).toBe(false);
    expect(villaStartsOpen(3, [ok('Airbnb'), error('Booking')])).toBe(true);
  });
});

describe('contador de pendientes en la pestaña', () => {
  it('hasta 9 enseña el número; a partir de 10, «9+»', () => {
    expect(pendingBadgeText(1)).toBe('1');
    expect(pendingBadgeText(9)).toBe('9');
    expect(pendingBadgeText(10)).toBe('9+');
    expect(pendingBadgeText(137)).toBe('9+');
  });
});
