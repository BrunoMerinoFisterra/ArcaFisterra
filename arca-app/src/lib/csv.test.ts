import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armarCsv } from './csv.js';

/**
 * Lo que se prueba acá es lo que rompe en silencio: un CSV mal escapado no
 * falla, se abre igual y muestra los datos corridos de columna. El contador lo
 * descubre sumando mal una declaración.
 */

test('separa con ; y escribe los decimales con coma', () => {
  const csv = armarCsv(['impuesto', 'saldo'], [['IVA', -1_284_500.35]]);
  const lineas = csv.replace(/^﻿/, '').trimEnd().split('\r\n');

  assert.equal(lineas[0], 'impuesto;saldo');
  // Coma decimal: con punto, Excel en español lo toma como texto y no suma.
  assert.equal(lineas[1], 'IVA;-1284500,35');
});

test('encierra entre comillas lo que llevaría el separador adentro', () => {
  const csv = armarCsv(
    ['razon', 'nota'],
    [['TRANSPORTE "EL RAPIDO" S.A.', 'IVA; Ganancias'], ['Con\nsalto', 'ok']],
  );
  const cuerpo = csv.replace(/^﻿/, '');

  // Comillas internas duplicadas, que es como las espera el formato.
  assert.ok(cuerpo.includes('"TRANSPORTE ""EL RAPIDO"" S.A."'));
  // Un punto y coma dentro del dato no puede partir la celda.
  assert.ok(cuerpo.includes('"IVA; Ganancias"'));
  assert.ok(cuerpo.includes('"Con\nsalto"'));
});

test('arranca con BOM para que Excel muestre bien los acentos', () => {
  const csv = armarCsv(['descripcion'], [['Notificación']]);
  assert.ok(csv.startsWith('﻿'), 'sin BOM, Excel muestra Notificaci├│n');
  assert.ok(csv.includes('Notificación'));
});

test('los vacíos quedan vacíos, no como "null" ni "undefined"', () => {
  const csv = armarCsv(['a', 'b', 'c'], [[null, undefined, 0]]);
  const fila = csv.replace(/^﻿/, '').trimEnd().split('\r\n')[1];
  assert.equal(fila, ';;0');
});
