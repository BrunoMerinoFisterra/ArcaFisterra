import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cargarRango,
  fechaArgentinaIso,
  partirRangoParaArca,
  rangoAnioCalendarioArgentina,
} from './config.js';

test('calcula hoy con el cambio de dia de America/Buenos_Aires', () => {
  assert.equal(fechaArgentinaIso(new Date('2026-01-01T02:59:59Z')), '2025-12-31');
  assert.equal(fechaArgentinaIso(new Date('2026-01-01T03:00:00Z')), '2026-01-01');
});

test('el rango por defecto cubre el anio calendario argentino hasta hoy', () => {
  assert.deepEqual(
    cargarRango({}, new Date('2026-08-05T01:30:00Z')),
    { desde: '2026-01-01', hasta: '2026-08-04' },
  );
  assert.deepEqual(
    rangoAnioCalendarioArgentina(new Date('2026-08-05T03:00:00Z')),
    { desde: '2026-01-01', hasta: '2026-08-05' },
  );
});

test('conserva el rango explicito de SYNC_DESDE y SYNC_HASTA', () => {
  assert.deepEqual(
    cargarRango({ SYNC_DESDE: '2026-02-01', SYNC_HASTA: '2026-02-28' }),
    { desde: '2026-02-01', hasta: '2026-02-28' },
  );
  assert.throws(
    () => cargarRango({ SYNC_DESDE: '2026-02-01' }),
    /se configuran juntos/,
  );
  assert.throws(
    () => cargarRango({ SYNC_DESDE: '2026-02-31', SYNC_HASTA: '2026-03-01' }),
    /formato YYYY-MM-DD/,
  );
  assert.deepEqual(
    cargarRango({ SYNC_DESDE: '2024-01-01', SYNC_HASTA: '2024-12-31' }),
    { desde: '2024-01-01', hasta: '2024-12-31' },
  );
});

test('un anio comun completo entra en una sola ventana de ARCA', () => {
  assert.deepEqual(
    partirRangoParaArca({ desde: '2026-01-01', hasta: '2026-12-31' }),
    [{ desde: '2026-01-01', hasta: '2026-12-31' }],
  );
});

test('parte un anio bisiesto completo sin perder ni repetir el ultimo dia', () => {
  assert.deepEqual(
    partirRangoParaArca({ desde: '2024-01-01', hasta: '2024-12-31' }),
    [
      { desde: '2024-01-01', hasta: '2024-12-30' },
      { desde: '2024-12-31', hasta: '2024-12-31' },
    ],
  );
});

test('rechaza rangos invertidos y limites invalidos', () => {
  assert.throws(
    () => partirRangoParaArca({ desde: '2026-02-02', hasta: '2026-02-01' }),
    /no puede ser posterior/,
  );
  assert.throws(
    () => partirRangoParaArca({ desde: '2026-01-01', hasta: '2026-01-02' }, 0),
    /entero positivo/,
  );
});
