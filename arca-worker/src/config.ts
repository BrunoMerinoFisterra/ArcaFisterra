import { config as cargarEnv } from 'dotenv';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarClaveMaestra } from '../../arca-api/src/crypto/envelope.js';

const RAIZ_WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ZONA_HORARIA_ARCA = 'America/Buenos_Aires';
export const RANGO_MAXIMO_DIAS_ARCA = 365;

export interface RangoFechas {
  desde: string;
  hasta: string;
}

export interface ConfigWorker {
  apiDir: string;
  sqlitePath: string;
  claveMaestra: Buffer;
  headed: boolean;
  /**
   * Opt-in local: consultar el detalle de una comunicacion sin leer la abre
   * tambien en ARCA y puede perfeccionar su notificacion.
   */
  dfeAbrirNoLeidas: boolean;
  pollMs: number;
  jobTimeoutMs: number;
  leaseMs: number;
  heartbeatMs: number;
  esperaCuentaMs: number;
  rango: RangoFechas;
}

export function cargarConfigWorker(): ConfigWorker {
  cargarEnv({ path: join(RAIZ_WORKER, '.env'), quiet: true });
  const apiDir = resolve(RAIZ_WORKER, process.env['ARCA_API_DIR'] ?? '../arca-api');
  // Carga MASTER_KEY, REPOSITORIO y SQLITE_PATH de la misma configuracion que
  // usa la API. No se duplican secretos entre dos .env.
  cargarEnv({ path: join(apiDir, '.env'), override: false, quiet: true });

  if ((process.env['REPOSITORIO'] ?? 'sqlite') !== 'sqlite') {
    throw new Error('El worker local requiere REPOSITORIO=sqlite en arca-api/.env.');
  }
  const sqliteConfigurado = process.env['SQLITE_PATH'] ?? 'arca.db';
  if (sqliteConfigurado === ':memory:') throw new Error('El worker no puede compartir :memory:.');
  const sqlitePath = isAbsolute(sqliteConfigurado)
    ? sqliteConfigurado
    : resolve(apiDir, sqliteConfigurado);

  const masterKey = process.env['MASTER_KEY']?.trim();
  if (!masterKey) throw new Error('Falta MASTER_KEY en arca-api/.env.');

  const pollMs = Number(process.env['WORKER_POLL_MS'] ?? 3_000);
  if (!Number.isFinite(pollMs) || pollMs < 500 || pollMs > 60_000) {
    throw new Error('WORKER_POLL_MS debe estar entre 500 y 60000.');
  }
  const jobTimeoutMinutos = Number(process.env['WORKER_JOB_TIMEOUT_MIN'] ?? 60);
  if (!Number.isFinite(jobTimeoutMinutos) || jobTimeoutMinutos < 10 || jobTimeoutMinutos > 1440) {
    throw new Error('WORKER_JOB_TIMEOUT_MIN debe estar entre 10 y 1440.');
  }
  const leaseSegundos = Number(process.env['WORKER_LEASE_SECONDS'] ?? 120);
  if (!Number.isFinite(leaseSegundos) || leaseSegundos < 30 || leaseSegundos > 900) {
    throw new Error('WORKER_LEASE_SECONDS debe estar entre 30 y 900.');
  }
  const heartbeatSegundos = Number(process.env['WORKER_HEARTBEAT_SECONDS'] ?? 30);
  if (
    !Number.isFinite(heartbeatSegundos) ||
    heartbeatSegundos < 5 ||
    heartbeatSegundos >= leaseSegundos / 2
  ) {
    throw new Error('WORKER_HEARTBEAT_SECONDS debe ser al menos 5 y menor que la mitad del lease.');
  }
  const esperaCuentaSegundos = Number(process.env['WORKER_ACCOUNT_WAIT_SECONDS'] ?? 10);
  if (!Number.isFinite(esperaCuentaSegundos) || esperaCuentaSegundos < 2 || esperaCuentaSegundos > 300) {
    throw new Error('WORKER_ACCOUNT_WAIT_SECONDS debe estar entre 2 y 300.');
  }

  return {
    apiDir,
    sqlitePath,
    claveMaestra: cargarClaveMaestra(masterKey),
    headed: (process.env['WORKER_HEADED'] ?? process.env['HEADED'] ?? '0') !== '0',
    dfeAbrirNoLeidas: process.env['DFE_ABRIR_NO_LEIDAS'] === '1',
    pollMs,
    jobTimeoutMs: jobTimeoutMinutos * 60_000,
    leaseMs: leaseSegundos * 1_000,
    heartbeatMs: heartbeatSegundos * 1_000,
    esperaCuentaMs: esperaCuentaSegundos * 1_000,
    rango: cargarRango(),
  };
}

export function cargarRango(
  entorno: NodeJS.ProcessEnv = process.env,
  fecha = new Date(),
): RangoFechas {
  const configuradoDesde = entorno['SYNC_DESDE']?.trim();
  const configuradoHasta = entorno['SYNC_HASTA']?.trim();
  if (Boolean(configuradoDesde) !== Boolean(configuradoHasta)) {
    throw new Error('SYNC_DESDE y SYNC_HASTA se configuran juntos.');
  }

  if (configuradoDesde && configuradoHasta) {
    validarFecha(configuradoDesde, 'SYNC_DESDE');
    validarFecha(configuradoHasta, 'SYNC_HASTA');
    const dias = diasEntre(configuradoDesde, configuradoHasta);
    if (dias < 0) {
      throw new Error('SYNC_DESDE no puede ser posterior a SYNC_HASTA.');
    }
    return { desde: configuradoDesde, hasta: configuradoHasta };
  }

  return rangoAnioCalendarioArgentina(fecha);
}

function validarFecha(valor: string, nombre: string): void {
  const instante = /^\d{4}-\d{2}-\d{2}$/.test(valor)
    ? Date.parse(`${valor}T00:00:00Z`)
    : Number.NaN;
  if (
    Number.isNaN(instante) ||
    new Date(instante).toISOString().slice(0, 10) !== valor
  ) {
    throw new Error(`${nombre} debe tener formato YYYY-MM-DD.`);
  }
}

function diasEntre(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000,
  );
}

export function fechaArgentinaIso(fecha = new Date()): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('es-AR', {
      timeZone: ZONA_HORARIA_ARCA,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(fecha)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return `${partes['year']}-${partes['month']}-${partes['day']}`;
}

/** Del 1 de enero hasta hoy, usando siempre el calendario de Buenos Aires. */
export function rangoAnioCalendarioArgentina(fecha = new Date()): RangoFechas {
  const hasta = fechaArgentinaIso(fecha);
  return { desde: `${hasta.slice(0, 4)}-01-01`, hasta };
}

/**
 * ARCA admite como maximo 365 dias inclusivos por exportacion. Un anio
 * bisiesto completo tiene 366, por lo que el ultimo dia va en otra ventana.
 */
export function partirRangoParaArca(
  rango: RangoFechas,
  maximoDias = RANGO_MAXIMO_DIAS_ARCA,
): RangoFechas[] {
  validarFecha(rango.desde, 'desde');
  validarFecha(rango.hasta, 'hasta');
  if (!Number.isInteger(maximoDias) || maximoDias < 1) {
    throw new Error('El maximo de dias por rango debe ser un entero positivo.');
  }
  if (diasEntre(rango.desde, rango.hasta) < 0) {
    throw new Error('La fecha desde no puede ser posterior a la fecha hasta.');
  }

  const ventanas: RangoFechas[] = [];
  let desde = rango.desde;
  while (desde <= rango.hasta) {
    const maximoHasta = sumarDiasIso(desde, maximoDias - 1);
    const hasta = maximoHasta < rango.hasta ? maximoHasta : rango.hasta;
    ventanas.push({ desde, hasta });
    desde = sumarDiasIso(hasta, 1);
  }
  return ventanas;
}

function sumarDiasIso(fecha: string, dias: number): string {
  const instante = Date.parse(`${fecha}T00:00:00Z`);
  return new Date(instante + dias * 86_400_000).toISOString().slice(0, 10);
}
