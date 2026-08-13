import type { Page } from 'playwright';
import { ArcaError, detectarError } from './errors.js';
import { CAPTCHA, LOGIN, URL_POST_LOGIN, URLS } from './selectors.js';
import { algunoPresente, primerSelectorVisible, volcarEstado } from '../browser/session.js';

/** Que selector matcheo en cada paso. Salida principal del spike de Fase 0. */
export interface SelectoresUsados {
  inputCuit?: string;
  btnSiguiente?: string;
  inputClave?: string;
  btnIngresar?: string;
}

/**
 * Login en el portal de ARCA. Dos pasos: CUIT -> Siguiente -> clave -> Ingresar.
 *
 * Corta con ArcaError tipado ante cualquier modo de falla conocido. El llamador
 * decide que hacer segun `error.reaccion`; en particular NUNCA debe reintentar
 * un CLAVE_INCORRECTA, porque ARCA bloquea la cuenta a los pocos intentos y el
 * que sufre el bloqueo es el contribuyente.
 */
export async function login(
  page: Page,
  cuit: string,
  clave: string,
  destinosExitosos: readonly RegExp[] = URL_POST_LOGIN,
): Promise<{ selectores: SelectoresUsados }> {
  const selectores: SelectoresUsados = {};

  await page.goto(URLS.login, { waitUntil: 'domcontentloaded' });
  await verificarCaptcha(page);

  // Paso 1: CUIT
  const cuitSel = await primerSelectorVisible(page, LOGIN.inputCuit);
  selectores.inputCuit = cuitSel.selector;
  await page.fill(cuitSel.selector, cuit);

  const siguienteSel = await primerSelectorVisible(page, LOGIN.btnSiguiente);
  selectores.btnSiguiente = siguienteSel.selector;
  await page.click(siguienteSel.selector);

  await page.waitForLoadState('domcontentloaded');
  await verificarCaptcha(page);
  await verificarMensajeError(page);

  // Paso 2: clave
  const claveSel = await primerSelectorVisible(page, LOGIN.inputClave);
  selectores.inputClave = claveSel.selector;
  await page.fill(claveSel.selector, clave);

  const ingresarSel = await primerSelectorVisible(page, LOGIN.btnIngresar);
  selectores.btnIngresar = ingresarSel.selector;
  await page.click(ingresarSel.selector);

  await page.waitForLoadState('networkidle').catch(() => {
    // networkidle puede no llegar nunca en el portal; seguimos igual.
  });

  await verificarCaptcha(page);

  // El exito se decide por la URL, ANTES de buscar errores.
  // Al reves da falsos positivos: el portal linkea servicios como
  // "Administrador de Relaciones", y ese texto tambien aparece en los
  // mensajes de error de servicio no adherido. Si llegamos al portal, entramos.
  if (destinosExitosos.some((re) => re.test(page.url()))) {
    return { selectores };
  }

  await verificarMensajeError(page);

  // No estamos en el portal y tampoco reconocimos un error conocido.
  // Vale la pena volcar el estado: casi siempre es una pantalla nueva.
  const artifact = await volcarEstado(page, 'login-destino-inesperado');
  throw new ArcaError('DESCONOCIDO', `URL final ${page.url()} — artifacts en ${artifact}`);
}

/**
 * Si hay CAPTCHA, corta. No lo resolvemos ni intentamos evadirlo: el job queda
 * en NECESITA_HUMANO y alguien ingresa a mano esa vez.
 */
async function verificarCaptcha(page: Page): Promise<void> {
  if (await algunoPresente(page, CAPTCHA)) {
    throw new ArcaError('CAPTCHA_PRESENTE', `en ${page.url()}`);
  }
}

/** Busca frases de error conocidas, primero en el cartel y si no en toda la pagina. */
async function verificarMensajeError(page: Page): Promise<void> {
  for (const sel of LOGIN.mensajeError) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 200 })) {
        const texto = (await loc.textContent())?.trim();
        if (texto) {
          const err = detectarError(texto);
          if (err) throw err;
          // Cartel visible pero frase no catalogada: vale registrarla para
          // sumarla a FRASES en errors.ts.
          throw new ArcaError('DESCONOCIDO', `cartel no catalogado: "${texto}"`);
        }
      }
    } catch (e) {
      if (e instanceof ArcaError) throw e;
      // Selector ausente: seguimos con el siguiente candidato.
    }
  }

  const err = detectarError(await page.locator('body').innerText());
  if (err) throw err;
}
