/**
 * Spike de Fase 0 — ARCA: login + export CSV de Mis Comprobantes.
 *
 * Es un script de DESCUBRIMIENTO, no codigo de produccion. Su trabajo es
 * responder tres preguntas antes de que escribamos la app:
 *
 *   1. Que selectores del portal funcionan de verdad hoy.
 *   2. Que modos de falla aparecen y como se detecta cada uno.
 *   3. Si el boton CSV de Mis Comprobantes se puede disparar headless.
 *
 * Corre en modo headed (HEADED=1) para poder ver que pasa e intervenir si ARCA
 * pide CAPTCHA o segundo factor.
 *
 * Uso:  npm run spike
 *
 * Usa TU PROPIA clave fiscal, no la de un cliente. En esta fase la clave viaja
 * en texto plano por .env; el almacenamiento cifrado llega en Fase 1.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { login } from '../src/arca/login.js';
import { ArcaError } from '../src/arca/errors.js';
import { exportarComprobantes, type TipoConsultaComprobante } from '../src/arca/comprobantes.js';
import { MIS_COMPROBANTES } from '../src/arca/selectors.js';
import {
  ARTIFACTS_DIR,
  abrirSesion,
  volcarEstado,
} from '../src/browser/session.js';

const SESSION_FILE = join('.sessions', 'spike-storage-state.json');

function env(nombre: string): string | undefined {
  const v = process.env[nombre]?.trim();
  return v ? v : undefined;
}

/**
 * Valida un CUIT por su digito verificador (modulo 11).
 * Devuelve null si es valido, o el motivo del rechazo.
 *
 * Vale la pena chequearlo localmente: cada intento con datos mal tipeados
 * cuenta como fallido en ARCA, y a los pocos intentos bloquea la cuenta del
 * contribuyente. Descartar el CUIT como causa deja a la clave como unica
 * sospechosa cuando el login falla.
 */
function validarCuit(cuit: string): string | null {
  if (cuit.length !== 11) return `tiene ${cuit.length} digitos y debe tener 11`;

  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(cuit[i]), 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;

  if (Number(cuit[10]) !== esperado) {
    return `digito verificador incorrecto (es ${cuit[10]}, deberia ser ${esperado})`;
  }
  return null;
}

/** Dias enteros entre dos fechas ISO. */
function diasEntre(desde: string, hasta: string): number {
  const ms = Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Primer y ultimo dia del mes actual, en YYYY-MM-DD. */
function mesActual(): { desde: string; hasta: string } {
  const hoy = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)),
    hasta: iso(hoy),
  };
}

async function main(): Promise<void> {
  const cuit = env('ARCA_CUIT')?.replace(/\D/g, '');
  const clave = env('ARCA_CLAVE');
  if (!cuit || !clave) {
    console.error('Falta ARCA_CUIT o ARCA_CLAVE. Copia .env.example a .env y completalos.');
    process.exit(1);
  }
  // Validar antes de tocar el portal: un CUIT mal tipeado cuenta como intento
  // fallido en ARCA, y a los pocos intentos bloquea la cuenta.
  const problema = validarCuit(cuit);
  if (problema) {
    console.error(`ARCA_CUIT invalido: ${problema}`);
    process.exit(1);
  }

  const headed = env('HEADED') !== '0';
  const tipo: TipoConsultaComprobante =
    env('TIPO')?.toUpperCase() === 'RECIBIDOS' ? 'RECIBIDOS' : 'EMITIDOS';
  const desde = env('DESDE') ?? mesActual().desde;
  const hasta = env('HASTA') ?? mesActual().hasta;

  // El servicio rechaza rangos de mas de un año. Validarlo aca da un error
  // claro en vez de una busqueda que vuelve vacia sin explicar por que.
  const dias = diasEntre(desde, hasta);
  if (dias < 0 || dias > MIS_COMPROBANTES.rangoMaximoDias) {
    console.error(
      `Rango invalido: ${dias} dias (${desde} a ${hasta}). ` +
        `Mis Comprobantes admite hasta ${MIS_COMPROBANTES.rangoMaximoDias} dias, ` +
        `asi que el historial largo hay que traerlo en ventanas.`,
    );
    process.exit(1);
  }

  console.log('--- spike ARCA (Fase 0) ---');
  console.log(
    `CUIT ${cuit}  |  ${tipo}  |  headed: ${headed}  |  periodo ${desde} a ${hasta} (${dias} dias)\n`,
  );

  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await mkdir('.sessions', { recursive: true });

  // Reusar la sesion guardada evita re-loguear en cada corrida: mas rapido y
  // menos riesgo de bloqueo. FRESH=1 fuerza login limpio.
  const sesionPrevia = env('FRESH') !== '1' && existsSync(SESSION_FILE);

  const t0 = Date.now();
  const sesion = await abrirSesion({
    headed,
    storageState: sesionPrevia ? SESSION_FILE : undefined,
  });

  try {
    if (sesionPrevia) {
      console.log(`[1/3] reusando sesion de ${SESSION_FILE} (FRESH=1 para forzar login)`);
    } else {
      console.log('[1/3] login...');
      const { selectores } = await login(sesion.page, cuit, clave);
      console.log(`      OK en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log('      selectores que funcionaron:');
      for (const [paso, sel] of Object.entries(selectores)) {
        console.log(`        ${paso.padEnd(14)} ${sel}`);
      }
    }

    // En Fase 1 esto va cifrado igual que la credencial: el storageState da
    // acceso a la cuenta, asi que es tan sensible como la clave misma.
    await sesion.context.storageState({ path: SESSION_FILE });
    console.log(`\n[2/3] sesion guardada en ${SESSION_FILE}`);

    console.log('\n[3/3] Mis Comprobantes -> export CSV...');
    const csv = await exportarComprobantes(sesion.page, { desde, hasta }, tipo, cuit);
    console.log(csv ? `      CSV bajado: ${csv}` : '      sin comprobantes en el periodo');

    console.log(`\nlisto en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    if (e instanceof ArcaError) {
      console.error(`\nFALLO [${e.code}]`);
      console.error(`  reaccion esperada : ${e.reaccion}`);
      console.error(`  mensaje al usuario: ${e.mensajeUsuario}`);
      if (e.detalle) console.error(`  detalle           : ${e.detalle}`);
    } else {
      console.error('\nFALLO no tipado:', e);
      await volcarEstado(sesion.page, 'error-no-tipado');
    }
    process.exitCode = 1;
  } finally {
    // En headed conviene mirar la pantalla final antes de que cierre.
    if (headed) {
      console.log('\n(cerrando en 10s — mira la ventana si algo no cuadra)');
      await sesion.page.waitForTimeout(10_000);
    }
    await sesion.cerrar();
  }
}

await main();
