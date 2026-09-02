import assert from 'node:assert/strict';
import test from 'node:test';
import { crearRepositorioSqlite } from './sqlite.js';

test('actualiza notificaciones por id de comunicación sin duplicarlas', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    const inicial = {
      contribuyenteCuit: '30-71234567-1',
      idComunicacion: '659513833',
      fecha: '2026-07-06',
      organismo: 'ARCA',
      asunto: 'Sistema de Cuentas Tributarias',
      leida: false,
    };
    assert.deepEqual(await repo.guardarNotificaciones('c1', [inicial]), {
      insertadas: 1,
      actualizadas: 0,
    });
    assert.deepEqual(await repo.guardarNotificaciones('c1', [{ ...inicial, leida: true }]), {
      insertadas: 0,
      actualizadas: 1,
    });

    const guardadas = (await repo.notificacionesDe('c1')).filter(
      (notificacion) => notificacion.idComunicacion === inicial.idComunicacion,
    );
    assert.equal(guardadas.length, 1);
    assert.equal(guardadas[0]?.leida, true);
  } finally {
    repo.cerrar();
  }
});

test('conserva por separado lectura ARCA, vista local, cuerpo y adjuntos', async () => {
  const repo = crearRepositorioSqlite({ archivo: ':memory:' });
  try {
    const base = {
      contribuyenteCuit: '30-71234567-1',
      idComunicacion: 'DFE-DETALLE-1',
      fecha: '2026-08-05',
      organismo: 'ARCA',
      asunto: 'Comunicación de prueba',
      leida: false,
    };
    await repo.guardarNotificaciones('c1', [base]);
    let [guardada] = (await repo.notificacionesDe('c1')).filter(
      (notificacion) => notificacion.idComunicacion === base.idComunicacion,
    );
    assert.equal(guardada?.estado, 'SIN_LEER');
    assert.equal(guardada?.leidoAppEn, null);
    assert.equal(guardada?.cuerpo, null);

    const lectura = await repo.actualizarLecturaNotificacion('c1', guardada!.id, true);
    assert.ok(lectura?.leidoAppEn);
    [guardada] = (await repo.notificacionesDe('c1')).filter(
      (notificacion) => notificacion.idComunicacion === base.idComunicacion,
    );
    assert.ok(guardada?.leidoAppEn);
    assert.deepEqual(
      await repo.actualizarLecturaNotificacion('c1', guardada!.id, false),
      { leidoAppEn: null },
    );

    guardada = await repo.marcarNotificacionVista('c1', guardada!.id) ?? undefined;
    assert.equal(guardada?.estado, 'VISTA');
    const primeraVista = guardada?.vistaAppEn;
    assert.ok(primeraVista);
    assert.equal((await repo.marcarNotificacionVista('c1', guardada!.id))?.vistaAppEn, primeraVista);

    const contenido = new TextEncoder().encode('archivo fiscal');
    await repo.guardarNotificaciones('c1', [{
      ...base,
      leida: true,
      detalle: {
        cuerpo: 'Contenido de la comunicación',
        adjuntos: [{
          idArchivo: '625634070',
          nombre: 'intimacion.pdf',
          mimeType: 'application/pdf',
          tamano: contenido.byteLength,
          sha256: 'sha-prueba',
          contenido,
        }],
      },
    }]);
    [guardada] = (await repo.notificacionesDe('c1')).filter(
      (notificacion) => notificacion.idComunicacion === base.idComunicacion,
    );
    assert.equal(guardada?.estado, 'LEIDA');
    assert.equal(guardada?.vistaAppEn, primeraVista);
    assert.equal(guardada?.cuerpo, 'Contenido de la comunicación');
    assert.equal(guardada?.adjuntos.length, 1);

    const adjunto = await repo.adjuntoNotificacionDe(
      'c1',
      guardada!.id,
      guardada!.adjuntos[0]!.id,
    );
    assert.equal(adjunto?.nombre, 'intimacion.pdf');
    assert.deepEqual(adjunto?.contenido, contenido);
    assert.equal(
      await repo.adjuntoNotificacionDe('c2', guardada!.id, guardada!.adjuntos[0]!.id),
      null,
    );

    // Una foto posterior sin detalle no borra lo ya descargado ni revierte LEIDA.
    await repo.guardarNotificaciones('c1', [{ ...base, leida: false }]);
    [guardada] = (await repo.notificacionesDe('c1')).filter(
      (notificacion) => notificacion.idComunicacion === base.idComunicacion,
    );
    assert.equal(guardada?.estado, 'LEIDA');
    assert.equal(guardada?.cuerpo, 'Contenido de la comunicación');
    assert.equal(guardada?.adjuntos.length, 1);
  } finally {
    repo.cerrar();
  }
});
