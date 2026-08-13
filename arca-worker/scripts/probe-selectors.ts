/**
 * Smoke test de selectores — NO requiere credenciales.
 *
 * Abre la pantalla de login de ARCA y verifica que los selectores de
 * selectors.ts sigan matcheando. Como no ingresa ninguna clave, se puede correr
 * todos los dias sin riesgo de bloquear cuentas.
 *
 * Para eso existe: el portal de ARCA cambia sin aviso, y queremos enterarnos
 * por este check y no porque fallo la sincronizacion de todos los clientes.
 *
 * Uso:  npm run probe
 * Sale con codigo 1 si algun selector critico dejo de matchear.
 */
import 'dotenv/config';
import { CAPTCHA, LOGIN, URLS } from '../src/arca/selectors.js';
import { abrirSesion, volcarEstado } from '../src/browser/session.js';

interface Resultado {
  campo: string;
  ok: boolean;
  /** Que candidato matcheo, y si no fue el primero. */
  detalle: string;
}

async function main(): Promise<void> {
  const headed = process.env['HEADED'] === '1';
  const sesion = await abrirSesion({ headed });
  const resultados: Resultado[] = [];

  try {
    console.log(`probe de selectores contra ${URLS.login}\n`);
    await sesion.page.goto(URLS.login, { waitUntil: 'domcontentloaded' });
    await sesion.page.waitForTimeout(1_500);

    // Solo se puede chequear el paso 1 sin credenciales: el input de clave
    // aparece recien despues de mandar el CUIT.
    for (const [campo, candidatos] of [
      ['inputCuit', LOGIN.inputCuit],
      ['btnSiguiente', LOGIN.btnSiguiente],
    ] as const) {
      let match: string | null = null;
      let indice = -1;
      for (const [i, sel] of candidatos.entries()) {
        try {
          if (await sesion.page.locator(sel).first().isVisible({ timeout: 1_000 })) {
            match = sel;
            indice = i;
            break;
          }
        } catch {
          // Candidato invalido o ausente.
        }
      }
      resultados.push({
        campo,
        ok: match !== null,
        detalle: match
          ? indice === 0
            ? `${match}`
            : `${match}  (fallback #${indice} — el primario ya no matchea)`
          : `ninguno de ${candidatos.length} candidatos`,
      });
    }

    const hayCaptcha = await (async () => {
      for (const sel of CAPTCHA) {
        try {
          if ((await sesion.page.locator(sel).count()) > 0) return true;
        } catch {
          /* ignorar */
        }
      }
      return false;
    })();

    for (const r of resultados) {
      console.log(`  ${r.ok ? 'OK  ' : 'FALLA'}  ${r.campo.padEnd(14)} ${r.detalle}`);
    }
    console.log(`\n  CAPTCHA en el login: ${hayCaptcha ? 'SI — replantear el enfoque' : 'no'}`);

    const fallas = resultados.filter((r) => !r.ok);
    const degradado = resultados.some((r) => r.ok && r.detalle.includes('fallback'));

    if (fallas.length > 0) {
      await volcarEstado(sesion.page, 'probe-selectores-rotos');
      console.error(`\n${fallas.length} selector(es) rotos. El portal cambio: revisar selectors.ts`);
      process.exitCode = 1;
    } else if (degradado) {
      console.warn('\nSelectores en fallback: todavia funciona, pero conviene actualizar selectors.ts');
    } else {
      console.log('\nTodos los selectores primarios matchean.');
    }
  } finally {
    await sesion.cerrar();
  }
}

await main();
