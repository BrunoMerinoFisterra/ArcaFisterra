/**
 * TODOS los selectores del portal ARCA viven en este archivo.
 *
 * Cuando ARCA cambie el HTML — y lo va a hacer, sin aviso — se arregla aca y
 * en ningun otro lado. Esa es toda la razon de que este archivo exista.
 *
 * Cada campo es una LISTA de candidatos ordenada de mas especifica a mas
 * generica. `primerSelectorVisible` prueba en orden y devuelve cual matcheo,
 * asi el spike de Fase 0 reporta que selector funciono de verdad contra el
 * portal en vivo. Los ids `F1:*` son JSF/PrimeFaces y son los historicos de
 * AFIP, pero hay que CONFIRMARLOS corriendo el spike — no darlos por buenos.
 */

export const URLS = {
  login: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
  portal: 'https://portalcf.cloud.afip.gob.ar/portal/app/',
} as const;

/** Considera exitoso el login si la URL final matchea alguno de estos. */
export const URL_POST_LOGIN = [/portalcf\.cloud\.afip\.gob\.ar/i, /portal\/app/i];

export const LOGIN = {
  inputCuit: ['#F1\\:username', 'input[name="F1:username"]', 'input#username'],
  btnSiguiente: ['#F1\\:btnSiguiente', 'input[name="F1:btnSiguiente"]', 'button:has-text("Siguiente")'],
  inputClave: ['#F1\\:password', 'input[name="F1:password"]', 'input[type="password"]'],
  btnIngresar: ['#F1\\:btnIngresar', 'input[name="F1:btnIngresar"]', 'button:has-text("Ingresar")'],
  /** Cartel de error que muestra la propia pagina de login. */
  mensajeError: ['.ui-messages-error', '#F1\\:msg', '.alert-danger', '[role="alert"]'],
} as const;

/**
 * CAPTCHA. Si alguno matchea, el worker NO intenta resolverlo: corta con
 * CAPTCHA_PRESENTE y escala a un humano. Resolverlo automaticamente violaria
 * los terminos del portal y es la via rapida a que bloqueen las cuentas.
 */
export const CAPTCHA = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '#captcha',
] as const;

export const PORTAL = {
  /** Buscador de servicios del portal. */
  inputBuscar: ['#buscadorInput', 'input[placeholder*="Buscar"]', 'input[type="search"]'],
  /** El link del servicio se resuelve por texto, ver `linkServicio`. */
} as const;

/** Link a un servicio del portal por nombre visible. */
export const linkServicio = (nombre: string) => `a:has-text("${nombre}")`;

/**
 * Modal "Agregar Servicio".
 *
 * Aparece cuando el CUIT NO tiene adherido el servicio: el portal ofrece
 * agregarlo en vez de abrirlo. Es la forma real en que se manifiesta
 * SERVICIO_NO_ADHERIDO — un dialogo, no un mensaje de error, por eso no lo
 * agarraba la deteccion por frases.
 *
 * El worker NUNCA debe clickear Continuar por su cuenta: adherir un servicio
 * modifica la configuracion de la cuenta fiscal del contribuyente. Eso lo
 * decide una persona, no un job de sincronizacion.
 */
export const MODAL_AGREGAR_SERVICIO = {
  contenedor: [
    'div[role="dialog"].modal .modal-title:has-text("Agregar Servicio")',
    '.modal-title:has-text("Agregar Servicio")',
  ],
  btnContinuar: ['.modal-footer button:has-text("Continuar")'],
  btnCancelar: ['.modal-footer button:has-text("Cancelar")'],
} as const;

/**
 * Pantalla intermedia de Mis Comprobantes cuando la clave fiscal puede actuar
 * por mas de un contribuyente. Siempre se elige por CUIT: la razon social que
 * muestra ARCA puede no coincidir exactamente con la cargada en el panel.
 */
export const SELECCION_CONTRIBUYENTE = {
  contenedor: [
    'form[name="seleccionaEmpresaForm"] #idcontribuyente',
    'h1:has-text("Elegí una persona para ingresar")',
    'h1:has-text("Elegi una persona para ingresar")',
  ],
  /**
   * Todas las opciones de la pantalla. Sirve para ENUMERAR los contribuyentes;
   * para elegir uno se usa `linkContribuyentePorCuit`, que matchea por CUIT
   * exacto. Nunca seleccionar por posicion dentro de esta lista.
   */
  opciones: 'form[name="seleccionaEmpresaForm"] .panels-row a.panel',
} as const;

export const linkContribuyentePorCuit = (cuitFormateado: string) =>
  `form[name="seleccionaEmpresaForm"] .panels-row a.panel:has(small:has-text("${cuitFormateado}"))`;

export const MIS_COMPROBANTES = {
  servicio: 'Mis Comprobantes',
  btnEmitidos: ['a:has-text("Emitidos")', 'button:has-text("Emitidos")', '#btnEmitidos'],
  btnRecibidos: ['a:has-text("Recibidos")', 'button:has-text("Recibidos")', '#btnRecibidos'],
  /**
   * UN SOLO input con un bootstrap-daterangepicker: lleva todo el rango en un
   * string "DD/MM/YYYY - DD/MM/YYYY".
   *
   * No busques un par desde/hasta aca. `#comprobanteDesde` / `#comprobanteHasta`
   * SI existen, pero son el rango de NUMEROS de comprobante — un selector
   * generico tipo input[id*="hasta"] los agarra y manda la fecha al campo
   * equivocado sin que nada falle.
   */
  inputFechaRango: ['#fechaEmision'],

  /**
   * Tope duro del servicio: el picker se configura con
   * RangoMaximoFechas.ANIO y la pagina avisa "Rango maximo: 365 dias".
   * Para traer historial mas largo hay que partir la consulta en ventanas.
   */
  rangoMaximoDias: 365,
  btnBuscar: ['#buscarComprobantes', 'button:has-text("Buscar")', 'input[value="Buscar"]'],

  /**
   * La tabla se llena por AJAX. Mientras carga, #progresoResultados muestra
   * "Cargando..." y #contenidoResultados esta en display:none.
   *
   * Hay que esperar a que #contenidoResultados sea visible. `networkidle` NO
   * alcanza: volvia antes de tiempo y se leia la tabla todavia vacia como si
   * el periodo no tuviera comprobantes.
   */
  contenidoResultados: ['#contenidoResultados'],

  /**
   * El boton que dispara la descarga. Es la pieza clave del modulo.
   * Ojo: no es un link — corre `window.location.href` hacia
   * descargarComprobantes.do, asi que hay que capturarlo con el evento
   * 'download' y no siguiendo un href.
   */
  btnCsv: [
    'button[title="Exportar como CSV"]',
    '.dt-buttons button:has(span:text-is("CSV"))',
    'a.btnExportar[data-tipo-expo="csv"]',
  ],

  /**
   * Cartel real de vacio — no es un error.
   * Se matchea por TEXTO, no por la clase `.dataTables_empty` sola: esa clase
   * existe en el DOM desde antes de que lleguen los datos y daba falso vacio.
   * Texto cortado antes del acento para no depender del encoding.
   */
  sinResultados: ['td.dataTables_empty:has-text("No existe informaci")'],
} as const;

export const MIS_FACILIDADES = {
  servicio: 'Mis Facilidades',
  selectorCuit: '#ContentPlaceHolder1_ddlCUIT',
  aceptarCuit: '#ContentPlaceHolder1_btnAceptar',
  cuitActivo: '#ContentPlaceHolder1_cuit',
  tablaPlanes: 'table.searchTable',
  filasPlanes: 'table.searchTable tbody tr',
  botonDetalle: 'input[id^="ContentPlaceHolder1_rpt_detallePlan_"]',
  detalleConcepto: '#ContentPlaceHolder1_CabeceraPlanesEnviados_cab_tituloPlan',
  detalleNumero: '#ContentPlaceHolder1_CabeceraPlanesEnviados_cab_nroPlan',
  detalleFechaConsolidacion:
    '#ContentPlaceHolder1_CabeceraPlanesEnviados_cab_fechaConsolidacion',
  detalleTipoPlan: '#ContentPlaceHolder1_CabeceraPlanesEnviados_cab_tipoPlan',
  verPagos: '#ContentPlaceHolder1_btnVerPagos',
  filasCuotas:
    '#tableDetallePagos tbody tr[id^="ContentPlaceHolder1_rptDetallePagos_trRpt_"]',
  totalPagado: '#ContentPlaceHolder1_rptDetallePagos_trTableFooter td',
  volverDesdePagos: 'a[href$="nuevos_planes.aspx"]:has-text("Volver")',
  volverDesdeDetalle: '#ContentPlaceHolder1_btnVolver',
} as const;

export const CUENTAS_TRIBUTARIAS = {
  servicio: 'Sistema de Cuentas Tributarias',
  urlServicio: /ctacte\.cloud\.afip\.gob\.ar\/contribuyente\//i,
  selectorCuit: '#cuitForm select[name="$PropertySelection"]',
  /**
   * CUIT del contribuyente que el servicio ya tiene activo.
   *
   * Cuando la clave representa a UNO solo, ARCA no dibuja `selectorCuit`: entra
   * directo posicionado y lo unico que queda en pantalla es este cartel. Sirve
   * para confirmar por CUIT exacto que estamos parados donde corresponde, que
   * es la unica forma admitida de decidirlo.
   */
  cuitActivo: 'span.cuit',
  iframe: 'iframe[src*="homeContribuyente"]',
  tabVencimientos: 'a[role="tab"]:has-text("Vencimientos")',
  tabVencimientosActivo: 'a[role="tab"][aria-selected="true"]:has-text("Vencimientos")',
  tablaVencimientos: 'table[aria-colcount="7"]',
  tabDeudas: 'a[role="tab"]:has-text("Deudas")',
  tabDeudasActivo: 'a[role="tab"][aria-selected="true"]:has-text("Deudas")',
  panelActivo: '[role="tabpanel"][aria-hidden="false"]',
  tablaDeudas: 'table[aria-colcount="12"]',
  tabDdjj: 'a[role="tab"]:has-text("DDJJ pendientes")',
  tabDdjjActivo: 'a[role="tab"][aria-selected="true"]:has-text("DDJJ pendientes")',
  tablaDdjj: 'table[aria-colcount]',
  selectorCantidad: 'select:has(option[value="-1"])',
} as const;
