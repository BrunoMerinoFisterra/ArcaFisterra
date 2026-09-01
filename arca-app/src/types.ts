/**
 * Modelo de datos del tablero.
 *
 * Los estados de credencial son los mismos que maneja `arca-worker`
 * (ver arca-worker/src/arca/errors.ts). Mantenerlos alineados: cuando la API
 * real reemplace a los mocks, el front no deberia necesitar cambios.
 */

export type EstadoCredencial = 'OK' | 'INVALIDA' | 'BLOQUEADA' | 'VENCIDA' | 'SIN_CARGAR';

/** Espeja las reacciones del worker ante una falla. */
export type EstadoSync = 'OK' | 'ERROR' | 'NECESITA_HUMANO' | 'NUNCA' | 'SINCRONIZANDO';
export type EstadoJob = 'PENDING' | 'RUNNING' | 'DONE' | 'ERROR' | 'NEEDS_HUMAN';

export type Rol = 'admin' | 'user';

export interface Usuario {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  /** null = sin límite (administradores). */
  limiteClientes: number | null;
}

export interface UsuarioGestion extends Usuario {
  clientesAsignados: number;
  clientes: Array<Pick<Cliente, 'id' | 'cuit' | 'razonSocial'>>;
}

export interface Cliente {
  id: string;
  cuit: string;
  razonSocial: string;
  estadoCredencial: EstadoCredencial;
  estadoSync: EstadoSync;
  /** ISO. null si nunca sincronizo. */
  ultimoSync: string | null;
  /** Motivo legible cuando estadoSync no es OK. */
  detalleSync?: string;
  /**
   * Cuando se guardo la clave, en ISO. null si no hay ninguna.
   * La clave EN SI nunca viaja al front: la API solo permite escribirla.
   */
  credencialCargadaEn: string | null;
}

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
}

export type EstadoSolicitud = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA';

/** Pedido de acceso a una empresa que otra cuenta ya tiene cargada. */
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

export type EstadoNotificacion = 'LEIDA' | 'VISTA' | 'SIN_LEER';

export interface NotificacionAdjunto {
  id: string;
  nombre: string;
  mimeType: string;
  tamano: number;
}

export interface Notificacion {
  id: string;
  clienteId: string;
  idComunicacion: string;
  fecha: string;
  organismo: string;
  asunto: string;
  /** Estado observado en el portal de ARCA durante la ultima sincronizacion. */
  leida: boolean;
  /** Momento en que alguien abrio la comunicacion dentro de esta app. */
  vistaAppEn: string | null;
  /** Lectura local reversible; no cambia el estado legal observado en ARCA. */
  leidoAppEn: string | null;
  /** null significa que el worker todavia no pudo traer el detalle sin alterar ARCA. */
  cuerpo: string | null;
  adjuntos: NotificacionAdjunto[];
  estado: EstadoNotificacion;
}

export interface SaldoTributario {
  clienteId: string;
  contribuyenteCuit: string;
  establecimiento: string;
  impuesto: string;
  concepto: string;
  subconcepto: string;
  periodo: string;
  anticipoCuota: string;
  fechaVencimiento: string | null;
  /** Los importes de la pestaña Deudas se guardan negativos. */
  saldo: number;
  interesResarcitorio: number;
  interesPunitorio: number;
}

export interface PlanPago {
  id: string;
  clienteId: string;
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
  /** Cuotas vencidas sin pagar. Es el dato que dispara la alerta. */
  cuotasImpagas: number;
  totalPagado: number;
  /** Lectura local reversible del detalle del plan. */
  leidoAppEn: string | null;
  cuotas: CuotaPlan[];
}

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
   * CUIT del contribuyente que emitió o recibió el comprobante. No confundir
   * con `cuitContraparte`, que es quién está del otro lado de la factura.
   */
  contribuyenteCuit: string;
  tipo: TipoComprobante;
  fecha: string;
  codigoComprobante: number;
  tipoComprobante: string;
  puntoVenta: number;
  numero: number;
  contraparte: string;
  cuitContraparte: string;
  neto: number;
  iva: number;
  total: number;
}

/** Todo lo que el tablero necesita de un cliente, en una sola llamada. */
export interface DetalleCliente {
  cliente: Cliente;
  notificaciones: Notificacion[];
  saldos: SaldoTributario[];
  planes: PlanPago[];
  vencimientos: Vencimiento[];
  ddjjPendientes: DeclaracionJuradaPendiente[];
  comprobantes: Comprobante[];
  /**
   * Razón social por CUIT (11 dígitos, sin guiones) de los contribuyentes que
   * aparecen agrupados. ARCA no la informa, así que se carga a mano: un CUIT
   * ausente de acá es uno todavía sin identificar.
   */
  contribuyentes: Record<string, string>;
}

/** Contadores que se muestran en la card del cliente. */
export interface ResumenCliente {
  cliente: Cliente;
  notificacionesSinLeer: number;
  cuotasImpagas: number;
  /** Vencimientos dentro de los proximos 15 dias. */
  vencimientosProximos: number;
  /** Suma de saldos: negativo es deuda. */
  saldoTotal: number;
  /**
   * Si el cliente tiene algun saldo registrado.
   * Sin esto no se distingue "saldo cero" de "todavia no sincronizamos saldos",
   * y mostrar "$ 0 a favor" cuando no hay datos es directamente enganoso.
   */
  tieneSaldos: boolean;
}

export interface AdministracionClientes {
  clientes: Cliente[];
  cantidadClientes: number;
  limiteClientes: number | null;
  excedido: boolean;
}
