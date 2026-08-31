import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConfigSyncNocturna } from './config.js';
import { crearRepositorioMemoria } from './repo/memoria.js';
import { crearRepositorioSqlite } from './repo/sqlite.js';
import type { Repositorio } from './repo/tipos.js';
import { estaEnVentana, horaEnBuenosAires, pasadaNocturna } from './sync-nocturna.js';

/**
 * Sincronización nocturna.
 *
 * Lo que hay que probar de verdad no es que encole: es que NO encole de más.
 * Un planificador que reintenta contra una credencial mala, o que reencola al
 * mismo cliente cada vuelta de la ventana, termina bloqueando la cuenta ARCA
 * del contribuyente — que es la falla que todo este sistema evita.
 */

const CONFIG: ConfigSyncNocturna = {
  activa: true,
  horaDesde: 2,
  horaHasta: 5,
  minimoHorasEntreIntentos: 12,
  intervaloMinutos: 15,
};

const MOTORES: Array<[string, () => Promise<Repositorio>]> = [
  ['memoria', () => crearRepositorioMemoria()],
  ['sqlite', async () => crearRepositorioSqlite({ archivo: ':memory:' })],
];

/** Instantes fijos, para probar la conversión de huso. 06:00 UTC = 03:00 en AR. */
const aLasTresDeLaMadrugada = new Date('2026-08-27T06:00:00Z');
const aLasTresDeLaTarde = new Date('2026-08-27T18:00:00Z');

/**
 * Los clientes de la semilla tienen `ultimo_sync` de hace pocas horas, así que
 * el corte de 12 h los deja afuera — que es justo lo que debe pasar. Para
 * probar el encolado hay que pararse unos días después.
 */
const unasNochesDespues = new Date(Date.now() + 3 * 86_400_000);

describe('ventana horaria', () => {
  test('usa la hora de Buenos Aires, no la del contenedor', () => {
    // 06:00 UTC son las 03:00 en Buenos Aires. Si el cálculo usara UTC, esto
    // daría 6 y la ventana nocturna se correría tres horas.
    assert.equal(horaEnBuenosAires(aLasTresDeLaMadrugada), 3);
    assert.equal(horaEnBuenosAires(aLasTresDeLaTarde), 15);
  });

  test('sólo entra dentro de la franja configurada', () => {
    assert.equal(estaEnVentana(CONFIG, aLasTresDeLaMadrugada), true);
    assert.equal(estaEnVentana(CONFIG, aLasTresDeLaTarde), false);
    // Límites: desde es inclusive, hasta es exclusive.
    assert.equal(estaEnVentana(CONFIG, new Date('2026-08-27T05:00:00Z')), true); // 02:00
    assert.equal(estaEnVentana(CONFIG, new Date('2026-08-27T08:00:00Z')), false); // 05:00
  });
});

for (const [motor, crearRepo] of MOTORES) {
  describe(`pasada nocturna sobre ${motor}`, () => {
    test('encola una sola vez aunque la ventana pase varias veces', async () => {
      const repo = await crearRepo();
      try {
        const primera = await pasadaNocturna(repo, CONFIG, unasNochesDespues);
        assert.ok(primera.total > 0, 'la semilla tiene clientes con credencial OK');
        assert.equal(primera.encolados, primera.total);

        // Segunda vuelta de la misma noche: los jobs siguen activos, así que
        // `encolarSync` devuelve los mismos y no se crea ninguno nuevo.
        const segunda = await pasadaNocturna(repo, CONFIG, unasNochesDespues);
        assert.equal(segunda.encolados, 0);

        // Y no quedaron jobs duplicados por cliente.
        for (const cliente of await repo.clientesParaSyncAutomatica(
          unasNochesDespues.toISOString(),
        )) {
          const activos = (await repo.jobsDe(cliente.id)).filter((job) =>
            ['PENDING', 'RUNNING'].includes(job.estado),
          );
          assert.equal(activos.length, 1, `un solo job activo para ${cliente.razonSocial}`);
        }
      } finally {
        (repo as { cerrar?: () => void }).cerrar?.();
      }
    });

    test('no toca un cliente cuya credencial ya se sabe mala', async () => {
      const repo = await crearRepo();
      try {
        const antes = await repo.clientesParaSyncAutomatica(unasNochesDespues.toISOString());
        const victima = antes[0];
        assert.ok(victima);

        // Así queda un cliente cuando el worker choca con una clave incorrecta.
        const job = await repo.encolarSync(victima.id, 'sincronizacion-completa');
        await repo.tomarProximoJob('worker-test', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
        await repo.finalizarJob(
          job.id,
          { estado: 'ERROR', detalle: 'clave incorrecta', estadoCredencial: 'INVALIDA' },
          'worker-test',
        );

        const despues = await repo.clientesParaSyncAutomatica(unasNochesDespues.toISOString());
        assert.ok(
          !despues.some((cliente) => cliente.id === victima.id),
          'un cliente con credencial INVALIDA no se reintenta de noche',
        );
      } finally {
        (repo as { cerrar?: () => void }).cerrar?.();
      }
    });

    test('un intento fallido no se reencola la misma noche', async () => {
      const repo = await crearRepo();
      try {
        const pendientes = await repo.clientesParaSyncAutomatica(unasNochesDespues.toISOString());
        const cliente = pendientes[0];
        assert.ok(cliente);

        const job = await repo.encolarSync(cliente.id, 'sincronizacion-completa');
        await repo.tomarProximoJob('worker-test', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
        // Falla SIN marcar la credencial: el portal no respondió, por ejemplo.
        await repo.finalizarJob(job.id, { estado: 'ERROR', detalle: 'timeout' }, 'worker-test');

        // `finalizarJob` actualizó ultimo_sync igual, así que el corte de 12 h
        // lo deja afuera. Sin eso, la ventana lo reintentaría cada 15 minutos.
        const corte = new Date(Date.now() - CONFIG.minimoHorasEntreIntentos * 3_600_000).toISOString();
        const candidatos = await repo.clientesParaSyncAutomatica(corte);
        assert.ok(
          !candidatos.some((c) => c.id === cliente.id),
          'un fallo reciente no vuelve a la cola hasta pasado el mínimo',
        );
      } finally {
        (repo as { cerrar?: () => void }).cerrar?.();
      }
    });
  });
}
