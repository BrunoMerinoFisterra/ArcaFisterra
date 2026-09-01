import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  MIS_COMPROBANTES,
  MODAL_AGREGAR_SERVICIO,
  PORTAL,
  SELECCION_CONTRIBUYENTE,
  URLS,
  linkContribuyentePorCuit,
  linkServicio,
} from './selectors.js';
import { ArcaError } from './errors.js';
import {
  ARTIFACTS_DIR,
  algunoPresente,
  primerSelectorVisible,
  volcarEstado,
} from '../browser/session.js';

export type TipoConsultaComprobante = 'EMITIDOS' | 'RECIBIDOS';

export function formatearCuitArca(cuit: string): string {
  const digitos = cuit.replace(/\D/g, '');
  if (digitos.length !== 11) {
    throw new ArcaError('DESCONOCIDO', `CUIT de cliente invalido: ${cuit}`);
  }
  return `${digitos.slice(0, 2)}-${digitos.slice(2, 10)}-${digitos.slice(10)}`;
}

/**
 * Entra al servicio desde el portal y devuelve la pestaña donde quedó.
 *
 * Está extraído porque lo necesitan los dos caminos —enumerar contribuyentes y
 * exportar—, y duplicar esta navegación significaría arreglar los selectores en
 * dos lugares cuando ARCA cambie el HTML.
 */
async function abrirMisComprobantes(page: Page): Promise<Page> {
  await page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });

  const buscador = await primerSelectorVisible(page, PORTAL.inputBuscar);
  await page.fill(buscador.selector, MIS_COMPROBANTES.servicio);
  await page.waitForTimeout(1_500);

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    page.click(linkServicio(MIS_COMPROBANTES.servicio)),
  ]);
  const vista = popup ?? page;
  await vista.waitForLoadState('domcontentloaded');

  if (await algunoPresente(vista, MODAL_AGREGAR_SERVICIO.contenedor)) {
    throw new ArcaError(
      'SERVICIO_NO_ADHERIDO',
      `el portal ofrecio agregar "${MIS_COMPROBANTES.servicio}"`,
    );
  }
  return vista;
}

/** Abre el servicio y enumera los contribuyentes disponibles. */
export async function listarContribuyentesDeComprobantes(page: Page): Promise<string[]> {
  return listarContribuyentes(await abrirMisComprobantes(page));
}

/**
 * CUITs por los que la clave fiscal puede actuar en Mis Comprobantes.
 *
 * Vacío cuando la pantalla de selección no aparece: ahí la clave representa a
 * una sola persona y los comprobantes son los del propio cliente.
 *
 * Devuelve los CUITs y no los elementos a propósito. La selección posterior se
 * hace por coincidencia EXACTA de CUIT, nunca por posición en la lista: si el
 * orden cambiara entre la lectura y el clic, elegir por índice traería los
 * comprobantes de otro contribuyente sin que nada fallara.
 */
export async function listarContribuyentes(vista: Page): Promise<string[]> {
  if (!(await algunoPresente(vista, SELECCION_CONTRIBUYENTE.contenedor))) return [];

  const textos = await vista
    .locator(SELECCION_CONTRIBUYENTE.opciones)
    .evaluateAll((elementos) => elementos.map((el) => el.textContent ?? ''));

  const cuits = new Set<string>();
  for (const texto of textos) {
    const encontrado = texto.match(/\d{2}\D?\d{8}\D?\d/)?.[0]?.replace(/\D/g, '');
    if (encontrado?.length === 11) cuits.add(encontrado);
  }
  return [...cuits];
}

/**
 * Mis Comprobantes muestra esta pantalla solo cuando el usuario puede actuar
 * por varias personas. Devuelve true cuando hizo falta elegir una.
 */
export async function seleccionarContribuyenteSiHaceFalta(
  vista: Page,
  cuitCliente: string,
): Promise<boolean> {
  if (!(await algunoPresente(vista, SELECCION_CONTRIBUYENTE.contenedor))) return false;

  const cuit = formatearCuitArca(cuitCliente);
  const selector = linkContribuyentePorCuit(cuit);
  const opciones = vista.locator(selector);
  const cantidad = await opciones.count();
  if (cantidad !== 1) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `se esperaba una opcion para ${cuit} y se encontraron ${cantidad}`,
    );
  }

  console.log(`      representado ${cuit}`);
  await opciones.click();
  await vista.waitForLoadState('domcontentloaded');
  return true;
}

/** YYYY-MM-DD -> DD/MM/YYYY, que es el formato que espera ARCA. */
function aDdMmAaaa(iso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!partes) throw new ArcaError('DESCONOCIDO', `fecha invalida: ${iso}`);
  return `${partes[3]}/${partes[2]}/${partes[1]}`;
}

/** Cuanto se espera a que ARCA termine de enganchar el daterangepicker. */
const ESPERA_PICKER_MS = 30_000;

async function setearRangoFechas(
  vista: Page,
  selector: string,
  rango: { desde: string; hasta: string },
): Promise<string> {
  const desde = aDdMmAaaa(rango.desde);
  const hasta = aDdMmAaaa(rango.hasta);

  // Que el input sea VISIBLE no significa que ya tenga el picker.
  //
  // `primerSelectorVisible` espera una condicion de CSS, que se cumple apenas
  // se renderiza el HTML. El `$(selector).daterangepicker({...})` lo corre un
  // script externo despues — no hay ningun `document.ready` inline en la
  // pagina — asi que leer `.data('daterangepicker')` de una salia null cuando
  // el portal tardaba, y el job moria con "el input no tiene daterangepicker
  // asociado" por una carrera, no porque ARCA hubiera cambiado.
  try {
    await vista.waitForFunction(
      (selector) => {
        const jq = (window as unknown as { jQuery?: any }).jQuery;
        return Boolean(jq && jq(selector).data('daterangepicker'));
      },
      selector,
      { timeout: ESPERA_PICKER_MS },
    );
  } catch {
    // Agotada la espera si es un cambio del portal, y ahi el reintento no
    // sirve: la reaccion tiene que ser revisar los selectores.
    throw new ArcaError(
      'SELECTOR_NO_ENCONTRADO',
      `${selector} nunca recibio el daterangepicker (${ESPERA_PICKER_MS} ms)`,
    );
  }

  await vista.evaluate(
    ({ selector, desde, hasta }) => {
      const jq = (window as unknown as { jQuery?: any }).jQuery;
      if (!jq) throw new Error('jQuery no disponible en la pagina');
      const input = jq(selector);
      const picker = input.data('daterangepicker');
      if (!picker) throw new Error('el input no tiene daterangepicker asociado');
      picker.setStartDate(desde);
      picker.setEndDate(hasta);
      input.val(`${desde} - ${hasta}`).trigger('change');
    },
    { selector, desde, hasta },
  );

  // El valor leido es la confirmacion de que la fecha entro donde debia: si el
  // picker la rechaza o la reformatea, el llamador lo ve en el log.
  return vista.inputValue(selector);
}

/**
 * Entra a Mis Comprobantes y descarga el archivo nativo de ARCA.
 * ARCA lo entrega como ZIP aunque el nombre exterior termine en `.csv`.
 */
export async function exportarComprobantes(
  page: Page,
  rango: { desde: string; hasta: string },
  tipo: TipoConsultaComprobante,
  cuitCliente: string,
): Promise<string | null> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const vista = await abrirMisComprobantes(page);

  await seleccionarContribuyenteSiHaceFalta(vista, cuitCliente);

  const paso = async (nombre: string, candidatos: readonly string[]) => {
    const resultado = await primerSelectorVisible(vista, candidatos);
    const nota = resultado.indice === 0 ? '' : `  (fallback #${resultado.indice})`;
    console.log(`      ${nombre.padEnd(12)} ${resultado.selector}${nota}`);
    return resultado.selector;
  };

  try {
    console.log(`      URL servicio: ${vista.url()}`);
    const candidatosTipo =
      tipo === 'RECIBIDOS' ? MIS_COMPROBANTES.btnRecibidos : MIS_COMPROBANTES.btnEmitidos;
    await vista.click(await paso(tipo.toLowerCase(), candidatosTipo));

    const selectorFecha = await paso('fechaRango', MIS_COMPROBANTES.inputFechaRango);
    const valorRango = await setearRangoFechas(vista, selectorFecha, rango);
    console.log(`      rango        ${valorRango}`);

    await vista.click(await paso('buscar', MIS_COMPROBANTES.btnBuscar));
    await vista.waitForSelector(MIS_COMPROBANTES.contenidoResultados[0], {
      state: 'visible',
      timeout: 60_000,
    });
    console.log('      resultados cargados');

    if (await algunoPresente(vista, MIS_COMPROBANTES.sinResultados)) {
      const base = await volcarEstado(vista, 'sin-resultados');
      console.log(`      sin resultados — verificar en ${base}.png`);
      return null;
    }

    const csv = await primerSelectorVisible(vista, MIS_COMPROBANTES.btnCsv);
    const [download] = await Promise.all([
      vista.waitForEvent('download', { timeout: 60_000 }),
      vista.click(csv.selector),
    ]);

    // El CUIT va en el nombre: sin él, la exportación del segundo
    // contribuyente pisaba la del primero y se guardaban dos veces los mismos
    // comprobantes.
    const destino = join(
      ARTIFACTS_DIR,
      `comprobantes_${cuitCliente.replace(/\D/g, '')}_${tipo.toLowerCase()}_${rango.desde}_${rango.hasta}.csv`,
    );
    await download.saveAs(destino);
    return destino;
  } catch (error) {
    const base = await volcarEstado(vista, 'mis-comprobantes');
    console.error(`      estado volcado en ${base}.{png,html,url.txt}`);
    throw error;
  }
}
