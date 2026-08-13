import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { NotificacionNueva } from '../../../arca-api/src/repo/tipos.js';
import { primerSelectorVisible, volcarEstado } from '../browser/session.js';
import { ArcaError } from './errors.js';
import { PORTAL, URLS } from './selectors.js';

const SERVICIO = 'Domicilio Fiscal Electrónico';
const TAB_PROPIAS = '#mis-comunicaciones-tab';
const TAB_REPRESENTADOS = '#representados-comunicaciones-tab';

export interface FilaDfe {
  idComunicacion: string;
  fecha: string;
  organismo: string;
  asunto: string;
  clases: string[];
}

interface RespuestaDetalleDfe {
  comunicacion?: {
    mensaje?: unknown;
    adjuntos?: Array<{
      adjunto?: {
        filename?: unknown;
        contentSize?: unknown;
        idArchivo?: unknown;
      };
    }>;
  };
}

export interface OpcionesDetallesDfe {
  detallesExistentes?: ReadonlySet<string>;
  /**
   * Opt-in obligatorio. El GET de detalle abre la comunicación en ARCA y
   * puede perfeccionar una notificación que todavía figuraba sin leer.
   */
  abrirNoLeidasAutorizadas?: boolean;
}

export interface ResultadoDetallesDfe {
  completados: number;
  abiertasEnArca: number;
  pendientesDeReintento: number;
}

/**
 * Lee primero la bandeja completa del DFE. Recién después descarga detalles:
 * siempre los ya leídos y, con opt-in explícito, también los que la bandeja
 * informó sin leer. Así se conserva el estado observado antes de que el GET de
 * detalle abra la comunicación en ARCA.
 */
export async function extraerNotificacionesDfe(
  page: Page,
  cuitCliente: string,
  cuitUsuario: string,
  opciones: OpcionesDetallesDfe = {},
): Promise<NotificacionNueva[]> {
  await page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
  const buscador = await primerSelectorVisible(page, PORTAL.inputBuscar);
  await page.fill(buscador.selector, SERVICIO);
  await page.waitForTimeout(1_200);

  const enlace = page.locator(
    `li[role="option"][aria-label="${SERVICIO}"] a.dropdown-item`,
  );
  if ((await enlace.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', `No se encontró el servicio ${SERVICIO}`);
  }

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
    enlace.click(),
  ]);
  const vista = popup ?? page;
  await vista.waitForLoadState('domcontentloaded');

  try {
    // Ambos modales llegan por AJAX después del DOMContentLoaded. Esperar acá
    // evita que aparezcan justo mientras se intenta cambiar de pestaña.
    await cerrarAvisosDfe(vista, 5_000);

    const objetivo = soloDigitos(cuitCliente);
    const usuario = soloDigitos(cuitUsuario);
    const panel = objetivo === usuario
      ? await seleccionarBandejaPropia(vista)
      : await seleccionarRepresentado(vista, objetivo, cuitCliente);

    await vista.locator(`${panel} table`).first().waitFor({ state: 'visible', timeout: 20_000 });
    await cerrarAvisosDfe(vista, 3_000);
    const porPagina = vista.locator(`${panel} #per-page-select`);
    if ((await porPagina.count()) === 1) {
      await porPagina.selectOption('100');
      await esperarTablaLista(vista, panel);
      await cerrarAvisosDfe(vista, 1_000);
    }

    const encontradas = new Map<string, NotificacionNueva>();
    for (let pagina = 0; pagina < 100; pagina += 1) {
      await cerrarAvisosDfe(vista);
      const filas = await leerFilas(vista, panel);
      for (const fila of filas) {
        const notificacion = notificacionDesdeFila(fila);
        encontradas.set(notificacion.idComunicacion, notificacion);
      }

      const siguiente = vista.locator(`${panel} button.pagination-button`).last();
      if ((await siguiente.count()) !== 1 || (await siguiente.isDisabled())) break;
      const primeraAnterior = filas[0]?.idComunicacion ?? '';
      await siguiente.click();
      await esperarCambioPagina(vista, panel, primeraAnterior);
      await cerrarAvisosDfe(vista, 500);
    }

    const notificaciones = [...encontradas.values()].toSorted((a, b) =>
      b.fecha.localeCompare(a.fecha),
    );
    await cargarDetallesDfe(vista, objetivo, notificaciones, opciones);
    return notificaciones;
  } catch (error) {
    const base = await volcarEstado(vista, 'domicilio-fiscal');
    console.error(`      estado volcado en ${base}.{png,html,url.txt}`);
    throw error;
  }
}

export async function cargarDetallesDfe(
  vista: Page,
  cuit: string,
  notificaciones: NotificacionNueva[],
  opciones: OpcionesDetallesDfe = {},
): Promise<ResultadoDetallesDfe> {
  const detallesExistentes = opciones.detallesExistentes ?? new Set<string>();
  const abrirNoLeidas = opciones.abrirNoLeidasAutorizadas === true;
  const origen = new URL(vista.url()).origin;
  const candidatas = notificaciones.filter(
    (notificacion) =>
      !detallesExistentes.has(notificacion.idComunicacion) &&
      (notificacion.leida || abrirNoLeidas),
  );
  const originalmenteNoLeidas = candidatas.filter((notificacion) => !notificacion.leida).length;
  if (candidatas.length > 0) {
    console.log(
      `      descargando ${candidatas.length} detalle(s) pendientes` +
        (originalmenteNoLeidas > 0
          ? `; ${originalmenteNoLeidas} comunicación(es) sin leer serán abiertas en ARCA...`
          : '...'),
    );
  }

  let completados = 0;
  let abiertasEnArca = 0;
  let pendientesDeReintento = 0;

  for (const notificacion of candidatas) {
    const originalmenteLeida = notificacion.leida;
    try {
      const id = encodeURIComponent(notificacion.idComunicacion);
      const respuesta = await vista.request.get(
        `${origen}/api/v1/communications/${id}?id=${id}&cuit=${encodeURIComponent(cuit)}`,
      );
      if (!respuesta.ok()) {
        throw new Error(`detalle HTTP ${respuesta.status()}`);
      }

      // El servidor ya abrió la comunicación al responder este GET. Reflejarlo
      // en el mismo lote evita mostrar SIN_LEER cuando ARCA ya la considera
      // leída. El próximo sync lo confirmará desde la bandeja.
      if (!originalmenteLeida) {
        notificacion.leida = true;
        abiertasEnArca += 1;
      }

      const datos = (await respuesta.json()) as RespuestaDetalleDfe;
      const comunicacion = datos.comunicacion;
      if (!comunicacion) throw new Error('respuesta sin comunicación');
      const cuerpo = await cuerpoComoTexto(vista, comunicacion.mensaje);
      const adjuntos = [];

      for (const envoltorio of comunicacion.adjuntos ?? []) {
        const metadata = envoltorio.adjunto;
        const idArchivo = numeroComoCadena(metadata?.idArchivo);
        const nombre = typeof metadata?.filename === 'string'
          ? metadata.filename.trim()
          : '';
        if (!idArchivo || !nombre) continue;

        const archivo = await vista.request.get(
          `${origen}/api/v1/communications/${id}/${encodeURIComponent(idArchivo)}`,
        );
        if (!archivo.ok()) {
          throw new Error(`adjunto ${idArchivo} HTTP ${archivo.status()}`);
        }
        const contenido = await archivo.body();
        const mimeType = (archivo.headers()['content-type'] ?? 'application/octet-stream')
          .split(';', 1)[0]
          ?.trim() || 'application/octet-stream';
        adjuntos.push({
          idArchivo,
          nombre,
          mimeType,
          tamano: contenido.byteLength || numeroSeguro(metadata?.contentSize),
          sha256: createHash('sha256').update(contenido).digest('hex'),
          contenido,
        });
      }
      notificacion.detalle = { cuerpo, adjuntos };
      completados += 1;
    } catch (error) {
      pendientesDeReintento += 1;
      const mensaje = error instanceof Error ? error.message : String(error);
      console.warn(
        `      detalle ${notificacion.idComunicacion} incompleto; se reintentará: ${mensaje}` +
          (!originalmenteLeida && notificacion.leida
            ? ' (la comunicación ya quedó abierta en ARCA)'
            : ''),
      );
    }
  }

  if (abiertasEnArca > 0) {
    console.warn(
      `      ${abiertasEnArca} comunicación(es) originalmente sin leer fueron abiertas en ARCA`,
    );
  }
  if (candidatas.length > 0) {
    console.log(
      `      detalles completos: ${completados}; pendientes de reintento: ${pendientesDeReintento}`,
    );
  }
  return { completados, abiertasEnArca, pendientesDeReintento };
}

async function cuerpoComoTexto(vista: Page, valor: unknown): Promise<string> {
  if (typeof valor !== 'string') return '';
  return vista.evaluate((mensaje) => {
    const contenedor = document.createElement('div');
    contenedor.innerHTML = mensaje;
    return (contenedor.innerText || contenedor.textContent || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }, valor);
}

function numeroComoCadena(valor: unknown): string {
  return (typeof valor === 'number' && Number.isFinite(valor)) || typeof valor === 'string'
    ? String(valor).trim()
    : '';
}

function numeroSeguro(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : 0;
}

/**
 * ARCA muestra dos avisos de forma intermitente, incluso después de cargar la
 * tabla. Solo usa sus acciones pasivas: RECORDAR MÁS TARDE y CERRAR.
 * VISUALIZAR podría abrir comunicaciones y alterar su estado, por lo que el
 * worker no lo toca bajo ninguna condición.
 */
async function cerrarAvisosDfe(
  vista: Page,
  esperarHastaMs = 0,
): Promise<boolean> {
  const limite = Date.now() + esperarHastaMs;
  let cerrado = false;
  do {
    const introductorio = vista
      .locator('.modal.show')
      .filter({ hasText: 'Domicilio Fiscal Electronico' });
    if (
      (await introductorio.count()) === 1 &&
      (await introductorio.isVisible().catch(() => false))
    ) {
      const recordar = introductorio.getByRole('button', { name: /^recordar más tarde$/i });
      if ((await recordar.count()) !== 1) {
        throw new ArcaError(
          'SELECTOR_NO_ENCONTRADO',
          'El aviso introductorio del DFE no ofreció RECORDAR MÁS TARDE',
        );
      }
      await recordar.click();
      await introductorio.waitFor({ state: 'hidden', timeout: 10_000 });
      cerrado = true;
      console.log('      aviso introductorio del DFE cerrado');
      continue;
    }

    const modal = vista.locator('.modal.show').filter({ hasText: 'Notificaciones de oficio' });
    if ((await modal.count()) === 1 && (await modal.isVisible().catch(() => false))) {
      const cerrar = modal.getByRole('button', { name: /^cerrar$/i });
      if ((await cerrar.count()) !== 1) {
        throw new ArcaError(
          'SELECTOR_NO_ENCONTRADO',
          'El aviso de Notificaciones de oficio no ofreció un único botón CERRAR',
        );
      }
      await cerrar.click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      cerrado = true;
      console.log('      aviso de notificaciones de oficio cerrado sin visualizar');
      continue;
    }
    if (Date.now() >= limite) break;
    await vista.waitForTimeout(100);
  } while (true);
  return cerrado;
}

async function seleccionarBandejaPropia(vista: Page): Promise<typeof TAB_PROPIAS> {
  await cerrarAvisosDfe(vista);
  await vista.locator('#mis-comunicaciones-tab___BV_tab_button__').click();
  await cerrarAvisosDfe(vista, 500);
  return TAB_PROPIAS;
}

async function seleccionarRepresentado(
  vista: Page,
  cuit: string,
  cuitFormateado: string,
): Promise<typeof TAB_REPRESENTADOS> {
  await cerrarAvisosDfe(vista);
  await vista.locator('#representados-comunicaciones-tab___BV_tab_button__').click();
  await cerrarAvisosDfe(vista, 500);
  const selector = vista.locator('#select-representados');
  await selector.waitFor({ state: 'attached', timeout: 15_000 });
  if ((await selector.locator(`option[value="${cuit}"]`).count()) !== 1) {
    throw new ArcaError(
      'REPRESENTADO_NO_DISPONIBLE',
      `El Domicilio Fiscal no ofrece el CUIT ${cuitFormateado}`,
    );
  }

  const control = selector.locator(
    'xpath=following-sibling::*[contains(concat(" ", normalize-space(@class), " "), " input-group ")]',
  );
  await control.click();
  const opcion = vista.locator(`button.dropdown-item[id="${cuit}"]`);
  if ((await opcion.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', `No se pudo elegir el CUIT ${cuitFormateado}`);
  }
  await opcion.click();
  await esperarTablaLista(vista, TAB_REPRESENTADOS);
  return TAB_REPRESENTADOS;
}

async function leerFilas(vista: Page, panel: string): Promise<FilaDfe[]> {
  return vista.locator(`${panel} table tbody tr`).evaluateAll((filas) =>
    filas.map((fila) => {
      const asunto = fila.querySelector<HTMLElement>('[id^="sistema["]');
      const organismo = fila.querySelector<HTMLElement>('[id^="organismo["]');
      const fecha = fila.querySelector<HTMLElement>('[id^="fechaPublicacion["]');
      const idComunicacion = /^sistema\[([^\]]+)\]$/.exec(asunto?.id ?? '')?.[1] ?? '';
      return {
        idComunicacion,
        fecha: fecha?.textContent ?? '',
        organismo: organismo?.textContent ?? '',
        asunto: asunto?.textContent ?? '',
        clases: asunto ? Array.from(asunto.classList) : [],
      };
    }),
  );
}

export function notificacionDesdeFila(fila: FilaDfe): NotificacionNueva {
  const idComunicacion = limpiar(fila.idComunicacion);
  const fecha = aFechaIsoDfe(fila.fecha);
  const organismo = limpiar(fila.organismo);
  const asunto = limpiar(fila.asunto);
  if (!idComunicacion || !fecha || !organismo || !asunto) {
    throw new ArcaError(
      'SELECTOR_NO_ENCONTRADO',
      `Fila incompleta en Domicilio Fiscal (comunicación ${idComunicacion || 'sin id'})`,
    );
  }
  return {
    idComunicacion,
    fecha,
    organismo,
    asunto,
    leida: fila.clases.includes('leido'),
  };
}

export function aFechaIsoDfe(valor: string): string | null {
  const partes = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(limpiar(valor));
  if (!partes) return null;
  return `${partes[3]}-${partes[2]?.padStart(2, '0')}-${partes[1]?.padStart(2, '0')}`;
}

async function esperarTablaLista(vista: Page, panel: string): Promise<void> {
  await vista.locator(`${panel} table[aria-busy="false"]`).first().waitFor({
    state: 'visible',
    timeout: 20_000,
  });
}

async function esperarCambioPagina(vista: Page, panel: string, anterior: string): Promise<void> {
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    await esperarTablaLista(vista, panel);
    const id = await vista
      .locator(`${panel} table tbody tr [id^="sistema["]`)
      .first()
      .getAttribute('id')
      .catch(() => null);
    if (!anterior || (id && !id.includes(`[${anterior}]`))) return;
    await vista.waitForTimeout(100);
  }
  throw new ArcaError('TIMEOUT', 'El Domicilio Fiscal no avanzó a la página siguiente');
}

function soloDigitos(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length !== 11) {
    throw new ArcaError('DESCONOCIDO', `CUIT inválido en Domicilio Fiscal: ${valor}`);
  }
  return digitos;
}

function limpiar(valor: string): string {
  return valor.replace(/\s+/g, ' ').trim();
}
