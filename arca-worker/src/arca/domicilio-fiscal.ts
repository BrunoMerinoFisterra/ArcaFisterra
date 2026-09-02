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
  /**
   * Razon social del contribuyente, tal cual la escribe ARCA.
   *
   * Solo viene en la vista "Todos tus representados"; en la bandeja propia la
   * celda no existe y queda vacia. Es un NOMBRE, no un CUIT: el cruce a CUIT lo
   * hace `resolverContribuyente` contra el dropdown de esa misma pantalla.
   */
  destinatario: string;
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
export interface ResultadoDfe {
  notificaciones: NotificacionNueva[];
  /** CUITs que el DFE ofrecio, para que el panel los liste. */
  contribuyentes: string[];
}

export async function extraerNotificacionesDfe(
  page: Page,
  cuitCliente: string,
  cuitUsuario: string,
  opciones: OpcionesDetallesDfe = {},
): Promise<ResultadoDfe> {
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

    // "Todos tus representados" (-1) trae los buzones de TODOS en una grilla,
    // con la razon social de cada uno en su propia columna. Es una sola pasada
    // en vez de una por empresa, y lo que hace que este modulo no multiplique
    // el tiempo cuando la cuenta representa a diez.
    //
    // Si esa opcion no esta, la clave no representa a nadie mas y se cae a lo
    // de siempre: la bandeja propia, o el representado puntual.
    const porNombre = await mapaRepresentados(vista);
    const panel =
      porNombre.size > 0 && (await seleccionarTodosLosRepresentados(vista))
        ? TAB_REPRESENTADOS
        : objetivo === usuario
          ? await seleccionarBandejaPropia(vista)
          : await seleccionarRepresentado(vista, objetivo, cuitCliente);

    await vista.locator(`${panel} table`).first().waitFor({ state: 'visible', timeout: 20_000 });
    await cerrarAvisosDfe(vista, 3_000);
    const porPagina = vista.locator(`${panel} #per-page-select`);
    if ((await porPagina.count()) === 1) {
      await accionDfe(vista, 'elegir 100 por pagina', () =>
        porPagina.selectOption('100', { timeout: ACCION_DFE_MS }),
      );
      await esperarTablaLista(vista, panel);
      await cerrarAvisosDfe(vista, 1_000);
    }

    const encontradas = new Map<string, NotificacionNueva>();
    for (let pagina = 0; pagina < 100; pagina += 1) {
      await cerrarAvisosDfe(vista);
      const filas = await leerFilas(vista, panel);
      for (const fila of filas) {
        const contribuyente = resolverContribuyente(fila, porNombre, objetivo);
        const notificacion = notificacionDesdeFila(fila, contribuyente);
        // La clave lleva el contribuyente: el id de comunicacion solo es unico
        // dentro de su buzon.
        encontradas.set(`${contribuyente} ${notificacion.idComunicacion}`, notificacion);
      }

      const siguiente = vista.locator(`${panel} button.pagination-button`).last();
      if ((await siguiente.count()) !== 1 || (await siguiente.isDisabled())) break;
      const primeraAnterior = filas[0]?.idComunicacion ?? '';
      await accionDfe(vista, `pagina ${pagina + 2}`, () =>
        siguiente.click({ timeout: ACCION_DFE_MS }),
      );
      await esperarCambioPagina(vista, panel, primeraAnterior);
      await cerrarAvisosDfe(vista, 500);
    }

    const notificaciones = [...encontradas.values()].toSorted((a, b) =>
      b.fecha.localeCompare(a.fecha),
    );
    await cargarDetallesDfe(vista, objetivo, notificaciones, opciones);
    return { notificaciones, contribuyentes: [...porNombre.values()] };
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
/**
 * Los avisos que sabemos despedir, identificados por una frase que aparece en
 * uno solo de ellos: el introductorio habla de `"notificadas de oficio"`, nunca
 * de `"Notificaciones de oficio"`, asi que los textos no se pisan.
 *
 * El boton es siempre la accion pasiva. En el de oficio eso es CERRAR y jamas
 * VISUALIZAR, que abriria la comunicacion en ARCA y la perfeccionaria.
 */
/**
 * Cuantas veces se tolera que un aviso tape a otro antes de cortar. Con dos
 * avisos alcanzan dos vueltas; el margen es para que un tercero no invente un
 * bucle infinito entre avisos que se pisan.
 */
const MAX_CHOQUES_AVISOS = 6;

const AVISOS_DFE = [
  {
    frase: 'Notificaciones de oficio',
    boton: /^cerrar$/i,
    sinBoton: 'El aviso de Notificaciones de oficio no ofreció un único botón CERRAR',
    nota: 'aviso de notificaciones de oficio cerrado sin visualizar',
  },
  {
    frase: 'Domicilio Fiscal Electronico',
    boton: /^recordar más tarde$/i,
    sinBoton: 'El aviso introductorio del DFE no ofreció RECORDAR MÁS TARDE',
    nota: 'aviso introductorio del DFE cerrado',
  },
] as const;

export async function cerrarAvisosDfe(
  vista: Page,
  esperarHastaMs = 0,
): Promise<boolean> {
  const limite = Date.now() + esperarHastaMs;
  let cerrado = false;
  let choques = 0;
  do {
    // Se cierra SIEMPRE el de mas arriba, que es el ultimo del DOM: cada modal
    // dibuja su backdrop encima de los anteriores. Cuando ARCA los abre a la
    // vez —pasa cuando hay comunicaciones de oficio sin leer— ir por el de
    // abajo primero deja el click interceptado por ese backdrop, y Playwright
    // espera a que el boton sea accionable hasta agotar el timeout del
    // contexto. Eso llegaba al contador como "el portal tardo demasiado".
    const abiertos = vista.locator('.modal.show');
    const total = await abiertos.count();
    const cima = total > 0 ? abiertos.nth(total - 1) : null;

    if (cima && (await cima.isVisible().catch(() => false))) {
      const texto = (await cima.textContent().catch(() => '')) ?? '';
      const aviso = AVISOS_DFE.find((candidato) => texto.includes(candidato.frase));
      if (aviso) {
        const boton = cima.getByRole('button', { name: aviso.boton });
        if ((await boton.count()) !== 1) {
          throw new ArcaError('SELECTOR_NO_ENCONTRADO', aviso.sinBoton);
        }
        try {
          await boton.click({ timeout: ACCION_DFE_MS });
        } catch {
          // ARCA abrio OTRO aviso encima mientras clickeabamos este, y su
          // footer se interpuso. No se fuerza el click: bootstrap-vue ignora la
          // interaccion con un modal que dejo de ser el de arriba, asi que
          // insistir sobre el tapado no lo cierra ni forzandolo. Se vuelve a
          // empezar la vuelta, que recuenta y elige al nuevo — el de abajo
          // queda para la siguiente, cuando ya no tenga nada encima.
          choques += 1;
          if (choques > MAX_CHOQUES_AVISOS) {
            throw new ArcaError(
              'TIMEOUT',
              `Los avisos del DFE se taparon entre si ${choques} veces seguidas`,
            );
          }
          console.log('      otro aviso se abrio encima; se cierra ese primero');
          continue;
        }
        await cima.waitFor({ state: 'hidden', timeout: 10_000 });
        cerrado = true;
        console.log(`      ${aviso.nota}`);
        continue;
      }
    }
    if (Date.now() >= limite) break;
    await vista.waitForTimeout(100);
  } while (true);
  return cerrado;
}

/** Tope por intento de cada accion del DFE. */
const ACCION_DFE_MS = 5_000;

/**
 * Corre una accion del DFE esquivando los avisos, y la nombra si no se puede.
 *
 * Cerrar los avisos una vez antes no alcanza: ARCA los abre por AJAX en
 * cualquier momento, incluso despues de que la tabla ya cargo. Si aparecen
 * entre el cierre y el click, su backdrop intercepta el puntero y Playwright
 * espera a que el elemento sea accionable hasta agotar el timeout del contexto
 * —30 s—, sin decir donde fue. Por eso cada intento va acotado, entre intentos
 * se cierra lo que haya aparecido, y al agotarse el error nombra el paso en
 * lugar del generico "el portal tardo demasiado".
 */
async function accionDfe<T>(
  vista: Page,
  paso: string,
  accion: () => Promise<T>,
  intentos = 3,
): Promise<T> {
  let ultimo: unknown = null;
  for (let intento = 1; intento <= intentos; intento += 1) {
    await cerrarAvisosDfe(vista, intento === 1 ? 0 : 1_000);
    try {
      return await accion();
    } catch (error) {
      ultimo = error;
      console.log(`      ${paso}: interceptado, reintentando (${intento}/${intentos})`);
    }
  }
  const detalle = ultimo instanceof Error ? ultimo.message.split('\n')[0] : 'sin detalle';
  throw new ArcaError(
    'TIMEOUT',
    `El Domicilio Fiscal no dejo completar "${paso}" en ${intentos} intentos: ${detalle}`,
  );
}

/**
 * Razon social normalizada -> CUIT, leido del selector de representados.
 *
 * Es la unica fuente confiable para etiquetar las filas de la vista `-1`: los
 * dos strings los escribe ARCA en la misma pantalla. Vacio cuando la clave no
 * representa a nadie, que es la señal para caer a la bandeja propia.
 */
async function mapaRepresentados(vista: Page): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const tab = vista.locator('#representados-comunicaciones-tab___BV_tab_button__');
  if ((await tab.count()) !== 1) return mapa;

  await accionDfe(vista, 'tab representados', () => tab.click({ timeout: ACCION_DFE_MS }));
  const selector = vista.locator('#select-representados');
  if ((await selector.count()) !== 1) return mapa;
  await selector.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => null);

  const opciones = await selector
    .locator('option')
    .evaluateAll((elementos) =>
      elementos.map((opcion) => ({
        value: (opcion as HTMLOptionElement).value,
        texto: opcion.textContent ?? '',
      })),
    );
  for (const opcion of opciones) {
    // Extraccion cruda y no `soloDigitos`, que LANZA si no hay 11 digitos: el
    // combo trae ademas el placeholder vacio y el "-1" de "todos", y los dos
    // son opciones legitimas que hay que saltear, no errores.
    const cuit = opcion.value.replace(/\D/g, '');
    if (cuit.length !== 11) continue;
    const nombre = normalizarRazonSocial(opcion.texto);
    if (nombre) mapa.set(nombre, cuit);
  }
  return mapa;
}

/** Posiciona la grilla en "Todos tus representados". False si no esta. */
async function seleccionarTodosLosRepresentados(vista: Page): Promise<boolean> {
  const selector = vista.locator('#select-representados');
  const todos = vista.locator('button.dropdown-item[id="-1"]');
  const control = selector.locator(
    'xpath=following-sibling::*[contains(concat(" ", normalize-space(@class), " "), " input-group ")]',
  );
  if ((await control.count()) !== 1) return false;

  await accionDfe(vista, 'desplegar representados', () =>
    control.click({ timeout: ACCION_DFE_MS }),
  );
  if ((await todos.count()) !== 1) return false;
  await accionDfe(vista, 'elegir todos los representados', () =>
    todos.click({ timeout: ACCION_DFE_MS }),
  );
  await esperarTablaLista(vista, TAB_REPRESENTADOS);
  return true;
}

async function seleccionarBandejaPropia(vista: Page): Promise<typeof TAB_PROPIAS> {
  await accionDfe(vista, 'tab mis comunicaciones', () =>
    vista.locator('#mis-comunicaciones-tab___BV_tab_button__').click({ timeout: ACCION_DFE_MS }),
  );
  await cerrarAvisosDfe(vista, 500);
  return TAB_PROPIAS;
}

async function seleccionarRepresentado(
  vista: Page,
  cuit: string,
  cuitFormateado: string,
): Promise<typeof TAB_REPRESENTADOS> {
  await accionDfe(vista, 'tab representados', () =>
    vista
      .locator('#representados-comunicaciones-tab___BV_tab_button__')
      .click({ timeout: ACCION_DFE_MS }),
  );
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
  await accionDfe(vista, 'desplegar representados', () =>
    control.click({ timeout: ACCION_DFE_MS }),
  );
  const opcion = vista.locator(`button.dropdown-item[id="${cuit}"]`);
  if ((await opcion.count()) !== 1) {
    throw new ArcaError('SELECTOR_NO_ENCONTRADO', `No se pudo elegir el CUIT ${cuitFormateado}`);
  }
  await accionDfe(vista, `elegir representado ${cuitFormateado}`, () =>
    opcion.click({ timeout: ACCION_DFE_MS }),
  );
  await esperarTablaLista(vista, TAB_REPRESENTADOS);
  return TAB_REPRESENTADOS;
}

async function leerFilas(vista: Page, panel: string): Promise<FilaDfe[]> {
  return vista.locator(`${panel} table tbody tr`).evaluateAll((filas) =>
    filas.map((fila) => {
      const asunto = fila.querySelector<HTMLElement>('[id^="sistema["]');
      const organismo = fila.querySelector<HTMLElement>('[id^="organismo["]');
      const fecha = fila.querySelector<HTMLElement>('[id^="fechaPublicacion["]');
      // Mismo convenio de id estable que el resto de la fila, asi que no hay
      // que ubicar la columna por posicion.
      const destinatario = fila.querySelector<HTMLElement>('[id^="destinatario["]');
      const idComunicacion = /^sistema\[([^\]]+)\]$/.exec(asunto?.id ?? '')?.[1] ?? '';
      return {
        idComunicacion,
        fecha: fecha?.textContent ?? '',
        organismo: organismo?.textContent ?? '',
        asunto: asunto?.textContent ?? '',
        clases: asunto ? Array.from(asunto.classList) : [],
        destinatario: destinatario?.textContent ?? '',
      };
    }),
  );
}

/**
 * Nombres comparables: sin acentos, sin puntuacion y con los espacios
 * colapsados. ARCA escribe "MUCA S.A.S." en el dropdown y "MUCA SAS" en la
 * grilla mas seguido de lo que uno quisiera.
 */
export function normalizarRazonSocial(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Resuelve el CUIT del contribuyente de una fila.
 *
 * La grilla de representados trae la razon social, no el CUIT. El mapa sale del
 * dropdown de ESA misma pantalla, asi que ambos strings los escribe ARCA en la
 * misma sesion y deberian coincidir.
 *
 * Si no coinciden se CORTA. El resto del worker elige al representado por CUIT
 * exacto justamente para no equivocarse de contribuyente, y adivinar acá
 * guardaria la comunicacion de uno bajo la empresa de otro — el mismo daño, con
 * la diferencia de que este seria silencioso.
 */
export function resolverContribuyente(
  fila: FilaDfe,
  porNombre: ReadonlyMap<string, string>,
  cuitPropio: string,
): string {
  const nombre = normalizarRazonSocial(fila.destinatario);
  // Bandeja propia: la columna no existe y todo es del titular.
  if (!nombre) return cuitPropio;

  const cuit = porNombre.get(nombre);
  if (!cuit) {
    throw new ArcaError(
      'SELECTOR_NO_ENCONTRADO',
      `El Domicilio Fiscal informa el representado "${limpiar(fila.destinatario)}", que no está entre los del selector`,
    );
  }
  return cuit;
}

export function notificacionDesdeFila(fila: FilaDfe, contribuyenteCuit: string): NotificacionNueva {
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
    contribuyenteCuit,
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
