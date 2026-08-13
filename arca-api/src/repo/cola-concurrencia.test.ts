import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crearRepositorioSqlite } from './sqlite.js';

/**
 * Exclusion mutua de la cola cuando corren varios workers.
 *
 * Es la garantia de la que depende que no se bloqueen cuentas de clientes: dos
 * workers que tomen el mismo job —o dos jobs distintos de la MISMA cuenta de
 * acceso ARCA— abren dos sesiones simultaneas con la misma clave fiscal, que es
 * justo lo que dispara el bloqueo.
 *
 * Los tests usan un archivo real y no `:memory:` a proposito: cada conexion
 * `:memory:` abre su propia base y aca hace falta que las dos vean la misma,
 * igual que la API y el worker en produccion.
 *
 * Limite conocido: `node:sqlite` es sincrono y Node corre en un solo hilo, asi
 * que las dos llamadas nunca se solapan de verdad. Lo que se verifica es la
 * LOGICA de exclusion —que el segundo worker observe el estado que dejo el
 * primero y se retire— y no la carrera a nivel sistema operativo, que la cubren
 * `BEGIN IMMEDIATE` y el `busy_timeout`.
 */

type Repo = ReturnType<typeof crearRepositorioSqlite>;

const ahora = (): string => new Date().toISOString();
const en = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** Corte del modo historico: nunca debe activarse en estos tests. */
const LEGACY_LEJANO = '2000-01-01T00:00:00.000Z';

const MINUTO = 60_000;

async function conDosWorkers(fn: (a: Repo, b: Repo) => Promise<void>): Promise<void> {
  const carpeta = mkdtempSync(join(tmpdir(), 'arca-cola-'));
  const archivo = join(carpeta, 'cola.db');
  const a = crearRepositorioSqlite({ archivo });
  // El worker nunca siembra: consume la base que ya preparo la API.
  const b = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    await fn(a, b);
  } finally {
    a.cerrar();
    b.cerrar();
    rmSync(carpeta, { recursive: true, force: true });
  }
}

test('un job pendiente lo toma un solo worker', async () => {
  await conDosWorkers(async (a, b) => {
    const encolado = await a.encolarSync('c1', 'mis-comprobantes');

    const tomadoA = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    const tomadoB = await b.tomarProximoJob('worker-b', ahora(), en(MINUTO));

    assert.equal(tomadoA?.id, encolado.id);
    assert.equal(tomadoA?.estado, 'RUNNING');
    assert.equal(tomadoB, null, 'el segundo worker no puede recibir el mismo job');
  });
});

test('el candado serializa dos clientes que comparten la cuenta ARCA', async () => {
  await conDosWorkers(async (a, b) => {
    await a.encolarSync('c1', 'mis-comprobantes');
    await a.encolarSync('c2', 'mis-comprobantes');

    const jobA = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    const jobB = await b.tomarProximoJob('worker-b', ahora(), en(MINUTO));
    assert.ok(jobA);
    assert.ok(jobB);
    assert.notEqual(jobA.id, jobB.id, 'cada worker toma un job distinto');

    // Dos contribuyentes distintos delegados al MISMO usuario ARCA: la clave
    // del candado es el HMAC del CUIT de login, no el del cliente.
    const CUENTA = 'hmac-de-la-cuenta-del-estudio';
    const ganoA = await a.adquirirBloqueoCuenta(jobA.id, 'worker-a', CUENTA, ahora(), en(MINUTO));
    const ganoB = await b.adquirirBloqueoCuenta(jobB.id, 'worker-b', CUENTA, ahora(), en(MINUTO));

    assert.equal(ganoA, true);
    assert.equal(ganoB, false, 'serian dos logins simultaneos con la misma clave fiscal');
  });
});

test('cuentas ARCA distintas sincronizan en paralelo', async () => {
  await conDosWorkers(async (a, b) => {
    await a.encolarSync('c1', 'mis-comprobantes');
    await a.encolarSync('c2', 'mis-comprobantes');

    const jobA = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    const jobB = await b.tomarProximoJob('worker-b', ahora(), en(MINUTO));
    assert.ok(jobA);
    assert.ok(jobB);

    // El candado no debe serializar de mas: son dos estudios distintos.
    assert.equal(
      await a.adquirirBloqueoCuenta(jobA.id, 'worker-a', 'hmac-estudio-uno', ahora(), en(MINUTO)),
      true,
    );
    assert.equal(
      await b.adquirirBloqueoCuenta(jobB.id, 'worker-b', 'hmac-estudio-dos', ahora(), en(MINUTO)),
      true,
    );
  });
});

test('solo el propietario renueva o devuelve su job', async () => {
  await conDosWorkers(async (a, b) => {
    await a.encolarSync('c1', 'mis-comprobantes');
    const job = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    assert.ok(job);

    assert.equal(
      await b.renovarLeaseJob(job.id, 'worker-b', en(MINUTO)),
      false,
      'un worker ajeno no puede extender el lease de un job vivo',
    );
    await assert.rejects(
      () => b.reencolarJob(job.id, 'worker-b', en(1_000), 'intento ajeno'),
      /no es propietario/,
    );

    assert.equal(await a.renovarLeaseJob(job.id, 'worker-a', en(2 * MINUTO)), true);
  });
});

test('reencolar libera el candado y posterga el job', async () => {
  await conDosWorkers(async (a, b) => {
    await a.encolarSync('c1', 'mis-comprobantes');
    const job = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    assert.ok(job);

    const CUENTA = 'hmac-cuenta-ocupada';
    assert.equal(
      await a.adquirirBloqueoCuenta(job.id, 'worker-a', CUENTA, ahora(), en(MINUTO)),
      true,
    );

    await a.reencolarJob(job.id, 'worker-a', en(30_000), 'Esperando otra sincronizacion');

    // Vuelve a PENDING, pero nadie lo toma hasta que llegue su turno.
    assert.equal(
      await b.tomarProximoJob('worker-b', ahora(), en(MINUTO)),
      null,
      'disponible_desde tiene que frenar el reintento inmediato',
    );

    const reintento = await b.tomarProximoJob('worker-b', en(31_000), en(91_000));
    assert.equal(reintento?.id, job.id);

    // Y el candado quedo libre para el nuevo propietario.
    assert.equal(
      await b.adquirirBloqueoCuenta(job.id, 'worker-b', CUENTA, en(31_000), en(91_000)),
      true,
    );
  });
});

test('la recuperacion respeta los leases vivos y limpia los vencidos', async () => {
  await conDosWorkers(async (a, b) => {
    await a.encolarSync('c1', 'mis-comprobantes');
    const job = await a.tomarProximoJob('worker-a', ahora(), en(MINUTO));
    assert.ok(job);
    const CUENTA = 'hmac-cuenta-del-caido';
    await a.adquirirBloqueoCuenta(job.id, 'worker-a', CUENTA, ahora(), en(MINUTO));

    // Otro worker arranca mientras el primero sigue trabajando: no lo toca.
    assert.equal(await b.recuperarJobsInterrumpidos(ahora(), LEGACY_LEJANO), 0);
    assert.equal((await b.jobsDe('c1'))[0]?.estado, 'RUNNING');

    // Vencido el lease sin heartbeat, el job se cierra.
    assert.equal(await b.recuperarJobsInterrumpidos(en(61_000), LEGACY_LEJANO), 1);
    assert.equal((await b.jobsDe('c1'))[0]?.estado, 'ERROR');

    // Y el candado no puede sobrevivir al job que lo tomo: si sobreviviera,
    // esa cuenta ARCA quedaria inutilizable hasta que alguien la destrabe.
    await a.encolarSync('c2', 'mis-comprobantes');
    const siguiente = await b.tomarProximoJob('worker-b', en(61_000), en(121_000));
    assert.ok(siguiente);
    assert.equal(
      await b.adquirirBloqueoCuenta(siguiente.id, 'worker-b', CUENTA, en(61_000), en(121_000)),
      true,
    );
  });
});
