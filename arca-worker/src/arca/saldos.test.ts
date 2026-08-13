import assert from 'node:assert/strict';
import test from 'node:test';
import { ddjjDesdeCeldas, periodoArca, saldoDesdeCeldas, vencimientoDesdeCeldas } from './saldos.js';

test('convierte una obligación de Cuentas Tributarias sin perder anticipo ni intereses', () => {
  const saldo = saldoDesdeCeldas([
    '',
    '0',
    '',
    '10 - GANANCIAS SOCIEDADES',
    '191 - ANTICIPOS',
    '191 - ANTICIPOS',
    '2026',
    '6',
    '14/08/2026',
    '$ 508.257,86',
    '$ 12.345,67',
    '$ 0,00',
  ]);
  assert.deepEqual(saldo, {
    establecimiento: '0',
    impuesto: '10 - GANANCIAS SOCIEDADES',
    concepto: '191 - ANTICIPOS',
    subconcepto: '191 - ANTICIPOS',
    periodo: '2026',
    anticipoCuota: '6',
    fechaVencimiento: '2026-08-14',
    saldo: -508_257.86,
    interesResarcitorio: -12_345.67,
    interesPunitorio: 0,
  });
});

test('normaliza períodos mensuales de seis u ocho posiciones', () => {
  assert.equal(periodoArca('202605'), '05/2026');
  assert.equal(periodoArca('20260700'), '07/2026');
  assert.equal(periodoArca('20270000'), '2027');
  assert.equal(periodoArca('2026'), '2026');
});

test('convierte una fila de la primera pestaña en un vencimiento detallado', () => {
  const vencimiento = vencimientoDesdeCeldas([
    '301 - SUSS',
    '19 - DECLARACIÓN JURADA',
    '19 - DECLARACIÓN JURADA',
    '20260700',
    '0',
    '10/08/2026',
    'Presentación y Pago',
  ]);
  assert.deepEqual(vencimiento, {
    impuesto: '301 - SUSS',
    concepto: '19 - DECLARACIÓN JURADA',
    subconcepto: '19 - DECLARACIÓN JURADA',
    periodo: '07/2026',
    anticipoCuota: '0',
    fecha: '2026-08-10',
    detalle: 'Presentación y Pago',
  });
});

test('convierte una DDJJ pendiente sin inventar fecha cuando ARCA no la informa', () => {
  const declaracion = ddjjDesdeCeldas([
    '0',
    '10 - GANANCIAS SOCIEDADES',
    '19 - DECLARACIÓN JURADA',
    '19 - DECLARACIÓN JURADA',
    '2023',
  ]);
  assert.deepEqual(declaracion, {
    establecimiento: '0',
    impuesto: '10 - GANANCIAS SOCIEDADES',
    concepto: '19 - DECLARACIÓN JURADA',
    subconcepto: '19 - DECLARACIÓN JURADA',
    periodo: '2023',
    fecha: null,
  });
});
