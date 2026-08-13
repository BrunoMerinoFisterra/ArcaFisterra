import assert from 'node:assert/strict';
import test from 'node:test';
import { crearRepositorioSqlite } from './sqlite.js';
import type { SaldoTributarioNuevo, VencimientoNuevo } from './tipos.js';

const SALDOS: SaldoTributarioNuevo[] = [
  {
    contribuyenteCuit: '30-71234567-1',
    establecimiento: '0',
    impuesto: '10 - GANANCIAS SOCIEDADES',
    concepto: '191 - ANTICIPOS',
    subconcepto: '191 - ANTICIPOS',
    periodo: '2026',
    anticipoCuota: '6',
    fechaVencimiento: '2026-08-14',
    saldo: -508_257.86,
    interesResarcitorio: 0,
    interesPunitorio: 0,
  },
  {
    contribuyenteCuit: '30-71234567-1',
    establecimiento: '0',
    impuesto: '10 - GANANCIAS SOCIEDADES',
    concepto: '191 - ANTICIPOS',
    subconcepto: '191 - ANTICIPOS',
    periodo: '2026',
    anticipoCuota: '7',
    fechaVencimiento: '2026-09-15',
    saldo: -508_257.86,
    interesResarcitorio: -1_200,
    interesPunitorio: 0,
  },
];

test('reemplaza la foto de saldos y conserva anticipos del mismo impuesto y período', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    assert.equal(await repo.reemplazarSaldos('c1', SALDOS), 2);
    const guardados = await repo.saldosDe('c1');
    assert.equal(guardados.length, 2);
    assert.deepEqual(guardados.map((saldo) => saldo.anticipoCuota), ['6', '7']);
    assert.equal(guardados[1]?.interesResarcitorio, -1_200);

    assert.equal(await repo.reemplazarSaldos('c1', []), 0);
    assert.deepEqual(await repo.saldosDe('c1'), []);
  } finally {
    repo.cerrar();
  }
});

test('reemplaza vencimientos y conserva distintas cuotas del mismo impuesto', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  const vencimientos: VencimientoNuevo[] = [
    {
      contribuyenteCuit: '30-71234567-1',
      impuesto: '10 - GANANCIAS SOCIEDADES',
      concepto: '191 - ANTICIPOS',
      subconcepto: '191 - ANTICIPOS',
      periodo: '2027',
      anticipoCuota: '1',
      fecha: '2026-07-13',
      detalle: 'PAGO',
    },
    {
      contribuyenteCuit: '30-71234567-1',
      impuesto: '10 - GANANCIAS SOCIEDADES',
      concepto: '191 - ANTICIPOS',
      subconcepto: '191 - ANTICIPOS',
      periodo: '2027',
      anticipoCuota: '2',
      fecha: '2026-08-13',
      detalle: 'PAGO',
    },
  ];
  try {
    assert.equal(await repo.reemplazarVencimientos('c1', vencimientos), 2);
    const guardados = await repo.vencimientosDe('c1');
    assert.deepEqual(guardados.map((vencimiento) => vencimiento.anticipoCuota), ['1', '2']);
    assert.equal(guardados[1]?.detalle, 'PAGO');
  } finally {
    repo.cerrar();
  }
});

test('conserva obligaciones idénticas cuando pertenecen a CUIT delegados distintos', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    const base = SALDOS[0]!;
    await repo.reemplazarSaldos('c1', [
      base,
      { ...base, contribuyenteCuit: '30-70968172-5' },
    ]);
    const guardados = await repo.saldosDe('c1');
    assert.equal(guardados.length, 2);
    assert.deepEqual(
      guardados.map((saldo) => saldo.contribuyenteCuit).sort(),
      ['30-70968172-5', '30-71234567-1'],
    );
  } finally {
    repo.cerrar();
  }
});

test('reemplaza DDJJ pendientes y conserva el CUIT representado', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    await repo.reemplazarDdjjPendientes('c1', [
      {
        contribuyenteCuit: '30-70968172-5',
        establecimiento: '0',
        impuesto: '10 - GANANCIAS SOCIEDADES',
        concepto: '19 - DECLARACION JURADA',
        subconcepto: '19 - DECLARACION JURADA',
        periodo: '2023',
        fecha: null,
      },
    ]);
    const [guardada] = await repo.ddjjPendientesDe('c1');
    assert.equal(guardada?.contribuyenteCuit, '30-70968172-5');
    assert.equal(guardada?.periodo, '2023');
  } finally {
    repo.cerrar();
  }
});
