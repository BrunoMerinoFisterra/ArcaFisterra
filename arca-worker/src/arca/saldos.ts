import type { Frame, Page } from 'playwright';
import type {
  DeclaracionJuradaPendienteNueva,
  SaldoTributarioNuevo,
  VencimientoNuevo,
} from '../../../arca-api/src/repo/tipos.js';
import { algunoPresente, primerSelectorVisible, volcarEstado } from '../browser/session.js';
import { ArcaError } from './errors.js';
import { aFechaIso, aNumeroArca } from './facilidades.js';
import { login } from './login.js';
import {
  CUENTAS_TRIBUTARIAS,
  MODAL_AGREGAR_SERVICIO,
  PORTAL,
  URLS,
  linkServicio,
} from './selectors.js';

interface OpcionCuit {
  value: string;
  cuit: string;
}

type SaldoExtraido = Omit<SaldoTributarioNuevo, 'contribuyenteCuit'>;
type VencimientoExtraido = Omit<VencimientoNuevo, 'contribuyenteCuit'>;
type DdjjExtraida = Omit<DeclaracionJuradaPendienteNueva, 'contribuyenteCuit'>;

interface DatosCuitExtraidos {
  saldos: SaldoExtraido[];
  vencimientos: VencimientoExtraido[];
  ddjjPendientes: DdjjExtraida[];
}

export interface DatosCuentasTributarias {
  saldos: SaldoTributarioNuevo[];
  vencimientos: VencimientoNuevo[];
  ddjjPendientes: DeclaracionJuradaPendienteNueva[];
}

/**
 * Lee Vencimientos, Deudas y DDJJ de todos los CUIT que ARCA ofrece en el
 * selector. Esos representados pertenecen a la credencial del cliente padre y
 * no son altas de clientes de la app ni consumen cupo.
 */
export async function extraerCuentasTributarias(
  page: Page,
  cuitCliente: string,
  usuarioCuit: string,
  clave: string,
): Promise<DatosCuentasTributarias> {
  const vista = await abrirServicio(page, usuarioCuit, clave);
  try {
    const cuits = await contribuyentesDisponibles(vista);
    const cuitPadre = soloDigitos(cuitCliente);
    if (!cuits.some((opcion) => opcion.cuit === cuitPadre)) {
      throw new ArcaError(
        'REPRESENTADO_NO_DISPONIBLE',
        `Sistema de Cuentas Tributarias no ofrece el CUIT ${cuitCliente}`,
      );
    }

    const resultado: DatosCuentasTributarias = {
      saldos: [],
      vencimientos: [],
      ddjjPendientes: [],
    };
    for (const [indice, opcion] of cuits.entries()) {
      const contribuyenteCuit = formatearCuit(opcion.cuit);
      console.log(`      CUIT ${indice + 1}/${cuits.length}: ${contribuyenteCuit}`);
      await seleccionarCuit(vista, opcion.cuit);
      const datos = await leerCuitConReintentos(vista);
      resultado.saldos.push(
        ...datos.saldos.map((saldo) => ({ ...saldo, contribuyenteCuit })),
      );
      resultado.vencimientos.push(
        ...datos.vencimientos.map((vencimiento) => ({ ...vencimiento, contribuyenteCuit })),
      );
      resultado.ddjjPendientes.push(
        ...datos.ddjjPendientes.map((declaracion) => ({ ...declaracion, contribuyenteCuit })),
      );
    }
    return resultado;
  } catch (error) {
    const base = await volcarEstado(vista, 'sistema-cuentas-tributarias');
    console.error(`      estado volcado en ${base}.{png,html,url.txt}`);
    throw error;
  }
}

async function leerCuitConReintentos(vista: Page): Promise<DatosCuitExtraidos> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= 3; intento += 1) {
    const marco = await marcoSaldos(vista);
    try {
      return await leerMarcoCuentas(marco, vista);
    } catch (error) {
      ultimoError = error;
      if (!esMarcoDesprendido(error) || intento === 3) throw error;
      console.log(`      iframe reemplazado por ARCA; reintentando (${intento}/3)...`);
      await vista.waitForTimeout(500);
    }
  }
  throw ultimoError ?? new ArcaError('DESCONOCIDO', 'no se pudo estabilizar Cuentas Tributarias');
}

async function leerMarcoCuentas(
  marco: Frame,
  vista: Page,
): Promise<DatosCuitExtraidos> {
  const tabVencimientos = marco.locator(CUENTAS_TRIBUTARIAS.tabVencimientos);
  const tablaVencimientosVisible = marco
    .locator(`${CUENTAS_TRIBUTARIAS.tablaVencimientos}:visible`)
    .first();
  // En ciertos representados ARCA carga el encabezado del servicio pero no
  // publica ninguna pestaña. Esperamos una ventana breve por la respuesta
  // asíncrona y, si sigue vacío, ese CUIT aporta cero filas y no bloquea a los
  // demás delegados.
  await Promise.race([
    tabVencimientos.waitFor({ state: 'visible', timeout: 8_000 }),
    tablaVencimientosVisible.waitFor({ state: 'visible', timeout: 8_000 }),
  ]).catch(() => {});
  const cantidadTabsVencimientos = await tabVencimientos.count();
  if (
    cantidadTabsVencimientos === 0 &&
    (await tablaVencimientosVisible.count()) === 0
  ) {
    return { saldos: [], vencimientos: [], ddjjPendientes: [] };
  }
  if (cantidadTabsVencimientos > 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'pestaña Vencimientos ambigua en Cuentas Tributarias');
  }
  if (cantidadTabsVencimientos === 1) {
    const tabVencimientosActivo = marco.locator(CUENTAS_TRIBUTARIAS.tabVencimientosActivo);
    if ((await tabVencimientosActivo.count()) !== 1) {
      await tabVencimientos.click();
      await tabVencimientosActivo.waitFor();
    }
  }

  // ARCA oculta el tab "Vencimientos" para algunos contribuyentes y deja la
  // tabla como contenido inicial. La tabla visible existe en ambas variantes.
  const tablaVencimientos = tablaVencimientosVisible;
  await tablaVencimientos.waitFor({ state: 'visible' });
  const panelVencimientos = marco.locator(CUENTAS_TRIBUTARIAS.panelActivo);
  const contenedorVencimientos =
    (await panelVencimientos.count()) === 1 ? panelVencimientos : marco.locator('body');
  await mostrarTodasLasFilas(contenedorVencimientos, vista);
  const filasVencimientos = await tablaVencimientos
    .locator('tbody tr:not(.b-table-empty-row)')
    .evaluateAll((elementos) =>
      elementos.map((fila) =>
        Array.from(fila.querySelectorAll('td')).map((celda) => celda.textContent ?? ''),
      ),
    );
  const vencimientos = filasVencimientos
    .map((celdas) => vencimientoDesdeCeldas(celdas))
    .filter((vencimiento): vencimiento is VencimientoExtraido => vencimiento !== null);

  const tabDeudas = marco.locator(CUENTAS_TRIBUTARIAS.tabDeudas);
  await tabDeudas.waitFor();
  if ((await tabDeudas.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'pestaña Deudas de Cuentas Tributarias');
  }
  let saldos: SaldoExtraido[] = [];
  if (await controlHabilitado(tabDeudas)) {
    await tabDeudas.click();
    await marco.locator(CUENTAS_TRIBUTARIAS.tabDeudasActivo).waitFor();
    await marco.waitForFunction(() => !document.body.classList.contains('loader-open'));

    const panel = marco.locator(CUENTAS_TRIBUTARIAS.panelActivo);
    const tabla = panel.locator(CUENTAS_TRIBUTARIAS.tablaDeudas);
    await tabla.waitFor();
    await mostrarTodasLasFilas(panel, vista);

    const filas = await tabla.locator('tbody tr:not(.b-table-empty-row)').evaluateAll((elementos) =>
      elementos.map((fila) =>
        Array.from(fila.querySelectorAll('td')).map((celda) => celda.textContent ?? ''),
      ),
    );
    saldos = filas
      .map((celdas) => saldoDesdeCeldas(celdas))
      .filter((saldo): saldo is SaldoExtraido => saldo !== null);
  }

  const tabDdjj = marco.locator(CUENTAS_TRIBUTARIAS.tabDdjj);
  await tabDdjj.waitFor();
  if ((await tabDdjj.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'pestaña DDJJ pendientes de Cuentas Tributarias');
  }
  let ddjjPendientes: DdjjExtraida[] = [];
  if (await controlHabilitado(tabDdjj)) {
    await tabDdjj.click();
    await marco.locator(CUENTAS_TRIBUTARIAS.tabDdjjActivo).waitFor();
    await marco.waitForFunction(() => !document.body.classList.contains('loader-open'));

    const panelDdjj = marco.locator(CUENTAS_TRIBUTARIAS.panelActivo);
    const tablaDdjj = panelDdjj.locator(CUENTAS_TRIBUTARIAS.tablaDdjj);
    await tablaDdjj.waitFor();
    await mostrarTodasLasFilas(panelDdjj, vista);
    const filasDdjj = await tablaDdjj
      .locator('tbody tr:not(.b-table-empty-row)')
      .evaluateAll((elementos) =>
        elementos.map((fila) =>
          Array.from(fila.querySelectorAll('td')).map((celda) => celda.textContent ?? ''),
        ),
      );
    ddjjPendientes = filasDdjj
      .map((celdas) => ddjjDesdeCeldas(celdas))
      .filter((declaracion): declaracion is DdjjExtraida => declaracion !== null);
  }

  return { saldos, vencimientos, ddjjPendientes };
}

function esMarcoDesprendido(error: unknown): boolean {
  return error instanceof Error && /frame was detached|detached frame/i.test(error.message);
}

async function mostrarTodasLasFilas(
  panel: ReturnType<Frame['locator']>,
  vista: Page,
): Promise<void> {
  const selectorCantidad = panel.locator(CUENTAS_TRIBUTARIAS.selectorCantidad);
  const selectorVisible = selectorCantidad.filter({ visible: true });
  if ((await selectorVisible.count()) >= 1 && (await selectorVisible.first().isEnabled())) {
    await selectorVisible.first().selectOption('-1');
    await vista.waitForTimeout(300);
  }
}

async function controlHabilitado(control: ReturnType<Frame['locator']>): Promise<boolean> {
  return (
    (await control.getAttribute('aria-disabled')) !== 'true' &&
    !(await control.evaluate((elemento) => elemento.classList.contains('disabled')))
  );
}

async function abrirServicio(page: Page, usuarioCuit: string, clave: string): Promise<Page> {
  await page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
  const buscador = await primerSelectorVisible(page, PORTAL.inputBuscar);
  await page.fill(buscador.selector, CUENTAS_TRIBUTARIAS.servicio);
  await page.waitForTimeout(1_500);
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    page.click(linkServicio(CUENTAS_TRIBUTARIAS.servicio)),
  ]);
  const vista = popup ?? page;
  await vista.waitForLoadState('domcontentloaded');

  if (await algunoPresente(vista, MODAL_AGREGAR_SERVICIO.contenedor)) {
    throw new ArcaError(
      'SERVICIO_NO_ADHERIDO',
      `el portal ofreció agregar "${CUENTAS_TRIBUTARIAS.servicio}"`,
    );
  }

  if (/auth\.afip\.gob\.ar\/contribuyente_\/login\.xhtml/i.test(vista.url())) {
    await login(vista, usuarioCuit, clave, [CUENTAS_TRIBUTARIAS.urlServicio]);
    await vista.waitForLoadState('domcontentloaded');
  }
  if (!CUENTAS_TRIBUTARIAS.urlServicio.test(vista.url())) {
    throw new ArcaError('DESCONOCIDO', `destino inesperado de Cuentas Tributarias: ${vista.url()}`);
  }
  return vista;
}

export async function seleccionarCuit(
  vista: Page,
  cuitCliente: string,
  // Parametrizado solo para que los tests no paguen la espera real; en el
  // worker siempre corre con el default.
  esperaComboMs: number = ESPERA_COMBO_CUIT_MS,
): Promise<void> {
  const esperado = soloDigitos(cuitCliente);
  if (esperado.length !== 11) {
    throw new ArcaError('DESCONOCIDO', `CUIT de cliente inválido: ${cuitCliente}`);
  }

  const selector = vista.locator(CUENTAS_TRIBUTARIAS.selectorCuit);
  const opciones = await listarCuits(vista, esperaComboMs);

  // Sin combo: la clave representa a uno solo y ARCA entro ya posicionado. No
  // alcanza con asumir que es el nuestro —seria elegir al representado sin
  // mirar el CUIT, justo lo que el resto del worker evita—, asi que se exige la
  // misma coincidencia exacta contra el cartel que el servicio deja en pantalla.
  if (opciones === null) {
    const activo = await cuitActivoEnPantalla(vista);
    if (activo === esperado) return;
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      activo
        ? `Cuentas Tributarias entro con el CUIT ${activo} y no ofrece cambiarlo por ${esperado}`
        : `Cuentas Tributarias no ofrece elegir contribuyente ni informa cual tiene activo`,
    );
  }

  const opcion = opciones.find((candidata) => candidata.cuit === esperado);
  if (!opcion) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `Sistema de Cuentas Tributarias no ofrece el CUIT ${cuitCliente}`,
    );
  }

  if ((await selector.inputValue()) !== opcion.value) {
    await Promise.all([
      vista.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      selector.selectOption(opcion.value),
    ]);
  }
  const activo = ((await vista.locator(`${CUENTAS_TRIBUTARIAS.selectorCuit} option:checked`).textContent()) ?? '')
    .replace(/\D/g, '');
  if (activo !== esperado) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `Cuentas Tributarias activó el CUIT ${activo || '(vacío)'} en lugar de ${esperado}`,
    );
  }
}

/**
 * Los contribuyentes que hay para recorrer, venga la pantalla con combo o sin el.
 *
 * Sin combo la lista es de uno: el que el servicio ya tiene activo. Se lo lee
 * del cartel en vez de asumir que es el cliente, porque quien decide si
 * corresponde es la comparacion por CUIT exacto que hace el llamador.
 */
async function contribuyentesDisponibles(vista: Page): Promise<OpcionCuit[]> {
  const combo = await listarCuits(vista, ESPERA_COMBO_CUIT_MS);
  if (combo !== null) return combo;

  const activo = await cuitActivoEnPantalla(vista);
  if (!activo) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      'Cuentas Tributarias no ofrece elegir contribuyente ni informa cual tiene activo',
    );
  }
  return [{ value: '', cuit: activo }];
}

/**
 * CUIT que el servicio muestra como activo, o `''` si no lo informa.
 *
 * Exige que el cartel sea uno solo: con varios no hay forma de saber cual manda,
 * y adivinar seria elegir al representado a ciegas.
 */
async function cuitActivoEnPantalla(vista: Page): Promise<string> {
  const cartel = vista.locator(CUENTAS_TRIBUTARIAS.cuitActivo);
  if ((await cartel.count()) !== 1) return '';
  return soloDigitos((await cartel.textContent()) ?? '');
}

/**
 * Cuanto se espera al combo de contribuyentes antes de dar por hecho que esta
 * pantalla no lo tiene. Sin este tope heredaba el default del contexto (30 s) y
 * una clave con un solo representado —que nunca va a ver el combo— terminaba en
 * un TimeoutError de Playwright, reportado como "el portal tardo demasiado" con
 * reaccion REINTENTAR. El reintento fallaba igual: la condicion es estable, no
 * lentitud del portal.
 */
const ESPERA_COMBO_CUIT_MS = 8_000;

/** Los contribuyentes del combo, o `null` si esta pantalla no lo trae. */
async function listarCuits(vista: Page, esperaMs: number): Promise<OpcionCuit[] | null> {
  const selector = vista.locator(CUENTAS_TRIBUTARIAS.selectorCuit);
  try {
    await selector.waitFor({ timeout: esperaMs });
  } catch {
    return null;
  }
  if ((await selector.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'selector de CUIT de Cuentas Tributarias');
  }
  const opciones = (await selector.locator('option').evaluateAll((elementos) =>
    elementos.map((opcion) => {
      const etiqueta = opcion.textContent ?? '';
      const coincidencia = etiqueta.match(/\d{2}\D?\d{8}\D?\d/);
      return {
        value: (opcion as HTMLOptionElement).value,
        cuit: (coincidencia?.[0] ?? '').replace(/\D/g, ''),
      };
    }),
  )) as OpcionCuit[];
  const unicos = new Map<string, OpcionCuit>();
  for (const opcion of opciones) {
    if (opcion.cuit.length === 11 && !unicos.has(opcion.cuit)) unicos.set(opcion.cuit, opcion);
  }
  return [...unicos.values()];
}

async function marcoSaldos(vista: Page): Promise<Frame> {
  await vista.locator(CUENTAS_TRIBUTARIAS.iframe).waitFor();
  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    const candidatos = vista.frames()
      .filter((frame) => /homeContribuyente/i.test(frame.url()))
      .reverse();
    for (const marco of candidatos) {
      if (marco.isDetached()) continue;
      try {
        if ((await marco.locator('#home').count()) === 1) return marco;
      } catch {
        // El iframe anterior puede desprenderse mientras cambia el CUIT.
      }
    }
    await vista.waitForTimeout(250);
  }
  throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'panel interno de Cuentas Tributarias');
}

export function saldoDesdeCeldas(celdas: string[]): SaldoExtraido | null {
  if (celdas.length < 12) return null;
  const impuesto = limpiar(celdas[3] ?? '');
  const periodo = periodoArca(celdas[6] ?? '');
  if (!impuesto || !periodo) return null;
  return {
    establecimiento: limpiar(celdas[1] ?? ''),
    impuesto,
    concepto: limpiar(celdas[4] ?? ''),
    subconcepto: limpiar(celdas[5] ?? ''),
    periodo,
    anticipoCuota: limpiar(celdas[7] ?? ''),
    fechaVencimiento: aFechaIso(limpiar(celdas[8] ?? '')),
    saldo: aDeuda(celdas[9] ?? ''),
    interesResarcitorio: aDeuda(celdas[10] ?? ''),
    interesPunitorio: aDeuda(celdas[11] ?? ''),
  };
}

export function vencimientoDesdeCeldas(celdas: string[]): VencimientoExtraido | null {
  if (celdas.length < 7) return null;
  const impuesto = limpiar(celdas[0] ?? '');
  const periodo = periodoArca(celdas[3] ?? '');
  const fecha = aFechaIso(limpiar(celdas[5] ?? ''));
  if (!impuesto || !periodo || !fecha) return null;
  return {
    impuesto,
    concepto: limpiar(celdas[1] ?? ''),
    subconcepto: limpiar(celdas[2] ?? ''),
    periodo,
    anticipoCuota: limpiar(celdas[4] ?? ''),
    fecha,
    detalle: limpiar(celdas[6] ?? ''),
  };
}

export function ddjjDesdeCeldas(celdas: string[]): DdjjExtraida | null {
  if (celdas.length < 5) return null;
  const impuesto = limpiar(celdas[1] ?? '');
  const periodo = periodoArca(celdas[4] ?? '');
  if (!impuesto || !periodo) return null;
  return {
    establecimiento: limpiar(celdas[0] ?? ''),
    impuesto,
    concepto: limpiar(celdas[2] ?? ''),
    subconcepto: limpiar(celdas[3] ?? ''),
    periodo,
    fecha: aFechaIso(limpiar(celdas[5] ?? '')),
  };
}

export function periodoArca(valor: string): string {
  const limpio = limpiar(valor);
  const anual = /^(\d{4})0000$/.exec(limpio);
  if (anual) return anual[1] ?? limpio;
  const mensual = /^(\d{4})(0[1-9]|1[0-2])(?:00)?$/.exec(limpio);
  if (mensual) return `${mensual[2]}/${mensual[1]}`;
  return limpio;
}

function aDeuda(valor: string): number {
  const importe = Math.abs(aNumeroArca(valor));
  return importe === 0 ? 0 : -importe;
}

function limpiar(valor: string): string {
  return valor.replace(/\s+/g, ' ').trim();
}

function soloDigitos(cuit: string): string {
  return cuit.replace(/\D/g, '');
}

function formatearCuit(cuit: string): string {
  const limpio = soloDigitos(cuit);
  return limpio.length === 11
    ? `${limpio.slice(0, 2)}-${limpio.slice(2, 10)}-${limpio.slice(10)}`
    : cuit;
}
