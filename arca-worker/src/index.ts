import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { crearRepositorioSqlite } from '../../arca-api/src/repo/sqlite.js';
import type { ResultadoJob } from '../../arca-api/src/repo/tipos.js';
import type { Cliente, EstadoCredencial, SyncJob } from '../../arca-api/src/dominio/tipos.js';
import {
  descifrarAccesoArca,
  identificadorAccesoArca,
  type AccesoArca,
} from '../../arca-api/src/crypto/envelope.js';
import {
  exportarComprobantes,
  formatearCuitArca,
  listarContribuyentesDeComprobantes,
  type TipoConsultaComprobante,
} from './arca/comprobantes.js';
import { extraerPlanesFacilidades } from './arca/facilidades.js';
import { extraerNotificacionesDfe } from './arca/domicilio-fiscal.js';
import { extraerCuentasTributarias } from './arca/saldos.js';
import { verificarAccesoAContribuyente } from './arca/verificar-acceso.js';
import { ArcaError } from './arca/errors.js';
import { login } from './arca/login.js';
import { PORTAL, URLS } from './arca/selectors.js';
import { leerComprobantesDesdeArchivo } from './arca/csv.js';
import { abrirSesion, primerSelectorVisible, volcarEstado } from './browser/session.js';
import {
  cargarConfigWorker,
  cargarRango,
  partirRangoParaArca,
  type ConfigWorker,
} from './config.js';

const config = cargarConfigWorker();
// El worker nunca crea datos demo: solo consume la base que prepara la API.
const repo = crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: false });
const unaVez = process.argv.includes('--once');
const soloChequeo = process.argv.includes('--check');
const workerId = process.env['WORKER_ID']?.trim() || `worker-${randomUUID()}`;
let detener = false;

const MODULOS_COMPLETOS = [
  'domicilio-fiscal',
  'sistema-cuentas-tributarias',
  'mis-facilidades',
  'mis-comprobantes',
] as const;
type ModuloSincronizable = (typeof MODULOS_COMPLETOS)[number];
const ETIQUETAS_MODULO: Record<ModuloSincronizable, string> = {
  'domicilio-fiscal': 'Domicilio Fiscal Electrónico',
  'sistema-cuentas-tributarias': 'Sistema de Cuentas Tributarias y vencimientos',
  'mis-facilidades': 'Mis Facilidades',
  'mis-comprobantes': 'Mis Comprobantes',
};

process.once('SIGINT', () => {
  detener = true;
});
process.once('SIGTERM', () => {
  detener = true;
});

console.log('arca-worker local');
console.log(`  sqlite : ${config.sqlitePath}`);
console.log(`  rango  : ${config.rango.desde} a ${config.rango.hasta}`);
console.log(`  browser: ${config.headed ? 'visible' : 'headless'}`);
console.log(`  worker : ${workerId}`);
console.log(
  `  DFE    : ${config.dfeAbrirNoLeidas ? 'detalle de no leidas autorizado' : 'no abre comunicaciones sin leer'}`,
);
console.log(
  soloChequeo ? '  modo   : chequeo' : unaVez ? '  modo   : un job' : `  poll   : ${config.pollMs} ms`,
);

try {
  if (soloChequeo) {
    console.log('  configuracion y base local: OK');
  } else {
    const ahora = new Date().toISOString();
    const limiteInterrumpidos = new Date(Date.now() - config.jobTimeoutMs).toISOString();
    const recuperados = await repo.recuperarJobsInterrumpidos(ahora, limiteInterrumpidos);
    if (recuperados > 0) console.warn(`  ${recuperados} job(s) interrumpidos fueron cerrados`);

    while (!detener) {
      const instante = Date.now();
      const job = await repo.tomarProximoJob(
        workerId,
        new Date(instante).toISOString(),
        new Date(instante + config.leaseMs).toISOString(),
      );
      if (!job) {
        if (unaVez) break;
        await esperar(config.pollMs);
        continue;
      }

      await procesar(job, config, workerId);
      if (unaVez) break;
    }
  }
} finally {
  repo.cerrar();
  config.claveMaestra.fill(0);
}

async function procesar(job: SyncJob, cfg: ConfigWorker, propietario: string): Promise<void> {
  console.log(`\n[job ${job.id}] cliente ${job.clienteId} — ${job.modulo}`);

  // Va antes del chequeo de modulos: verificar una solicitud de acceso no
  // sincroniza nada, no lee la credencial del cliente y no toca su estado.
  if (job.solicitudId) {
    await verificarSolicitud(job.id, job.solicitudId, cfg, propietario);
    return;
  }

  if (![...MODULOS_COMPLETOS, 'sincronizacion-completa'].includes(job.modulo)) {
    await repo.finalizarJob(job.id, {
      estado: 'ERROR',
      detalle: `Modulo no soportado por el worker local: ${job.modulo}.`,
    }, propietario);
    return;
  }

  const cliente = await repo.clienteParaSync(job.clienteId);
  if (!cliente) {
    await repo.finalizarJob(job.id, { estado: 'ERROR', detalle: 'El cliente ya no existe.' }, propietario);
    return;
  }
  const cifrada = await repo.leerCredencialCifrada(cliente.id);
  if (!cifrada) {
    await repo.finalizarJob(job.id, {
      estado: 'ERROR',
      detalle: 'El cliente no tiene una clave fiscal guardada.',
      estadoCredencial: 'SIN_CARGAR',
    }, propietario);
    return;
  }

  let acceso: AccesoArca;
  try {
    acceso = descifrarAccesoArca(cfg.claveMaestra, cifrada, cliente.cuit);
  } catch {
    await repo.finalizarJob(job.id, {
      estado: 'ERROR',
      detalle: 'No se pudo descifrar la credencial. Revisar MASTER_KEY y la base local.',
    }, propietario);
    return;
  }

  const ahoraBloqueo = Date.now();
  const bloqueoAdquirido = await repo.adquirirBloqueoCuenta(
    job.id,
    propietario,
    identificadorAccesoArca(cfg.claveMaestra, acceso.usuarioCuit),
    new Date(ahoraBloqueo).toISOString(),
    new Date(ahoraBloqueo + cfg.leaseMs).toISOString(),
  );
  if (!bloqueoAdquirido) {
    acceso.clave = '';
    await repo.reencolarJob(
      job.id,
      propietario,
      new Date(Date.now() + cfg.esperaCuentaMs).toISOString(),
      'Esperando a que termine otra sincronizacion de esta cuenta ARCA',
    );
    console.log('  en espera — otra empresa usa la misma cuenta ARCA');
    return;
  }

  let leasePerdido = false;
  let renovacionEnCurso = false;
  const latido = setInterval(() => {
    if (renovacionEnCurso) return;
    renovacionEnCurso = true;
    const leaseHasta = new Date(Date.now() + cfg.leaseMs).toISOString();
    void repo
      .renovarLeaseJob(job.id, propietario, leaseHasta)
      .then((renovado) => {
        if (!renovado) leasePerdido = true;
      })
      .catch((error: unknown) => {
        leasePerdido = true;
        console.error(`  no se pudo renovar el lease: ${String(error)}`);
      })
      .finally(() => {
        renovacionEnCurso = false;
      });
  }, cfg.heartbeatMs);

  const carpetaSesiones = join(process.cwd(), '.sessions');
  await mkdir(carpetaSesiones, { recursive: true });
  const sesionPath = join(carpetaSesiones, `cliente-${segmentoSeguro(cliente.id)}.json`);
  const teniaSesion = existsSync(sesionPath);

  let sesion;
  try {
    try {
      sesion = await abrirSesion({
        headed: cfg.headed,
        storageState: teniaSesion ? sesionPath : undefined,
      });
    } catch (error) {
      if (!teniaSesion) throw error;
      await rm(sesionPath, { force: true });
      sesion = await abrirSesion({ headed: cfg.headed });
    }

    await sesion.page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
    const autenticada = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar, 8_000)
      .then(() => true)
      .catch(() => false);
    if (!autenticada) {
      console.log('  login ARCA...');
      await login(sesion.page, acceso.usuarioCuit, acceso.clave);
    } else {
      console.log('  sesion ARCA reutilizada');
    }
    await sesion.context.storageState({ path: sesionPath });

    const modulos: readonly ModuloSincronizable[] =
      job.modulo === 'sincronizacion-completa'
        ? MODULOS_COMPLETOS
        : [job.modulo as ModuloSincronizable];
    for (let indice = 0; indice < modulos.length; indice += 1) {
      if (leasePerdido) throw new Error('El worker perdio la propiedad del trabajo.');
      const modulo = modulos[indice]!;
      await repo.actualizarProgresoJob(job.id, {
        actual: indice,
        total: modulos.length,
        paso: ETIQUETAS_MODULO[modulo],
      }, propietario);
      console.log(`  [${indice + 1}/${modulos.length}] ${ETIQUETAS_MODULO[modulo]}...`);
      await procesarModulo(modulo, cliente, acceso, sesion, sesionPath, cfg);
      await repo.actualizarProgresoJob(job.id, {
        actual: indice + 1,
        total: modulos.length,
        paso: indice + 1 === modulos.length ? 'Completado' : ETIQUETAS_MODULO[modulos[indice + 1]!],
      }, propietario);
    }
    clearInterval(latido);
    await repo.finalizarJob(job.id, { estado: 'DONE' }, propietario);
    console.log(`  OK — ${modulos.length} módulo(s) completados`);
  } catch (error) {
    if (sesion) {
      const pagina = sesion.context.pages().find((p) => !p.isClosed());
      if (pagina) await volcarEstado(pagina, `job-${segmentoSeguro(job.id)}`);
    }
    const resultado = resultadoDeError(error);
    clearInterval(latido);
    await repo.finalizarJob(job.id, resultado, propietario);
    console.error(`  FALLO — ${resultado.detalle}`);
  } finally {
    clearInterval(latido);
    acceso.clave = '';
    await sesion?.cerrar();
  }
}

/**
 * Verifica una solicitud de acceso a una empresa que ya esta cargada.
 *
 * Tres reglas que no se pueden aflojar:
 *
 *  1. **Sesion nueva, sin `.sessions/`.** La sesion guardada del cliente es de
 *     la credencial que ya estaba; reusarla aprobaria el pedido sin haber
 *     probado la clave que mando quien lo pide.
 *  2. **No se guarda el storage state.** Esta sesion es de otra cuenta ARCA y
 *     pisaria la del cliente.
 *  3. **No se propaga `estadoCredencial`.** Una clave equivocada de quien pide
 *     acceso no puede marcar como invalida la credencial de la oficina que ya
 *     tenia la empresa. `finalizarJob` ademas no toca al cliente en esta rama.
 */
async function verificarSolicitud(
  jobId: string,
  solicitudId: string,
  cfg: ConfigWorker,
  propietario: string,
): Promise<void> {
  const solicitud = await repo.solicitudParaVerificar(solicitudId);
  if (!solicitud) {
    await repo.finalizarJob(
      jobId,
      { estado: 'ERROR', detalle: 'La solicitud ya no esta pendiente.' },
      propietario,
    );
    return;
  }

  let acceso: AccesoArca;
  try {
    acceso = descifrarAccesoArca(cfg.claveMaestra, solicitud.cifrada, solicitud.cuit);
  } catch {
    await repo.finalizarJob(
      jobId,
      { estado: 'ERROR', detalle: 'No se pudo descifrar la clave enviada con la solicitud.' },
      propietario,
    );
    return;
  }

  const ahora = Date.now();
  const bloqueoAdquirido = await repo.adquirirBloqueoCuenta(
    jobId,
    propietario,
    identificadorAccesoArca(cfg.claveMaestra, acceso.usuarioCuit),
    new Date(ahora).toISOString(),
    new Date(ahora + cfg.leaseMs).toISOString(),
  );
  if (!bloqueoAdquirido) {
    acceso.clave = '';
    await repo.reencolarJob(
      jobId,
      propietario,
      new Date(Date.now() + cfg.esperaCuentaMs).toISOString(),
      'Esperando a que termine otra sincronizacion de esta cuenta ARCA',
    );
    console.log('  en espera — otra empresa usa la misma cuenta ARCA');
    return;
  }

  let leasePerdido = false;
  const latido = setInterval(() => {
    void repo
      .renovarLeaseJob(jobId, propietario, new Date(Date.now() + cfg.leaseMs).toISOString())
      .then((renovado) => {
        if (!renovado) leasePerdido = true;
      })
      .catch(() => {
        leasePerdido = true;
      });
  }, cfg.heartbeatMs);

  let sesion: SesionArca | undefined;
  try {
    console.log(`  verificando acceso a ${solicitud.cuit}...`);
    sesion = await abrirSesion({ headed: cfg.headed });
    await login(sesion.page, acceso.usuarioCuit, acceso.clave);
    if (leasePerdido) throw new Error('El worker perdio la propiedad del trabajo.');

    const veredicto = await verificarAccesoAContribuyente(
      sesion.page,
      acceso.usuarioCuit,
      solicitud.cuit,
    );
    clearInterval(latido);
    await repo.finalizarJob(
      jobId,
      veredicto.autorizado
        ? { estado: 'DONE', detalle: veredicto.detalle }
        : { estado: 'ERROR', detalle: veredicto.detalle },
      propietario,
    );
    console.log(veredicto.autorizado ? `  OK — ${veredicto.detalle}` : `  RECHAZADA — ${veredicto.detalle}`);
  } catch (error) {
    if (sesion) {
      const pagina = sesion.context.pages().find((p) => !p.isClosed());
      if (pagina) await volcarEstado(pagina, `solicitud-${segmentoSeguro(solicitudId)}`);
    }
    const resultado = resultadoDeError(error);
    clearInterval(latido);
    // Sin `estadoCredencial`: no es la credencial de la empresa.
    await repo.finalizarJob(
      jobId,
      { estado: resultado.estado, detalle: resultado.detalle ?? 'No se pudo verificar el acceso.' },
      propietario,
    );
    console.error(`  FALLO — ${resultado.detalle}`);
  } finally {
    clearInterval(latido);
    acceso.clave = '';
    // Sin `storageState`: esta sesion es de otra cuenta ARCA.
    await sesion?.cerrar();
  }
}

type SesionArca = Awaited<ReturnType<typeof abrirSesion>>;

async function procesarModulo(
  modulo: ModuloSincronizable,
  cliente: Cliente,
  acceso: AccesoArca,
  sesion: SesionArca,
  sesionPath: string,
  cfg: ConfigWorker,
): Promise<void> {
  if (modulo === 'domicilio-fiscal') {
    const detallesExistentes = new Set(
      (await repo.notificacionesDe(cliente.id))
        .filter((notificacion) => notificacion.cuerpo !== null)
        .map((notificacion) => notificacion.idComunicacion),
    );
    const notificaciones = await extraerNotificacionesDfe(
      sesion.page,
      cliente.cuit,
      acceso.usuarioCuit,
      {
        detallesExistentes,
        abrirNoLeidasAutorizadas: cfg.dfeAbrirNoLeidas,
      },
    );
    const guardadas = await repo.guardarNotificaciones(cliente.id, notificaciones);
    const sinLeer = notificaciones.filter((notificacion) => !notificacion.leida).length;
    console.log(
      `      ${notificaciones.length} comunicaciones (${sinLeer} sin leer), ` +
        `${guardadas.insertadas} nuevas, ${guardadas.actualizadas} actualizadas`,
    );
    return;
  }

  if (modulo === 'mis-facilidades') {
    const planes = await extraerPlanesFacilidades(sesion.page, cliente.cuit);
    const guardados = await repo.reemplazarPlanes(cliente.id, planes);
    console.log(`      ${guardados.planes} planes, ${guardados.cuotas} filas de cuotas`);
    return;
  }

  if (modulo === 'sistema-cuentas-tributarias') {
    const { saldos, vencimientos, ddjjPendientes } = await extraerCuentasTributarias(
      sesion.page,
      cliente.cuit,
      acceso.usuarioCuit,
      acceso.clave,
    );
    await sesion.context.storageState({ path: sesionPath });
    const guardados = await repo.reemplazarSaldos(cliente.id, saldos);
    const vencimientosGuardados = await repo.reemplazarVencimientos(cliente.id, vencimientos);
    const ddjjGuardadas = await repo.reemplazarDdjjPendientes(cliente.id, ddjjPendientes);
    const deuda = Math.abs(
      saldos.reduce(
        (total, saldo) =>
          total + saldo.saldo + saldo.interesResarcitorio + saldo.interesPunitorio,
        0,
      ),
    );
    console.log(
      `      ${guardados} obligaciones, ${vencimientosGuardados} vencimientos, ` +
        `${ddjjGuardadas} DDJJ pendientes, ` +
        `deuda total $ ${deuda.toFixed(2)}`,
    );
    return;
  }

  let insertados = 0;
  let repetidos = 0;
  const rangos = partirRangoParaArca(cargarRango());
  const paginaActual = () =>
    sesion.page.isClosed()
      ? (sesion.context.pages().find((p) => !p.isClosed()) ?? sesion.context.newPage())
      : sesion.page;

  // Una misma clave fiscal puede actuar por varios contribuyentes, igual que en
  // Cuentas Tributarias. Si la pantalla de selección no aparece, la lista viene
  // vacía y se sincroniza únicamente el CUIT del cliente.
  const contribuyentes = await listarContribuyentesDeComprobantes(await paginaActual());
  const aRecorrer = contribuyentes.length > 0 ? contribuyentes : [cliente.cuit];
  if (contribuyentes.length > 1) {
    console.log(`      ${contribuyentes.length} contribuyentes disponibles`);
  }

  for (const [indice, contribuyente] of aRecorrer.entries()) {
    const contribuyenteCuit = formatearCuitArca(contribuyente);
    if (aRecorrer.length > 1) {
      console.log(`      CUIT ${indice + 1}/${aRecorrer.length}: ${contribuyenteCuit}`);
    }
    for (const consulta of ['EMITIDOS', 'RECIBIDOS'] as const satisfies readonly TipoConsultaComprobante[]) {
      for (const rango of rangos) {
        console.log(`        exportando ${consulta.toLowerCase()} (${rango.desde} a ${rango.hasta})...`);
        const archivo = await exportarComprobantes(
          await paginaActual(),
          rango,
          consulta,
          contribuyenteCuit,
        );
        if (!archivo) continue;
        const tipo = consulta === 'EMITIDOS' ? 'EMITIDO' : 'RECIBIDO';
        const comprobantes = await leerComprobantesDesdeArchivo(archivo, tipo);
        const guardados = await repo.guardarComprobantes(
          cliente.id,
          // El CUIT lo pone el worker y no el parser: el CSV de ARCA no lo
          // trae, porque el portal ya sabe por quién estás consultando.
          comprobantes.map((comprobante) => ({ ...comprobante, contribuyenteCuit })),
        );
        insertados += guardados.insertados;
        repetidos += guardados.repetidos;
      }
    }
  }
  console.log(`      ${insertados} nuevos, ${repetidos} ya existentes`);
}

function resultadoDeError(error: unknown): ResultadoJob {
  const arca =
    error instanceof ArcaError
      ? error
      : error instanceof Error && error.name === 'TimeoutError'
        ? new ArcaError('TIMEOUT', error.message)
        : null;
  if (!arca) {
    return {
      estado: 'ERROR',
      detalle: error instanceof Error ? error.message : 'Error inesperado del worker.',
    };
  }

  const estadoCredencial: Partial<Record<ArcaError['code'], EstadoCredencial>> = {
    CLAVE_INCORRECTA: 'INVALIDA',
    CLAVE_BLOQUEADA: 'BLOQUEADA',
    CLAVE_VENCIDA: 'VENCIDA',
  };
  return {
    estado: arca.reaccion === 'NECESITA_HUMANO' ? 'NEEDS_HUMAN' : 'ERROR',
    detalle: arca.mensajeUsuario,
    ...(estadoCredencial[arca.code] ? { estadoCredencial: estadoCredencial[arca.code] } : {}),
  };
}

function segmentoSeguro(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
