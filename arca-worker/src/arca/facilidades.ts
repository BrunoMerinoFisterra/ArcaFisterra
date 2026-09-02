import type { Page } from 'playwright';
import type {
  CuotaPlanNueva,
  PlanPagoNuevo,
} from '../../../arca-api/src/repo/tipos.js';
import { algunoPresente, primerSelectorVisible, volcarEstado } from '../browser/session.js';
import { ArcaError, detectarError } from './errors.js';
import {
  MIS_FACILIDADES,
  MODAL_AGREGAR_SERVICIO,
  PORTAL,
  URLS,
  linkServicio,
} from './selectors.js';

const INTENTOS_APERTURA = 2;

interface ResumenPlanArca {
  fechaPresentacion: string | null;
  numero: string;
  cuotasTotales: number;
  concepto: string;
  montoConsolidado: number;
  estado: string;
  situacion: string;
  botonId: string;
}

interface FilaHtml {
  id: string;
  texto: string;
  tieneAccion: boolean;
}

/**
 * Lee la foto completa de Mis Facilidades para el CUIT del cliente.
 * Solo usa selección, Detalle y Ver Pagos; nunca entra a Nueva Presentación.
 */
const soloDigitos = (valor: string): string => valor.replace(/\D/g, '');
const formatearCuit = (cuit: string): string =>
  `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;

export interface PlanesFacilidades {
  planes: PlanPagoNuevo[];
  /** CUITs que el servicio ofrecio, para que el panel los liste. */
  contribuyentes: string[];
}

/**
 * Lee los planes de todas las empresas que la clave representa acá.
 *
 * A diferencia de Cuentas Tributarias y del DFE, Mis Facilidades NO tiene una
 * vista de "todos": hay que elegir un contribuyente, aceptar, y el servicio
 * queda posicionado en el. Cambiar al siguiente obliga a volver a entrar —
 * verificado con `npm run spike:representados`. Por eso este es el unico modulo
 * cuyo tiempo crece con la cantidad de empresas.
 *
 * Con `soloCuit` recorre una sola: es lo que usa el boton dentro de una empresa.
 */
export async function extraerPlanesFacilidades(
  page: Page,
  cuitCliente: string,
  opciones: { soloCuit?: string } = {},
): Promise<PlanesFacilidades> {
  const primeraVista = await abrirMisFacilidades(page);
  const contribuyentes = await listarContribuyentesFacilidades(primeraVista, cuitCliente);

  const objetivo = opciones.soloCuit ? soloDigitos(opciones.soloCuit) : null;
  if (objetivo && !contribuyentes.includes(objetivo)) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `Mis Facilidades no ofrece el CUIT ${opciones.soloCuit}`,
    );
  }
  const aRecorrer = objetivo ? [objetivo] : contribuyentes;

  const planes: PlanPagoNuevo[] = [];
  for (const [indice, cuit] of aRecorrer.entries()) {
    // La primera ya esta abierta; para las siguientes hay que reentrar.
    const vista = indice === 0 ? primeraVista : await abrirMisFacilidades(page);
    if (aRecorrer.length > 1) {
      console.log(`      CUIT ${indice + 1}/${aRecorrer.length}: ${formatearCuit(cuit)}`);
    }
    planes.push(...(await leerPlanesDeUnCuit(vista, cuit)));
  }
  return { planes, contribuyentes };
}

/**
 * Los CUITs que ofrece el combo. Si no hay combo, la clave representa a uno
 * solo y es el titular.
 */
async function listarContribuyentesFacilidades(
  vista: Page,
  cuitCliente: string,
): Promise<string[]> {
  const combo = vista.locator(MIS_FACILIDADES.selectorCuit);
  if ((await combo.count()) !== 1) return [soloDigitos(cuitCliente)];

  const valores = await combo
    .locator('option')
    .evaluateAll((elementos) => elementos.map((o) => (o as HTMLOptionElement).value));
  const cuits = valores.map((valor: string) => soloDigitos(valor)).filter((cuit) => cuit.length === 11);
  return cuits.length > 0 ? [...new Set(cuits)] : [soloDigitos(cuitCliente)];
}

async function leerPlanesDeUnCuit(vista: Page, cuitCliente: string): Promise<PlanPagoNuevo[]> {
  try {
    await seleccionarCuit(vista, cuitCliente);
    const resumenes = await leerResumenes(vista);
    const planes: PlanPagoNuevo[] = [];

    for (const [indice, resumen] of resumenes.entries()) {
      console.log(`      plan ${indice + 1}/${resumenes.length}: ${resumen.numero}`);
      await navegarConAccion(vista, () =>
        vista.locator(`#${resumen.botonId}`).evaluate((elemento: HTMLElement) => elemento.click()),
      );
      await validarRespuestaFacilidades(vista);

      const detalle = await leerCabeceraDetalle(vista);
      let cuotas: CuotaPlanNueva[] = [];
      let totalPagado = 0;
      let entroEnPagos = false;
      const verPagos = vista.locator(MIS_FACILIDADES.verPagos);
      if ((await verPagos.count()) === 1) {
        await navegarConAccion(vista, () => verPagos.click());
        await validarRespuestaFacilidades(vista);
        entroEnPagos = true;
        cuotas = await leerCuotas(vista);
        totalPagado = await leerTotalPagado(vista);
      }

      planes.push(
        construirPlan(
          {
            ...resumen,
            numero: detalle.numero || resumen.numero,
            concepto: detalle.concepto || resumen.concepto,
            fechaConsolidacion: detalle.fechaConsolidacion,
            tipoPlan: detalle.tipoPlan,
            cuotas,
            totalPagado,
          },
          soloDigitos(cuitCliente),
        ),
      );

      await volverAlListado(vista, entroEnPagos);
      await verificarCuitActivo(vista, cuitCliente.replace(/\D/g, ''));
    }

    return planes;
  } catch (error) {
    const base = await volcarEstado(vista, 'mis-facilidades');
    console.error(`      estado volcado en ${base}.{png,html,url.txt}`);
    throw error;
  }
}

async function abrirMisFacilidades(page: Page): Promise<Page> {
  let ultimoError: unknown;

  for (let intento = 1; intento <= INTENTOS_APERTURA; intento += 1) {
    let vista: Page = page;
    try {
      await page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
      const buscador = await primerSelectorVisible(page, PORTAL.inputBuscar);
      await page.fill(buscador.selector, MIS_FACILIDADES.servicio);
      await page.waitForTimeout(1_500);

      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
        page.click(linkServicio(MIS_FACILIDADES.servicio)),
      ]);
      vista = popup ?? page;
      await vista.waitForLoadState('domcontentloaded');

      if (await algunoPresente(vista, MODAL_AGREGAR_SERVICIO.contenedor)) {
        throw new ArcaError(
          'SERVICIO_NO_ADHERIDO',
          `el portal ofreció agregar "${MIS_FACILIDADES.servicio}"`,
        );
      }

      await validarRespuestaFacilidades(vista);
      return vista;
    } catch (error) {
      ultimoError = error;
      const reintentable =
        error instanceof ArcaError &&
        (error.code === 'PORTAL_NO_DISPONIBLE' || error.code === 'TIMEOUT');
      if (!reintentable || intento === INTENTOS_APERTURA) throw error;

      console.log(
        `      Mis Facilidades devolvió una respuesta transitoria; reintentando ` +
          `(${intento}/${INTENTOS_APERTURA})...`,
      );
      if (vista !== page && !vista.isClosed()) await vista.close().catch(() => undefined);
      await page.waitForTimeout(2_000);
    }
  }

  throw ultimoError;
}

async function validarRespuestaFacilidades(vista: Page): Promise<void> {
  const texto = limpiar((await vista.locator('body').textContent().catch(() => '')) ?? '');
  if (esBloqueoTemporalFacilidades(texto)) {
    throw new ArcaError(
      'PORTAL_NO_DISPONIBLE',
      'Mis Facilidades devolvió un bloqueo temporal de sesión',
    );
  }
  const errorConocido = detectarError(texto);
  if (errorConocido) throw errorConocido;
}

export function esBloqueoTemporalFacilidades(texto: string): boolean {
  return /^BL\d{6,}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})?$/i.test(
    limpiar(texto),
  );
}

async function navegarConAccion(vista: Page, accion: () => Promise<unknown>): Promise<void> {
  await Promise.all([
    vista.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    accion(),
  ]);
}

async function volverAlListado(vista: Page, desdePagos: boolean): Promise<void> {
  if (desdePagos) {
    const volverPagos = vista.locator(MIS_FACILIDADES.volverDesdePagos).first();
    if ((await volverPagos.count()) !== 1) {
      throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'botón Volver de pagos de Mis Facilidades');
    }
    await navegarConAccion(vista, () => volverPagos.click());
    await validarRespuestaFacilidades(vista);
  }

  const volverDetalle = vista.locator(MIS_FACILIDADES.volverDesdeDetalle);
  if ((await volverDetalle.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'botón Volver del detalle de Mis Facilidades');
  }
  await navegarConAccion(vista, () => volverDetalle.click());
  await validarRespuestaFacilidades(vista);
}

async function seleccionarCuit(vista: Page, cuitCliente: string): Promise<void> {
  const digitos = cuitCliente.replace(/\D/g, '');
  if (digitos.length !== 11) {
    throw new ArcaError('DESCONOCIDO', `CUIT de cliente inválido: ${cuitCliente}`);
  }

  const selector = vista.locator(MIS_FACILIDADES.selectorCuit);
  if ((await selector.count()) === 1) {
    const opcion = selector.locator(`option[value="${digitos}"]`);
    if ((await opcion.count()) !== 1) {
      throw new ArcaError(
        'REPRESENTADO_NO_DISPONIBLE',
        `Mis Facilidades no ofrece el CUIT ${cuitCliente}`,
      );
    }
    await selector.selectOption(digitos);
    await navegarConAccion(vista, () => vista.click(MIS_FACILIDADES.aceptarCuit));
    await validarRespuestaFacilidades(vista);
    await verificarCuitActivo(vista, digitos);
    return;
  }

  await verificarCuitActivo(vista, digitos);
}

async function verificarCuitActivo(vista: Page, esperado: string): Promise<void> {
  const campo = vista.locator(MIS_FACILIDADES.cuitActivo);
  if ((await campo.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', 'Mis Facilidades no informó el CUIT activo');
  }
  const cuitActivo = ((await campo.textContent()) ?? '').replace(/\D/g, '');
  if (cuitActivo !== esperado) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `Mis Facilidades abrió el CUIT ${cuitActivo || '(vacío)'} en lugar de ${esperado}`,
    );
  }
}

async function leerResumenes(vista: Page): Promise<ResumenPlanArca[]> {
  const filas = vista.locator(MIS_FACILIDADES.filasPlanes);
  const cantidad = await filas.count();
  const resumenes: ResumenPlanArca[] = [];
  for (let indice = 0; indice < cantidad; indice += 1) {
    const fila = filas.nth(indice);
    const celdas = (await fila.locator('td').allTextContents()).map(limpiar);
    const boton = fila.locator(MIS_FACILIDADES.botonDetalle);
    if (celdas.length < 7 || (await boton.count()) !== 1) continue;
    const botonId = await boton.getAttribute('id');
    if (!botonId) continue;
    resumenes.push({
      fechaPresentacion: aFechaIso(celdas[0] ?? ''),
      numero: celdas[1] ?? '',
      cuotasTotales: Number.parseInt(celdas[2] ?? '0', 10) || 0,
      concepto: celdas[3] ?? '',
      montoConsolidado: aNumeroArca(celdas[4] ?? ''),
      estado: celdas[5] ?? '',
      situacion: celdas[6] ?? '',
      botonId,
    });
  }
  return resumenes;
}

async function leerCabeceraDetalle(vista: Page): Promise<{
  concepto: string;
  numero: string;
  fechaConsolidacion: string | null;
  tipoPlan: string;
}> {
  const texto = async (selector: string) => limpiar((await vista.locator(selector).textContent()) ?? '');
  return {
    concepto: await texto(MIS_FACILIDADES.detalleConcepto),
    numero: await texto(MIS_FACILIDADES.detalleNumero),
    fechaConsolidacion: aFechaIso(
      await texto(MIS_FACILIDADES.detalleFechaConsolidacion),
    ),
    tipoPlan: await texto(MIS_FACILIDADES.detalleTipoPlan),
  };
}

async function leerCuotas(vista: Page): Promise<CuotaPlanNueva[]> {
  const filas = await vista
    .locator(MIS_FACILIDADES.filasCuotas)
    .evaluateAll((elementos) =>
      elementos.map((fila) =>
        Array.from(fila.querySelectorAll('td')).map((celda) => ({
          id: celda.id,
          texto: celda.textContent ?? '',
          tieneAccion: Boolean(celda.querySelector('a, button, input')),
        })),
      ),
    );

  const resultado: CuotaPlanNueva[] = [];
  const variantes = new Map<number, number>();
  let numeroActual = 0;
  let capitalActual = 0;
  let estadoActual = '';

  for (const celdas of filas as FilaHtml[][]) {
    const cuota = celdas.find((c) => c.id.includes('tdCuotaNro_'));
    const capital = celdas.find((c) => c.id.includes('tdCapital_'));
    const estado = celdas.find((c) => c.id.includes('tdEstadoCuota_'));
    const indiceFinanciero = celdas.findIndex((c) => c.id.includes('tdInteresFinanciero_'));
    if (cuota) numeroActual = Number.parseInt(limpiar(cuota.texto), 10) || numeroActual;
    if (capital) capitalActual = aNumeroArca(capital.texto);
    if (estado) estadoActual = limpiar(estado.texto);
    if (numeroActual <= 0 || indiceFinanciero < 0) continue;

    const variante = (variantes.get(numeroActual) ?? 0) + 1;
    variantes.set(numeroActual, variante);
    const pago = celdas[indiceFinanciero + 4];
    resultado.push({
      numero: numeroActual,
      variante,
      capital: capitalActual,
      interesFinanciero: aNumeroArca(celdas[indiceFinanciero]?.texto ?? ''),
      interesResarcitorio: aNumeroArca(celdas[indiceFinanciero + 1]?.texto ?? ''),
      total: aNumeroArca(celdas[indiceFinanciero + 2]?.texto ?? ''),
      fechaVencimiento: aFechaIso(celdas[indiceFinanciero + 3]?.texto ?? ''),
      pago: pago?.tieneAccion && !limpiar(pago.texto) ? 'Disponible' : limpiar(pago?.texto ?? ''),
      estado: estadoActual,
    });
  }
  return resultado;
}

async function leerTotalPagado(vista: Page): Promise<number> {
  const celda = vista.locator(MIS_FACILIDADES.totalPagado).nth(4);
  return (await celda.count()) === 1 ? aNumeroArca((await celda.textContent()) ?? '') : 0;
}

export function construirPlan(
  datos: ResumenPlanArca & {
    fechaConsolidacion: string | null;
    tipoPlan: string;
    cuotas: CuotaPlanNueva[];
    totalPagado: number;
  },
  /** De que empresa es el plan. El numero solo es unico dentro de su CUIT. */
  contribuyenteCuit: string,
): PlanPagoNuevo {
  const numeros = [...new Set(datos.cuotas.map((c) => c.numero))];
  const estadosPorCuota = new Map<number, string>();
  for (const cuota of datos.cuotas) {
    if (cuota.estado) estadosPorCuota.set(cuota.numero, cuota.estado);
  }
  const pagas = numeros.filter((n) => esPagada(estadosPorCuota.get(n) ?? '')).length;
  const impagas = numeros.filter((n) => normalizar(estadosPorCuota.get(n) ?? '').includes('impaga')).length;
  const pendientes = datos.cuotas.filter((c) => !esPagada(estadosPorCuota.get(c.numero) ?? ''));
  const hoy = fechaHoyIso();
  const proxima = pendientes
    .filter((c) => c.fechaVencimiento && c.fechaVencimiento >= hoy)
    .toSorted((a, b) => (a.fechaVencimiento ?? '').localeCompare(b.fechaVencimiento ?? ''))[0]
    ?? pendientes.toSorted((a, b) =>
      (b.fechaVencimiento ?? '').localeCompare(a.fechaVencimiento ?? ''),
    )[0];

  return {
    contribuyenteCuit,
    numero: datos.numero,
    concepto: datos.concepto,
    fechaPresentacion: datos.fechaPresentacion,
    fechaConsolidacion: datos.fechaConsolidacion,
    tipoPlan: datos.tipoPlan,
    montoConsolidado: datos.montoConsolidado,
    estado: datos.estado,
    situacion: datos.situacion,
    cuotasTotales: datos.cuotasTotales || numeros.length,
    cuotasPagas: pagas,
    cuotasImpagas: impagas,
    montoCuota: proxima?.total ?? datos.cuotas.at(-1)?.total ?? 0,
    proximoVencimiento: proxima?.fechaVencimiento ?? null,
    totalPagado: datos.totalPagado,
    cuotas: datos.cuotas,
  };
}

export function aNumeroArca(valor: string): number {
  const limpio = valor.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const numero = Number.parseFloat(limpio);
  return Number.isFinite(numero) ? numero : 0;
}

export function aFechaIso(valor: string): string | null {
  const partes = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(limpiar(valor));
  if (!partes) return null;
  return `${partes[3]}-${partes[2]?.padStart(2, '0')}-${partes[1]?.padStart(2, '0')}`;
}

function esPagada(estado: string): boolean {
  const valor = normalizar(estado);
  return valor.includes('cancelada') || valor.includes('pagada');
}

function limpiar(valor: string): string {
  return valor.replace(/\s+/g, ' ').trim();
}

function normalizar(valor: string): string {
  return limpiar(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-AR');
}

function fechaHoyIso(): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return `${partes['year']}-${partes['month']}-${partes['day']}`;
}
