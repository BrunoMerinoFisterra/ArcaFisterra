/**
 * Spike de SOLO LECTURA: que representados ofrece cada servicio, y si se puede
 * pasar de uno a otro dentro de la misma sesion.
 *
 * Es lo unico que falta comprobar antes de rediseñar el panel por empresa. Las
 * dos pantallas ya saben seleccionar UN cuit —Mis Facilidades con su combo y
 * aceptar, el DFE con su dropdown de representados—, pero siempre se las uso
 * para posicionarse una vez en el CUIT del cliente. Lo que nadie probo es
 * enumerar la lista y CAMBIAR de empresa sin volver a entrar.
 *
 * No escribe nada: ni en la base, ni en ARCA. En particular NO abre ninguna
 * comunicacion del DFE, que es la accion que las perfecciona legalmente.
 *
 * Uso: npm run spike:representados -- <cliente-id>
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { crearRepositorioSqlite } from '../../arca-api/src/repo/sqlite.js';
import { descifrarAccesoArca } from '../../arca-api/src/crypto/envelope.js';
import { cerrarAvisosDfe } from '../src/arca/domicilio-fiscal.js';
import { login } from '../src/arca/login.js';
import { MIS_FACILIDADES, PORTAL, URLS, linkServicio } from '../src/arca/selectors.js';
import { abrirSesion, primerSelectorVisible } from '../src/browser/session.js';
import { cargarConfigWorker } from '../src/config.js';
import type { Page } from 'playwright';

const clienteId = process.argv[2];
if (!clienteId) throw new Error('Uso: npm run spike:representados -- <cliente-id>');

/** Enmascara el CUIT en la salida: el spike se corre mirando la consola. */
const tapar = (cuit: string) => `${cuit.slice(0, 2)}-…${cuit.slice(-2)}`;

const config = cargarConfigWorker();
const repo = crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: false });
try {
  const cliente = await repo.clienteParaSync(clienteId);
  const cifrada = cliente ? await repo.leerCredencialCifrada(cliente.id) : null;
  if (!cliente || !cifrada) throw new Error('Cliente o credencial inexistente.');
  const acceso = descifrarAccesoArca(config.claveMaestra, cifrada, cliente.cuit);

  const carpetaSesiones = join(process.cwd(), '.sessions');
  await mkdir(carpetaSesiones, { recursive: true });
  const sesionPath = join(carpetaSesiones, `cliente-${cliente.id}.json`);
  const teniaSesion = existsSync(sesionPath);

  let sesion;
  try {
    try {
      sesion = await abrirSesion({
        headed: false,
        storageState: teniaSesion ? sesionPath : undefined,
      });
    } catch (error) {
      if (!teniaSesion) throw error;
      await rm(sesionPath, { force: true });
      sesion = await abrirSesion({ headed: false });
    }
    await sesion.page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
    const autenticada = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar, 8_000)
      .then(() => true)
      .catch(() => false);
    if (!autenticada) await login(sesion.page, acceso.usuarioCuit, acceso.clave);
    await sesion.context.storageState({ path: sesionPath });

    console.log(`cliente : ${cliente.razonSocial} (${tapar(cliente.cuit.replace(/\D/g, ''))})`);

    await probarFacilidades(sesion.page);
    await probarDfe(sesion.page);
  } finally {
    acceso.clave = '';
    await sesion?.cerrar();
  }
} finally {
  repo.cerrar();
  config.claveMaestra.fill(0);
}

async function abrirServicio(page: Page, servicio: string): Promise<Page> {
  await page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
  const buscador = await primerSelectorVisible(page, PORTAL.inputBuscar);
  await page.fill(buscador.selector, servicio);
  await page.waitForTimeout(1_500);
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    page.click(linkServicio(servicio)),
  ]);
  const vista = popup ?? page;
  await vista.waitForLoadState('domcontentloaded');
  return vista;
}

async function probarFacilidades(page: Page): Promise<void> {
  console.log('\n=== Mis Facilidades ===');
  try {
    const vista = await abrirServicio(page, MIS_FACILIDADES.servicio);
    const combo = vista.locator(MIS_FACILIDADES.selectorCuit);
    if ((await combo.count()) !== 1) {
      console.log('  sin combo de CUIT: la clave representa a uno solo');
      return;
    }
    const opciones = await combo.locator('option').evaluateAll((els) =>
      els.map((o) => ({ value: (o as HTMLOptionElement).value, texto: (o.textContent ?? '').trim() })),
    );
    console.log(`  ofrece ${opciones.length} contribuyente(s):`);
    for (const o of opciones) {
      const digitos = o.value.replace(/\D/g, '');
      console.log(`    ${digitos.length === 11 ? tapar(digitos) : o.value} — ${o.texto.slice(0, 40)}`);
    }

    // Lo que hay que probar: cambiar DOS veces sin volver a entrar al servicio.
    const utiles = opciones.filter((o) => o.value.replace(/\D/g, '').length === 11);
    for (const objetivo of utiles.slice(0, 2)) {
      const digitos = objetivo.value.replace(/\D/g, '');
      await combo.selectOption(objetivo.value);
      await Promise.all([
        vista.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
        vista.click(MIS_FACILIDADES.aceptarCuit),
      ]);
      const campo = vista.locator(MIS_FACILIDADES.cuitActivo);
      const activo = ((await campo.textContent().catch(() => '')) ?? '').replace(/\D/g, '');
      console.log(
        `  cambiar a ${tapar(digitos)} -> activo ${activo ? tapar(activo) : '(vacío)'} ${activo === digitos ? 'OK' : 'NO COINCIDE'}`,
      );
      // Volver al combo para la siguiente vuelta.
      await vista.goto(vista.url(), { waitUntil: 'domcontentloaded' }).catch(() => null);
    }
  } catch (error) {
    console.log(`  FALLO: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

async function probarDfe(page: Page): Promise<void> {
  console.log('\n=== Domicilio Fiscal Electrónico ===');
  try {
    const vista = await abrirServicio(page, 'Domicilio Fiscal Electrónico');
    await vista.waitForTimeout(3_000);

    const tab = vista.locator('#representados-comunicaciones-tab___BV_tab_button__');
    if ((await tab.count()) !== 1) {
      console.log('  sin pestaña de representados: la clave no representa a nadie acá');
      return;
    }
    await tab.click({ timeout: 5_000 }).catch(() => null);
    await vista.waitForTimeout(1_500);

    const selector = vista.locator('#select-representados');
    if ((await selector.count()) !== 1) {
      console.log('  la pestaña existe pero no hay #select-representados');
      return;
    }
    const opciones = await selector.locator('option').evaluateAll((els) =>
      els.map((o) => ({ value: (o as HTMLOptionElement).value, texto: (o.textContent ?? '').trim() })),
    );
    console.log(`  ofrece ${opciones.length} representado(s):`);
    for (const o of opciones) {
      const digitos = o.value.replace(/\D/g, '');
      console.log(`    ${digitos.length === 11 ? tapar(digitos) : o.value} — ${o.texto.slice(0, 40)}`);
    }

    // La pregunta que decide el diseño: "Todos tus representados" (-1), ¿trae
    // las comunicaciones de todos Y dice de quién es cada una? Si la grilla
    // identifica al contribuyente, el DFE se resuelve en UNA pasada.
    if (!opciones.some((o) => o.value === '-1')) {
      console.log('  no ofrece la opción "-1": hay que ir empresa por empresa');
      return;
    }
    console.log('\n  --- probando "Todos tus representados" (-1) ---');
    await cerrarAvisosDfe(vista, 3_000);
    const control = selector.locator(
      'xpath=following-sibling::*[contains(concat(" ", normalize-space(@class), " "), " input-group ")]',
    );
    await control.click({ timeout: 5_000 });
    await vista.locator('button.dropdown-item[id="-1"]').click({ timeout: 5_000 });
    await vista.waitForTimeout(3_000);
    await cerrarAvisosDfe(vista, 2_000);

    const tabla = vista.locator('#representados-comunicaciones-tab table').first();
    await tabla.waitFor({ state: 'visible', timeout: 15_000 });
    const encabezados = await tabla
      .locator('thead th')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
    console.log(`  columnas: ${JSON.stringify(encabezados)}`);

    const filas = await tabla
      .locator('tbody tr:not(.b-table-empty-row)')
      .evaluateAll((els) =>
        els.slice(0, 4).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) =>
            (td.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 34),
          ),
        ),
      );
    console.log(`  filas leidas: ${filas.length}`);
    for (const celdas of filas) {
      console.log(`    ${JSON.stringify(celdas.map((c) => c.replace(/\d{2}-?\d{8}-?\d/g, '<CUIT>')))}`);
    }
    // El HTML de una fila: es lo unico que dice si el representado viene con un
    // id estable —como `sistema[...]` para el asunto— o si hay que ubicarlo por
    // posicion de columna.
    const htmlFila = await tabla
      .locator('tbody tr:not(.b-table-empty-row)')
      .first()
      .evaluate((tr) => tr.innerHTML);
    console.log('  --- HTML de la primera fila ---');
    console.log(
      htmlFila
        .replace(/\d{2}-?\d{8}-?\d/g, '<CUIT>')
        .replace(/\s+/g, ' ')
        .slice(0, 1200),
    );

    const hayColumnaContribuyente = encabezados.some((h) =>
      /contribuyente|cuit|raz[oó]n|representad/i.test(h),
    );
    console.log(
      `  => ${hayColumnaContribuyente ? 'SI identifica al contribuyente: alcanza UNA pasada' : 'NO identifica al contribuyente: hay que ir empresa por empresa'}`,
    );
  } catch (error) {
    console.log(`  FALLO: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}
