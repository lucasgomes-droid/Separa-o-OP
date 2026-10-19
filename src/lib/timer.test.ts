import { test, expect } from 'vitest';
import { calc, fmt, OpEvent } from './timer';
const t = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime();
test('exemplo do enunciado: 10h30 → 13h com pausa 11h–12h = 01:30:00', () => {
  const ev: OpEvent[] = [
    { id: '1', type: 'INICIO', at: t(10, 30) }, { id: '2', type: 'PAUSA', at: t(11, 0) },
    { id: '3', type: 'RETOMADA', at: t(12, 0) }, { id: '4', type: 'FINALIZACAO', at: t(13, 0) }];
  const r = calc(ev, t(23, 0));
  expect(fmt(r.efetivo)).toBe('01:30:00'); expect(r.pausado).toBe(3600); expect(r.pausas).toBe(1);
});
test('pausada: tempo congelado; múltiplas pausas', () => {
  const ev: OpEvent[] = [
    { id: '1', type: 'INICIO', at: t(8, 0) }, { id: '2', type: 'PAUSA', at: t(8, 10) },
    { id: '3', type: 'RETOMADA', at: t(8, 20) }, { id: '4', type: 'PAUSA', at: t(8, 50) }];
  expect(calc(ev, t(15, 0)).efetivo).toBe(40 * 60);
  expect(calc(ev, t(15, 0)).pausas).toBe(2);
});
import { kgPorHora } from './csv';
test('kg por hora usa só o tempo efetivo', () => {
  expect(kgPorHora(1000, 7200)).toBe(500);
  expect(kgPorHora(1000, 0)).toBe(0);
});
