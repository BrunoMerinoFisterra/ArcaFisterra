import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArcaError } from '../arca/errors.js';

export const ARTIFACTS_DIR = '.artifacts';

/**
 * Prueba una lista de selectores candidatos y devuelve el primero visible.
 *
 * Devuelve tambien CUAL matcheo: durante la Fase 0 eso es el dato que buscamos
 * — confirma que selector aguanta contra el portal real y cuales hay que
 * limpiar de selectors.ts.
 */
export async function primerSelectorVisible(
  page: Page,
  candidatos: readonly string[],
  timeoutMs = 10_000,
): Promise<{ selector: string; indice: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [indice, selector] of candidatos.entries()) {
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 250 })) {
          return { selector, indice };
        }
      } catch {
        // Selector invalido o todavia no presente: seguimos con el siguiente.
      }
    }
  }
  throw new ArcaError('SELECTOR_NO_ENCONTRADO', `ninguno visible: ${candidatos.join(' | ')}`);
}

/** True si alguno de los selectores esta presente. No espera. */
export async function algunoPresente(page: Page, candidatos: readonly string[]): Promise<boolean> {
  for (const selector of candidatos) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch {
      // Selector invalido: ignorar.
    }
  }
  return false;
}

/**
 * Guarda screenshot + HTML cuando algo falla.
 *
 * Es la unica forma de debuggear un portal que cambio sin aviso: sin esto
 * quedas con un timeout y cero contexto. Los archivos pueden contener datos
 * fiscales reales, por eso .artifacts/ esta en .gitignore.
 */
export async function volcarEstado(page: Page, etiqueta: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(ARTIFACTS_DIR, `${stamp}_${etiqueta}`);
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    await writeFile(`${base}.html`, await page.content(), 'utf8');
    await writeFile(`${base}.url.txt`, page.url(), 'utf8');
    // `page.content()` sólo incluye el documento principal. Cuentas
    // Tributarias renderiza sus tablas dentro de un iframe; sin conservarlo,
    // un timeout muestra la tabla en la captura pero oculta el DOM necesario
    // para corregir el selector.
    for (const [indice, frame] of page.frames().entries()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      await writeFile(`${base}.frame-${indice}.html`, await frame.content(), 'utf8').catch(() => {});
      await writeFile(`${base}.frame-${indice}.url.txt`, frame.url(), 'utf8').catch(() => {});
    }
  } catch (e) {
    console.error('  no se pudo volcar el estado:', e);
  }
  return base;
}

export interface Sesion {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cerrar: () => Promise<void>;
}

export async function abrirSesion(opts: { headed: boolean; storageState?: string }): Promise<Sesion> {
  const browser = await chromium.launch({
    headless: !opts.headed,
    // slowMo en headed para poder seguir lo que hace el script a ojo.
    slowMo: opts.headed ? 120 : 0,
  });
  const context = await browser.newContext({
    storageState: opts.storageState,
    locale: 'es-AR',
    timezoneId: 'America/Buenos_Aires',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    cerrar: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
