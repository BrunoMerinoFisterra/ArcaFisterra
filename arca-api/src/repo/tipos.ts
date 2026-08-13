import type { CredencialCifrada } from '../crypto/envelope.js';
import type {
  Cliente,
  Comprobante,
  CuotaPlan,
  DeclaracionJuradaPendiente,
  EstadoCredencial,
  Notificacion,
  NotificacionAdjunto,
  PlanPago,
  SaldoTributario,
  SyncJob,
  UsuarioConHash,
  UsuarioGestion,
  Vencimiento,
} from '../dominio/tipos.js';

/** Un comprobante recién parseado del CSV: todavía sin id propio. */
export type ComprobanteNuevo = Omit<Comprobante, 'id' | 'clienteId'>;
export interface NotificacionAdjuntoNuevo {
  idArchivo: string;
  nombre: string;
  mimeType: string;
  tamano: number;
  sha256: string;
  contenido: Uint8Array;
}

export interface NotificacionNueva {
  idComunicacion: string;
  fecha: string;
  organismo: string;
  asunto: string;
  leida: boolean;
  /** undefined = no inspeccionado; presente = reemplaza cuerpo y adjuntos. */
  detalle?: {
    cuerpo: string;
    adjuntos: NotificacionAdjuntoNuevo[];
  };
}

export interface NotificacionAdjuntoContenido extends NotificacionAdjunto {
  contenido: Uint8Array;
}
export type SaldoTributarioNuevo = Omit<SaldoTributario, 'clienteId'>;
export type VencimientoNuevo = Omit<Vencimiento, 'id' | 'clienteId'>;
export type DeclaracionJuradaPendienteNueva = Omit<
  DeclaracionJuradaPendiente,
  'id' | 'clienteId'
>;
export type CuotaPlanNueva = Omit<CuotaPlan, 'id' | 'planId'>;
export type PlanPagoNuevo = Omit<PlanPago, 'id' | 'clienteId' | 'leidoAppEn' | 'cuotas'> & {
  cuotas: CuotaPlanNueva[];
};

export interface LecturaLocal {
  leidoAppEn: string | null;
}

/**
 * Contrato de persistencia.
 *
 * Hoy lo implementa `memoria.ts`; cuando exista la Azure SQL se agrega
 * `sql.ts` con las tablas arca_* y no cambia nada mas.
 *
 * Regla que atraviesa toda la interfaz: **los metodos de lectura de clientes
 * reciben usuarioId**. No hay un `obtenerCliente(id)` suelto que alguien pueda
 * llamar sin filtrar. El aislamiento multi-tenant es parte del contrato, no
 * algo que cada endpoint tiene que acordarse de aplicar.
 */
export interface Repositorio {
  /* --- Usuarios --- */
  buscarUsuarioPorEmail(email: string): Promise<UsuarioConHash | null>;
  buscarUsuarioPorId(id: string): Promise<UsuarioConHash | null>;
  listarUsuarios(): Promise<UsuarioGestion[]>;
  existeEmailUsuario(email: string): Promise<boolean>;
  crearUsuario(datos: {
    email: string;
    nombre: string;
    passwordHash: string;
    limiteClientes: number;
  }): Promise<UsuarioGestion>;
  actualizarUsuario(
    usuarioId: string,
    cambios: {
      nombre?: string;
      passwordHash?: string;
      limiteClientes?: number;
      activo?: boolean;
    },
  ): Promise<UsuarioGestion | null>;
  cantidadClientesDe(usuarioId: string): Promise<number>;

  /* --- Clientes (siempre filtrados por usuario) --- */
  listarClientesDe(usuarioId: string): Promise<Cliente[]>;
  obtenerClienteDe(usuarioId: string, clienteId: string): Promise<Cliente | null>;
  crearCliente(datos: { cuit: string; razonSocial: string }, usuarioId: string): Promise<Cliente>;
  existeCuit(cuit: string): Promise<boolean>;
  /**
   * Quita el cliente de la cuenta. Si estaba compartido, conserva los datos
   * para las otras cuentas; si era la última asignación, lo elimina completo.
   */
  eliminarClienteDe(usuarioId: string, clienteId: string): Promise<void>;

  /**
   * Guarda la credencial ya cifrada. El repositorio nunca ve la clave en claro:
   * el cifrado ocurre antes de llegar aca.
   */
  guardarCredencial(clienteId: string, cifrada: CredencialCifrada): Promise<Cliente>;

  /**
   * Solo para el worker. No debe existir ningun endpoint HTTP que llegue aca.
   */
  leerCredencialCifrada(clienteId: string): Promise<CredencialCifrada | null>;

  /* --- Datos del tablero --- */
  notificacionesDe(clienteId: string): Promise<Notificacion[]>;
  marcarNotificacionVista(clienteId: string, notificacionId: string): Promise<Notificacion | null>;
  actualizarLecturaNotificacion(
    clienteId: string,
    notificacionId: string,
    leido: boolean,
  ): Promise<LecturaLocal | null>;
  adjuntoNotificacionDe(
    clienteId: string,
    notificacionId: string,
    adjuntoId: string,
  ): Promise<NotificacionAdjuntoContenido | null>;
  saldosDe(clienteId: string): Promise<SaldoTributario[]>;
  planesDe(clienteId: string): Promise<PlanPago[]>;
  actualizarLecturaPlan(
    clienteId: string,
    planId: string,
    leido: boolean,
  ): Promise<LecturaLocal | null>;
  vencimientosDe(clienteId: string): Promise<Vencimiento[]>;
  ddjjPendientesDe(clienteId: string): Promise<DeclaracionJuradaPendiente[]>;
  comprobantesDe(clienteId: string): Promise<Comprobante[]>;

  /**
   * Inserta o actualiza comunicaciones por el id estable que informa ARCA.
   * No elimina las ausentes: el DFE puede devolver una ventana parcial.
   */
  guardarNotificaciones(
    clienteId: string,
    notificaciones: NotificacionNueva[],
  ): Promise<{ insertadas: number; actualizadas: number }>;

  /** Reemplaza la foto completa de la pestaña Deudas de Cuentas Tributarias. */
  reemplazarSaldos(clienteId: string, saldos: SaldoTributarioNuevo[]): Promise<number>;

  /** Reemplaza la foto completa de la pestaña Vencimientos de Cuentas Tributarias. */
  reemplazarVencimientos(
    clienteId: string,
    vencimientos: VencimientoNuevo[],
  ): Promise<number>;

  /** Reemplaza todas las DDJJ pendientes de cada CUIT accesible por la credencial. */
  reemplazarDdjjPendientes(
    clienteId: string,
    declaraciones: DeclaracionJuradaPendienteNueva[],
  ): Promise<number>;

  /**
   * Guarda comprobantes bajados de ARCA. Lo usa el worker, no el front.
   *
   * DEBE ser idempotente: correr el mismo sync dos veces no puede duplicar
   * filas. La clave natural es (cliente, tipo, tipo_comprobante, punto_venta,
   * numero) y la unicidad se garantiza con un constraint en la base, no con un
   * chequeo en codigo — dos jobs concurrentes se pisarian igual.
   */
  guardarComprobantes(
    clienteId: string,
    comprobantes: ComprobanteNuevo[],
  ): Promise<{ insertados: number; repetidos: number }>;

  /** Reemplaza en una transacción la foto completa de Mis Facilidades. */
  reemplazarPlanes(
    clienteId: string,
    planes: PlanPagoNuevo[],
  ): Promise<{ planes: number; cuotas: number }>;

  /* --- Cola de sincronizacion --- */
  encolarSync(clienteId: string, modulo: string): Promise<SyncJob>;
  jobsDe(clienteId: string): Promise<SyncJob[]>;
  actualizarProgresoJob(
    jobId: string,
    progreso: { actual: number; total: number; paso: string },
    workerId?: string,
  ): Promise<void>;

  /* --- Cola: SOLO el worker --------------------------------------------
   *
   * Estos tres metodos NO reciben usuarioId, a diferencia de todo el resto de
   * la interfaz. Es deliberado: el worker no actua en nombre de un usuario,
   * corre la cola entera. Por eso mismo ninguna ruta HTTP puede llamarlos —
   * la misma regla que ya vale para `leerCredencialCifrada`.
   * ------------------------------------------------------------------- */

  /**
   * Toma el proximo job pendiente y lo pasa a RUNNING, o null si no hay.
   *
   * El cambio de estado tiene que ser atomico respecto de otros workers: si
   * dos leen PENDING y despues los dos escriben RUNNING, el mismo cliente se
   * sincroniza dos veces en paralelo. Son dos logins simultaneos contra ARCA
   * con la misma clave, que es justo lo que dispara el bloqueo de la cuenta.
   */
  tomarProximoJob(
    workerId: string,
    ahoraIso: string,
    leaseHastaIso: string,
  ): Promise<SyncJob | null>;

  /** Reserva de forma excluyente la cuenta ARCA del job ya tomado. */
  adquirirBloqueoCuenta(
    jobId: string,
    workerId: string,
    claveCuenta: string,
    ahoraIso: string,
    leaseHastaIso: string,
  ): Promise<boolean>;

  /** Extiende el lease del job y del candado de cuenta que le pertenece. */
  renovarLeaseJob(jobId: string, workerId: string, leaseHastaIso: string): Promise<boolean>;

  /** Devuelve un job a la cola cuando su cuenta ARCA esta ocupada. */
  reencolarJob(
    jobId: string,
    workerId: string,
    disponibleDesdeIso: string,
    detalle: string,
  ): Promise<void>;

  /** Cierra jobs RUNNING abandonados por una caida del worker. */
  recuperarJobsInterrumpidos(ahoraIso: string, antesDeIsoLegacy: string): Promise<number>;

  /**
   * Datos del cliente para sincronizar, sin filtrar por usuario.
   * El tipo `Cliente` no tiene credenciales, asi que esto no expone la clave.
   */
  clienteParaSync(clienteId: string): Promise<Cliente | null>;

  /**
   * Cierra un job y actualiza el cliente en la MISMA transaccion.
   *
   * Van juntos a proposito. Si se pudiera marcar el job DONE sin tocar el
   * cliente, el tablero mostraria "ultimo sync: hace 3 dias" con la cola
   * vacia, y nadie sabria si fallo o nunca corrio.
   */
  finalizarJob(jobId: string, resultado: ResultadoJob, workerId?: string): Promise<void>;
}

export interface ResultadoJob {
  estado: 'DONE' | 'ERROR' | 'NEEDS_HUMAN';
  /** Que mostrarle al contador en el tablero. */
  detalle?: string;
  /**
   * Solo cuando el fallo fue de credencial. Marcar INVALIDA/BLOQUEADA/VENCIDA
   * es lo que frena los reintentos: el endpoint de sincronizar exige estado OK.
   */
  estadoCredencial?: EstadoCredencial;
}
