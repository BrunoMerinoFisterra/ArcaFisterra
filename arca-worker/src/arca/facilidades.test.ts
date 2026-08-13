import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aFechaIso,
  aNumeroArca,
  construirPlan,
  esBloqueoTemporalFacilidades,
} from './facilidades.js';

test('convierte importes y fechas con el formato argentino de ARCA', () => {
  assert.equal(aNumeroArca('$ 30.786.156,17'), 30_786_156.17);
  assert.equal(aNumeroArca('0,00'), 0);
  assert.equal(aFechaIso('04/08/2026'), '2026-08-04');
  assert.equal(aFechaIso('sin fecha'), null);
});

test('conserva dos vencimientos de la misma cuota y cuenta una sola impaga', () => {
  const plan = construirPlan({
    fechaPresentacion: '2026-03-12',
    numero: 'W813337',
    cuotasTotales: 5,
    concepto: 'RG 5321 - Plan Deuda General',
    montoConsolidado: 26_819_949.72,
    estado: 'Aceptada',
    situacion: 'Plan Caduco',
    botonId: 'detalle-0',
    fechaConsolidacion: '2026-03-12',
    tipoPlan: '1295',
    totalPagado: 0,
    cuotas: [
      { numero: 1, variante: 1, capital: 100, interesFinanciero: 10, interesResarcitorio: 0, total: 110, fechaVencimiento: '2026-04-16', pago: 'Disponible', estado: 'Cuota Impaga' },
      { numero: 1, variante: 2, capital: 100, interesFinanciero: 10, interesResarcitorio: 5, total: 115, fechaVencimiento: '2026-04-26', pago: 'Disponible', estado: 'Cuota Impaga' },
      { numero: 2, variante: 1, capital: 100, interesFinanciero: 8, interesResarcitorio: 0, total: 108, fechaVencimiento: '2026-05-16', pago: 'Pago', estado: 'Cuota Cancelada' },
    ],
  });

  assert.equal(plan.cuotasImpagas, 1);
  assert.equal(plan.cuotasPagas, 1);
  assert.equal(plan.cuotas.length, 3);
});

test('reconoce la respuesta BL temporal de Mis Facilidades sin confundir una pantalla normal', () => {
  assert.equal(
    esBloqueoTemporalFacilidades(
      'BL1824590010486 2026-08-10 12:36:54 2026-08-10 12:36:54',
    ),
    true,
  );
  assert.equal(esBloqueoTemporalFacilidades('Presentaciones Enviadas'), false);
});
