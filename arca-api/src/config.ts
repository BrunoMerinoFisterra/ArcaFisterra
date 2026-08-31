import 'dotenv/config';
import { cargarClaveMaestra } from './crypto/envelope.js';

/**
 * Configuracion validada al arrancar.
 *
 * Si falta un secreto, el proceso no levanta. Un default silencioso para
 * JWT_SECRET o MASTER_KEY es peor que no arrancar: el servidor funcionaria
 * y cifraria todo con una clave que esta en el repositorio.
 */

function requerido(nombre: string): string {
  const v = process.env[nombre]?.trim();
  if (!v) {
    throw new Error(
      `Falta la variable de entorno ${nombre}. Copiá .env.example a .env y completalo.`,
    );
  }
  return v;
}

const LARGO_MINIMO_JWT = 32;

export type MotorRepositorio = 'memoria' | 'sqlite' | 'mssql';

export interface Config {
  puerto: number;
  origenPermitido: string;
  jwtSecret: string;
  claveMaestra: Buffer;
  repositorio: MotorRepositorio;
  /** Ruta del archivo cuando el motor es sqlite. */
  sqlitePath: string;
  sembrarDemo: boolean;
  produccion: boolean;
  /**
   * Cuenta administradora a crear en el arranque, si la base no tiene ningún
   * usuario todavía. null cuando no se configuró.
   */
  adminInicial: { email: string; nombre: string; password: string } | null;
  syncNocturna: ConfigSyncNocturna;
}

export interface ConfigSyncNocturna {
  /** Apagada por defecto: nadie quiere sincronizaciones que no pidió. */
  activa: boolean;
  /** Ventana en hora de `America/Buenos_Aires`: `desde` inclusive, `hasta` exclusive. */
  horaDesde: number;
  horaHasta: number;
  /**
   * No reencola un cliente si ya se INTENTÓ hace menos de estas horas.
   *
   * `finalizarJob` actualiza `ultimo_sync` aunque el job termine en error, así
   * que esto es lo que evita que un cliente con problemas se reencole toda la
   * noche. Sin este freno, un fallo se convierte en un reintento en loop —
   * exactamente lo que el sistema evita en todos lados para no bloquear cuentas.
   */
  minimoHorasEntreIntentos: number;
  /** Cada cuánto revisa si entró en la ventana. */
  intervaloMinutos: number;
}

function numeroEnRango(nombre: string, valor: string | undefined, def: number, min: number, max: number): number {
  const n = Number(valor ?? def);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${nombre} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

function leerSyncNocturna(): ConfigSyncNocturna {
  const activa = process.env['SYNC_NOCTURNA'] === '1';
  const horaDesde = numeroEnRango('SYNC_NOCTURNA_DESDE', process.env['SYNC_NOCTURNA_DESDE'], 2, 0, 23);
  const horaHasta = numeroEnRango('SYNC_NOCTURNA_HASTA', process.env['SYNC_NOCTURNA_HASTA'], 5, 1, 24);
  if (horaHasta <= horaDesde) {
    throw new Error('SYNC_NOCTURNA_HASTA tiene que ser mayor que SYNC_NOCTURNA_DESDE.');
  }
  return {
    activa,
    horaDesde,
    horaHasta,
    minimoHorasEntreIntentos: numeroEnRango(
      'SYNC_NOCTURNA_MIN_HORAS',
      process.env['SYNC_NOCTURNA_MIN_HORAS'],
      12,
      1,
      168,
    ),
    intervaloMinutos: numeroEnRango(
      'SYNC_NOCTURNA_INTERVALO_MIN',
      process.env['SYNC_NOCTURNA_INTERVALO_MIN'],
      15,
      1,
      120,
    ),
  };
}

/** El mismo minimo que exige el alta de usuarios por HTTP. */
const LARGO_MINIMO_PASSWORD = 6;

/**
 * Admin del primer arranque, leido del entorno.
 *
 * Se valida aca, al levantar, y no cuando se usa: una contrasena corta o un
 * email vacio tienen que frenar el proceso, no descubrirse recien cuando
 * alguien intenta entrar y no puede.
 */
function leerAdminInicial(): Config['adminInicial'] {
  const email = process.env['ADMIN_INICIAL_EMAIL']?.trim();
  const password = process.env['ADMIN_INICIAL_PASSWORD'] ?? '';
  if (!email) return null;

  if (password.length < LARGO_MINIMO_PASSWORD) {
    throw new Error(
      `ADMIN_INICIAL_EMAIL está seteado pero ADMIN_INICIAL_PASSWORD tiene ${password.length} ` +
        `caracteres (mínimo ${LARGO_MINIMO_PASSWORD}). Completá la contraseña o sacá las dos variables.`,
    );
  }
  return {
    email,
    nombre: process.env['ADMIN_INICIAL_NOMBRE']?.trim() || 'Administrador',
    password,
  };
}

export function cargarConfig(): Config {
  const jwtSecret = requerido('JWT_SECRET');
  if (jwtSecret.length < LARGO_MINIMO_JWT) {
    throw new Error(
      `JWT_SECRET es muy corto (${jwtSecret.length} chars, mínimo ${LARGO_MINIMO_JWT}). ` +
        'Generá uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
    );
  }

  const repositorio = (process.env['REPOSITORIO'] ?? 'sqlite') as MotorRepositorio;
  if (repositorio === 'mssql') {
    throw new Error(
      'El repositorio mssql todavía no está implementado. Falta la Azure SQL con las tablas arca_*.',
    );
  }
  if (repositorio !== 'memoria' && repositorio !== 'sqlite') {
    throw new Error(`REPOSITORIO desconocido: "${repositorio}". Usá memoria o sqlite.`);
  }

  return {
    adminInicial: leerAdminInicial(),
    puerto: Number(process.env['PORT'] ?? 3001),
    origenPermitido: process.env['ORIGEN_PERMITIDO'] ?? 'http://localhost:5173',
    jwtSecret,
    claveMaestra: cargarClaveMaestra(requerido('MASTER_KEY')),
    repositorio,
    sqlitePath: process.env['SQLITE_PATH'] ?? 'arca.db',
    sembrarDemo: process.env['SEMBRAR_DEMO'] !== '0',
    produccion: process.env['NODE_ENV'] === 'production',
    syncNocturna: leerSyncNocturna(),
  };
}
