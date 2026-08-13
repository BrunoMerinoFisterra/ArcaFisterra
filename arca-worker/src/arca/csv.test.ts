import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { extraerTextoCsv, parsearComprobantesCsv } from './csv.js';

const CABECERA = [
  'Fecha de Emisión',
  'Tipo de Comprobante',
  'Punto de Venta',
  'Número Desde',
  'Denominación Emisor',
  'Nro. Doc. Emisor',
  'Denominación Receptor',
  'Nro. Doc. Receptor',
  'Imp. Neto Gravado Total',
  'Total IVA',
  'Imp. Total',
].map((x) => `"${x}"`).join(';');

const FILA =
  '2026-08-01;3;2;16724;"Proveedor; del Sur";30712345671;Cliente;20123456789;1000,50;210,11;1210,61';

test('parsea el CSV y vuelve negativos los importes de notas de credito', () => {
  const [comprobante] = parsearComprobantesCsv(`${CABECERA}\n${FILA}\n`, 'RECIBIDO');
  assert.ok(comprobante);
  assert.equal(comprobante.codigoComprobante, 3);
  assert.equal(comprobante.tipoComprobante, 'Nota de Crédito A');
  assert.equal(comprobante.contraparte, 'Proveedor; del Sur');
  assert.equal(comprobante.cuitContraparte, '30-71234567-1');
  assert.equal(comprobante.neto, -1000.5);
  assert.equal(comprobante.iva, -210.11);
  assert.equal(comprobante.total, -1210.61);
});

test('extrae el CSV cuando ARCA lo entrega dentro de un ZIP', () => {
  const csv = Buffer.from(`${CABECERA}\n${FILA}\n`, 'utf8');
  const zip = zipMinimo(csv, 'comprobantes.csv');
  assert.equal(extraerTextoCsv(zip), csv.toString('utf8'));
});

function zipMinimo(contenido: Buffer, nombre: string): Buffer {
  const nombreBytes = Buffer.from(nombre, 'utf8');
  const comprimido = deflateRawSync(contenido);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comprimido.length, 18);
  local.writeUInt32LE(contenido.length, 22);
  local.writeUInt16LE(nombreBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comprimido.length, 20);
  central.writeUInt32LE(contenido.length, 24);
  central.writeUInt16LE(nombreBytes.length, 28);

  const offsetCentral = local.length + nombreBytes.length + comprimido.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nombreBytes.length, 12);
  eocd.writeUInt32LE(offsetCentral, 16);

  return Buffer.concat([local, nombreBytes, comprimido, central, nombreBytes, eocd]);
}
