/**
 * Tipos del dominio. Espejan los del front (`arca-app/src/types.ts`) y los
 * estados del worker (`arca-worker/src/arca/errors.ts`) a proposito: los tres
 * hablan del mismo negocio y divergir en los nombres seria fuente de bugs.
 */

export type EstadoCredencial = 'OK' | 'INVALIDA' | 'BLOQUEADA' | 'VENCIDA' | 'SIN_CARGAR';
export type EstadoSync = 'OK' | 'ERROR' | 'NECESITA_HUMANO' | 'NUNCA' | 'SINCRONIZANDO';
export type Rol = 'admin' | 'user';

export interface Usuario {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  /** null significa sin límite; se reserva para administradores. */
  limiteClientes: number | null;
}

/** Usuario tal como se guarda. El hash NUNCA sale de la capa de repositorio. */
export interface UsuarioConHash extends Usuario {
  passwordHash: string;
}

/** Vista administrativa de una cuenta, sin exponer nunca el hash. */
export interface UsuarioGestion extends Usuario {
  clientesAsignados: number;
}

/**
 * Cliente tal como se expone por HTTP.
 *
 * Fijate que no hay ningun campo con la clave fiscal, ni cifrada. El tipo es
 * la primera linea de defensa: si no esta en la interfaz, no se puede filtrar
 * por descuido en un `res.json(cliente)`.
 */
export interface Cliente {
  id: string;
  cuit: string;
  razonSocial: string;
  estadoCredencial: EstadoCredencial;
  estadoSync: EstadoSync;
  ultimoSync: string | null;
  detalleSync?: string;
  credencialCargadaEn: string | null;
}

export type EstadoNotificacion = 'LEIDA' | 'VISTA' | 'SIN_LEER';

export interface NotificacionAdjunto {
  id: string;
  nombre: string;
  mimeType: string;
  tamano: number;
}

/**
 * Una empresa por la que una cuenta puede actuar en ARCA.
 *
 * Es la fila del panel principal y la unidad en la que el usuario entra. NO es
 * un cliente de la app: no se da de alta, no consume cupo y no se asigna a
 * usuarios por separado — todo eso sigue colgando de la cuenta (`Cliente`).
 *
 * Si dos cuentas representan a la misma empresa aparecen dos filas, cada una
 * con su representante. Es a propósito: los datos que se ven son los que bajó
 * ESA cuenta, y fundirlas obligaría a elegir de cuál mostrar.
 */
export interface EmpresaRepresentada {
  /** La cuenta que la representa. */
  clienteId: string;
  cuit: string;
  /** Razón social resuelta del padrón; el CUIT si todavía no se conoce. */
  nombre: string;
  /** Datos de la cuenta, para mostrar el representante al lado. */
  representante: {
    cuit: string;
    razonSocial: string;
  };
  /** True cuando la empresa ES la titular de la cuenta y no una representada. */
  esTitular: boolean;
  /** Último servicio de ARCA donde se la vio ofrecida. */
  vistoEn: string;
}

export interface Notificacion {
  id: string;
  clienteId: string;
  /** De qué empresa es el buzón. Una clave fiscal representa a varias. */
  contribuyenteCuit: string;
  idComunicacion: string;
  fecha: string;
  organismo: string;
  asunto: string;
  /** Estado observado en ARCA. El worker nunca lo promueve por su cuenta. */
  leida: boolean;
  /** Primera vez que alguien abrió el detalle dentro de esta app local. */
  vistaAppEn: string | null;
  /** Estado de lectura local reversible. No modifica la lectura legal en ARCA. */
  leidoAppEn: string | null;
  /** null significa que el worker todavía no pudo consultar el detalle sin efectos laterales. */
  cuerpo: string | null;
  adjuntos: NotificacionAdjunto[];
  /** Derivado de `leida` y `vistaAppEn`, con prioridad para el estado de ARCA. */
  estado: EstadoNotificacion;
}

export interface SaldoTributario {
  clienteId: string;
  /** CUIT activo en el selector de Cuentas Tributarias que originó la fila. */
  contribuyenteCuit: string;
  establecimiento: string;
  impuesto: string;
  concepto: string;
  subconcepto: string;
  periodo: string;
  anticipoCuota: string;
  fechaVencimiento: string | null;
  /** Capital adeudado. Se guarda negativo para conservar la convención del tablero. */
  saldo: number;
  interesResarcitorio: number;
  interesPunitorio: number;
}

export interface PlanPago {
  id: string;
  clienteId: string;
  /** De qué empresa es el plan. Ver el comentario de `Notificacion`. */
  contribuyenteCuit: string;
  numero: string;
  concepto: string;
  fechaPresentacion: string | null;
  fechaConsolidacion: string | null;
  tipoPlan: string;
  montoConsolidado: number;
  estado: string;
  situacion: string;
  cuotasTotales: number;
  cuotasPagas: number;
  montoCuota: number;
  proximoVencimiento: string | null;
  cuotasImpagas: number;
  totalPagado: number;
  /** Estado de lectura local reversible del detalle del plan. */
  leidoAppEn: string | null;
  cuotas: CuotaPlan[];
}

/**
 * Una fila real de "Ver Pagos". ARCA puede publicar dos vencimientos para la
 * misma cuota (original y rehabilitado); `variante` conserva ambas filas sin
 * inventar cuál corresponde usar.
 */
export interface CuotaPlan {
  id: string;
  planId: string;
  numero: number;
  variante: number;
  capital: number;
  interesFinanciero: number;
  interesResarcitorio: number;
  total: number;
  fechaVencimiento: string | null;
  pago: string;
  estado: string;
}

export interface Vencimiento {
  id: string;
  clienteId: string;
  contribuyenteCuit: string;
  impuesto: string;
  concepto: string;
  subconcepto: string;
  periodo: string;
  anticipoCuota: string;
  fecha: string;
  detalle: string;
}

export interface DeclaracionJuradaPendiente {
  id: string;
  clienteId: string;
  contribuyenteCuit: string;
  establecimiento: string;
  impuesto: string;
  concepto: string;
  subconcepto: string;
  periodo: string;
  fecha: string | null;
}

export type TipoComprobante = 'EMITIDO' | 'RECIBIDO';

export interface Comprobante {
  id: string;
  clienteId: string;
  /**
   * CUIT del contribuyente que emitió o recibió el comprobante.
   *
   * Una misma clave fiscal puede actuar por varios, igual que en Cuentas
   * Tributarias. No confundir con `cuitContraparte`, que es quién está del otro
   * lado de la factura.
   */
  contribuyenteCuit: string;
  tipo: TipoComprobante;
  fecha: string;
  /**
   * Codigo numerico de ARCA (1 = Factura A, 6 = Factura B, 11 = Factura C...).
   *
   * Es lo que viene en el CSV, y es la parte de la clave natural que hace
   * idempotente el sync. El nombre de abajo es derivado: si mañana corregimos
   * la tabla de nombres, el codigo sigue identificando al mismo comprobante.
   */
  codigoComprobante: number;
  /** Nombre legible del codigo. Es lo unico que se muestra en pantalla. */
  tipoComprobante: string;
  puntoVenta: number;
  numero: number;
  contraparte: string;
  cuitContraparte: string;
  /**
   * Importes SIGNADOS: las notas de credito van en negativo.
   *
   * ARCA las exporta en positivo, asi que el parser les invierte el signo antes
   * de guardarlas. De esa forma cualquier SUM sobre esta tabla da el neto real
   * — sumarlas como vienen infla los totales del contribuyente.
   *
   * Ojo: `total` no es `neto + iva`. Un comprobante puede tener importes no
   * gravados, exentos y otros tributos que no estan en ninguno de los dos.
   */
  neto: number;
  iva: number;
  total: number;
}

export type EstadoJob = 'PENDING' | 'RUNNING' | 'DONE' | 'ERROR' | 'NEEDS_HUMAN';

export interface SyncJob {
  id: string;
  clienteId: string;
  modulo: string;
  estado: EstadoJob;
  intentos: number;
  creadoEn: string;
  iniciadoEn?: string;
  finalizadoEn?: string;
  error?: string;
  progresoActual: number;
  progresoTotal: number;
  pasoActual?: string;
  /** Presente sólo en los jobs que verifican una solicitud de acceso. */
  solicitudId?: string;
  /**
   * Empresa a la que apunta el job. Ausente = la cuenta entera, con todos sus
   * representados en una sola pasada por servicio.
   */
  contribuyenteCuit?: string;
}

export type EstadoSolicitud = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';

/**
 * Pedido de acceso a una empresa que otra cuenta ya tiene cargada.
 *
 * Nunca lleva la credencial: la clave fiscal que se adjunta al pedirlo se
 * guarda cifrada, la usa el worker una sola vez y se borra al resolverlo.
 */
export interface SolicitudAcceso {
  id: string;
  clienteId: string;
  cuit: string;
  razonSocial: string;
  estado: EstadoSolicitud;
  detalle?: string;
  creadoEn: string;
  resueltoEn?: string;
}

export interface DetalleCliente {
  cliente: Cliente;
  notificaciones: Notificacion[];
  saldos: SaldoTributario[];
  planes: PlanPago[];
  vencimientos: Vencimiento[];
  ddjjPendientes: DeclaracionJuradaPendiente[];
  comprobantes: Comprobante[];
}

export interface ResumenCliente {
  cliente: Cliente;
  notificacionesSinLeer: number;
  cuotasImpagas: number;
  vencimientosProximos: number;
  saldoTotal: number;
  tieneSaldos: boolean;
}
