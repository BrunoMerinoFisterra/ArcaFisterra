import assert from 'node:assert/strict';
import test from 'node:test';
import { crearRepositorioSqlite } from './sqlite.js';
import type { PlanPagoNuevo } from './tipos.js';

const PLAN: PlanPagoNuevo = {
  contribuyenteCuit: '30-71201119-6',
  numero: 'W813337',
  concepto: 'RG 5321 - Plan Deuda General',
  fechaPresentacion: '2026-03-12',
  fechaConsolidacion: '2026-03-12',
  tipoPlan: '1295',
  montoConsolidado: 26_819_949.72,
  estado: 'Aceptada',
  situacion: 'Plan Caduco',
  cuotasTotales: 5,
  cuotasPagas: 0,
  cuotasImpagas: 1,
  montoCuota: 3_815_139.52,
  proximoVencimiento: '2026-04-26',
  totalPagado: 0,
  cuotas: [
    {
      numero: 1,
      variante: 1,
      capital: 3_042_936.45,
      interesFinanciero: 737_548.62,
      interesResarcitorio: 0,
      total: 3_780_485.07,
      fechaVencimiento: '2026-04-16',
      pago: 'Disponible',
      estado: 'Cuota Impaga',
    },
    {
      numero: 1,
      variante: 2,
      capital: 3_042_936.45,
      interesFinanciero: 737_548.62,
      interesResarcitorio: 34_654.45,
      total: 3_815_139.52,
      fechaVencimiento: '2026-04-26',
      pago: 'Disponible',
      estado: 'Cuota Impaga',
    },
  ],
};

test('reemplaza la foto completa de planes y conserva variantes de vencimiento', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    assert.deepEqual(await repo.reemplazarPlanes('c1', [PLAN]), { planes: 1, cuotas: 2 });
    const [guardado] = await repo.planesDe('c1');
    assert.equal(guardado?.numero, 'W813337');
    assert.equal(guardado?.montoConsolidado, 26_819_949.72);
    assert.equal(guardado?.leidoAppEn, null);
    assert.deepEqual(guardado?.cuotas.map((c) => [c.numero, c.variante]), [[1, 1], [1, 2]]);

    const lectura = await repo.actualizarLecturaPlan('c1', guardado!.id, true);
    assert.ok(lectura?.leidoAppEn);

    // La sincronizacion reemplaza ids y cuotas, pero conserva la lectura por
    // el numero estable del plan informado por ARCA.
    await repo.reemplazarPlanes('c1', [{ ...PLAN, estado: 'Actualizada' }]);
    const [actualizado] = await repo.planesDe('c1');
    assert.ok(actualizado?.leidoAppEn);
    assert.equal(actualizado?.estado, 'Actualizada');
    assert.deepEqual(
      await repo.actualizarLecturaPlan('c1', actualizado!.id, false),
      { leidoAppEn: null },
    );

    assert.deepEqual(await repo.reemplazarPlanes('c1', []), { planes: 0, cuotas: 0 });
    assert.deepEqual(await repo.planesDe('c1'), []);
  } finally {
    repo.cerrar();
  }
});
