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
  SolicitudAcceso,
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

/** Resultado de asignar un cliente ya existente a otra cuenta. */
export type ResultadoAsignacion = 'ASIGNADO' | 'YA_ASIGNADO' | 'CLIENTE_INEXISTENTE';

/** Resultado de pedir acceso a una empresa que ya está cargada. */
export type ResultadoSolicitud =
  | { estado: 'ENCOLADA'; solicitud: SolicitudAcceso; job: SyncJob }
  | { estado: 'CLIENTE_INEXISTENTE' }
  | { estado: 'YA_ASIGNADO' }
  | { estado: 'YA_PENDIENTE'; solicitud: SolicitudAcceso };

/** Lo que el worker necesita para verificar una solicitud. */
export interface SolicitudParaVerificar {
  id: string;
  clienteId: string;
  /** CUIT del contribuyente por el que hay que poder actuar en ARCA. */
  cuit: string;
  cifrada: CredencialCifrada;
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

  /**
   * Crea la PRIMERA cuenta administradora, y sólo si no existe ningún usuario.
   *
   * Hace falta porque `crearUsuario` fuerza el rol `user`: por HTTP no hay
   * —ni debe haber— forma de fabricar un admin. Sin este método una instalación
   * con SEMBRAR_DEMO=0 arranca con la tabla vacía y no puede entrar nadie
   * nunca, porque para crear el primer usuario hay que estar logueado como
   * admin.
   *
   * Devuelve null si ya hay cualquier usuario. Esa condición se evalúa DENTRO
   * de la misma transacción que el alta, no antes: si pudiera correr contra una
   * base ya poblada, la variable de entorno que lo dispara sería una puerta
   * trasera para agregarse un admin a un sistema en uso.
   */
  crearAdminInicial(datos: {
    email: string;
    nombre: string;
    passwordHash: string;
  }): Promise<UsuarioGestion | null>;
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
   * Asigna un cliente YA EXISTENTE a otra cuenta. Es la simétrica de
   * `eliminarClienteDe`, y sin ella un cliente cargado por alguien no se puede
   * compartir nunca: el alta rechaza el CUIT repetido, así que no hay segundo
   * camino para llegar al mismo contribuyente.
   *
   * Devuelve un resultado en vez de lanzar para que la ruta pueda distinguir
   * "no existe" de "ya estaba" SIN necesidad de un `obtenerCliente(id)` suelto
   * — que es justamente lo que esta interfaz evita a propósito.
   */
  asignarClienteA(usuarioId: string, clienteId: string): Promise<ResultadoAsignacion>;

  /**
   * Pide acceso a la empresa de ese CUIT adjuntando una clave fiscal cifrada.
   *
   * NO asigna nada: deja la solicitud PENDIENTE y encola el job que la
   * verifica. El acceso se otorga recién cuando el worker prueba contra ARCA
   * que esa clave entra y puede actuar por ese CUIT. Sin esa prueba, escribir
   * un CUIT —que es público— alcanzaría para leer la carpeta fiscal de la
   * cartera de otra oficina.
   *
   * Toma el CUIT y no un `clienteId` a propósito: quien pide acceso todavía no
   * ve esa empresa, así que no tiene forma legítima de conocer su id.
   */
  solicitarAcceso(
    usuarioId: string,
    cuit: string,
    cifrada: CredencialCifrada,
  ): Promise<ResultadoSolicitud>;

  /** Solicitudes propias, para que la pantalla siga el resultado. */
  solicitudesDe(usuarioId: string): Promise<SolicitudAcceso[]>;

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

  /* --- Razón social de los contribuyentes agrupados --------------------
   *
   * Cuentas Tributarias devuelve datos de VARIOS contribuyentes bajo una misma
   * cuenta ARCA, y su desplegable trae sólo el CUIT — el nombre no viene. Estos
   * dos métodos resuelven ese hueco.
   * ------------------------------------------------------------------- */

  /**
   * Razón social de cada CUIT pedido. Resuelve primero contra los clientes ya
   * cargados (ese nombre ya lo tenés) y después contra los cargados a mano.
   *
   * Devuelve sólo los que tienen nombre: un CUIT ausente del resultado es uno
   * sin identificar, que la UI muestra como hasta ahora.
   */
  nombresDeContribuyentes(cuits: readonly string[]): Promise<Record<string, string>>;

  /** Carga o corrige la razón social de un CUIT. Vale para todo el panel. */
  guardarNombreContribuyente(cuit: string, nombre: string): Promise<void>;

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
   * Estos metodos NO reciben usuarioId, a diferencia de todo el resto de
   * la interfaz. Es deliberado: el worker no actua en nombre de un usuario,
   * corre la cola entera. Por eso mismo ninguna ruta HTTP puede llamarlos —
   * la misma regla que ya vale para `leerCredencialCifrada`.
   * ------------------------------------------------------------------- */

  /**
   * Solo para el worker. Devuelve la clave fiscal cifrada que acompaña a una
   * solicitud de acceso. No debe existir ningun endpoint HTTP que llegue aca.
   */
  solicitudParaVerificar(solicitudId: string): Promise<SolicitudParaVerificar | null>;

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

  /**
   * Clientes que la sincronizacion nocturna deberia encolar: credencial en
   * condiciones y sin intento desde `anteriorAIso`.
   *
   * Va en este bloque y NO recibe usuarioId porque el planificador tampoco
   * actua en nombre de un usuario: mira la cartera entera. Vale la misma regla
   * que para los otros tres — ninguna ruta HTTP puede llamarlo.
   *
   * El filtro por credencial es el que importa: un cliente marcado INVALIDA o
   * BLOQUEADA queda afuera, para no reintentar de noche contra una clave que
   * ya se sabe mala y terminar bloqueando la cuenta del contribuyente.
   */
  clientesParaSyncAutomatica(anteriorAIso: string): Promise<Cliente[]>;

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
