/**
 * Capa de datos del tablero.
 *
 * Es la ÚNICA parte del front que sabe de dónde vienen los datos. Antes
 * resolvía contra mocks locales; ahora habla con `arca-api`. Ninguna pantalla
 * cambió al hacer el switch — para eso estaba aislada.
 */
import type {
  AdministracionClientes,
  Cliente,
  DetalleCliente,
  EmpresaRepresentada,
  Notificacion,
  ResumenCliente,
  ResumenEmpresa,
  SolicitudAcceso,
  SyncJob,
  Usuario,
  UsuarioGestion,
} from '../types';

const BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';
const CLAVE_TOKEN = 'arcapanel.token';

export class ErrorApi extends Error {
  constructor(
    readonly status: number,
    mensaje: string,
    /** Codigo estable de la API, cuando el status solo no alcanza. */
    readonly codigo?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorApi';
  }
}

export function leerToken(): string | null {
  return localStorage.getItem(CLAVE_TOKEN);
}
export function guardarToken(token: string): void {
  localStorage.setItem(CLAVE_TOKEN, token);
}
export function borrarToken(): void {
  localStorage.removeItem(CLAVE_TOKEN);
}

/** Se dispara ante cualquier 401 para que la app vuelva al login. */
let alExpirarSesion: (() => void) | null = null;
export function onSesionExpirada(fn: () => void): void {
  alExpirarSesion = fn;
}

async function pedirRespuesta(ruta: string, opciones: RequestInit = {}): Promise<Response> {
  const token = leerToken();
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      ...(opciones.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });

  // /sesion/login no exige sesión previa: un 401 ahí es "contraseña
  // incorrecta", no "tu sesión venció". Tratarlo igual que el resto de los
  // 401 mostraba un mensaje que no tenía nada que ver, y empujaba a
  // reintentar en vez de corregir la contraseña.
  if (res.status === 401 && ruta !== '/sesion/login') {
    // El token venció o es inválido. Limpiar y volver al login: dejar la
    // pantalla con datos viejos haría creer que la sesión sigue viva.
    borrarToken();
    alExpirarSesion?.();
    throw new ErrorApi(401, 'Tu sesión expiró. Volvé a entrar.');
  }

  if (!res.ok) {
    const cuerpo = (await res.json().catch(() => null)) as {
      error?: string;
      codigo?: string;
    } | null;
    throw new ErrorApi(res.status, cuerpo?.error ?? `Error ${res.status}.`, cuerpo?.codigo);
  }

  return res;
}

async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const res = await pedirRespuesta(ruta, opciones);

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function pedirBlob(ruta: string): Promise<Blob> {
  return (await pedirRespuesta(ruta)).blob();
}

/* --- Sesión --- */

export async function iniciarSesion(email: string, password: string): Promise<Usuario> {
  const r = await pedir<{ token: string; usuario: Usuario }>('/sesion/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  guardarToken(r.token);
  return r.usuario;
}

export function obtenerSesionActual(): Promise<Usuario> {
  return pedir<Usuario>('/sesion/yo');
}

/** Cambia la contraseña de la cuenta con la que estás dentro, no la de otro. */
export function cambiarPasswordPropia(
  passwordActual: string,
  passwordNueva: string,
): Promise<void> {
  return pedir<void>('/sesion/password', {
    method: 'PATCH',
    body: JSON.stringify({ passwordActual, passwordNueva }),
  });
}

/* --- Tablero --- */

export function listarResumenClientes(): Promise<ResumenCliente[]> {
  // El orden por urgencia lo calcula el servidor: si lo hiciera cada cliente
  // HTTP, dos frontends podrían mostrar prioridades distintas.
  return pedir<ResumenCliente[]>('/clientes');
}

/**
 * El panel: una fila por (cuenta, empresa) con sus propios numeros.
 *
 * El orden por urgencia lo calcula el servidor, igual que el de cuentas: si lo
 * hiciera cada cliente HTTP, dos frontends mostrarian prioridades distintas.
 */
export function listarEmpresas(): Promise<ResumenEmpresa[]> {
  return pedir<ResumenEmpresa[]>('/clientes/empresas');
}

/** Las empresas de UNA cuenta, para el selector dentro del detalle. */
export function listarEmpresasDeCliente(clienteId: string): Promise<EmpresaRepresentada[]> {
  return pedir<EmpresaRepresentada[]>(`/clientes/${encodeURIComponent(clienteId)}/empresas`);
}

/**
 * Corrige la razón social de una cuenta.
 *
 * Es el nombre de la CUENTA, no el de la empresa: si la cuenta representa a
 * varias, sus razones sociales salen del padrón y se editan por separado.
 */
export function renombrarCliente(clienteId: string, razonSocial: string): Promise<Cliente> {
  return pedir<Cliente>(`/clientes/${encodeURIComponent(clienteId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ razonSocial }),
  });
}

/**
 * Sincroniza UNA empresa.
 *
 * Distinto de `sincronizarCompleto`, que recorre la cuenta entera en una pasada
 * por servicio: acá el worker se posiciona en ese CUIT y no toca a las demás.
 */
export function sincronizarEmpresa(clienteId: string, cuit: string): Promise<SyncJob> {
  return pedir<SyncJob>(
    `/clientes/${encodeURIComponent(clienteId)}/empresas/${encodeURIComponent(cuit)}/sincronizar`,
    { method: 'POST' },
  );
}

/**
 * Detalle de una cuenta, o de UNA de sus empresas si se pasa el CUIT.
 *
 * Sin `empresa` devuelve la cuenta entera, que es la mezcla de todos sus
 * representados — lo que se veía antes de separar por empresa.
 */
export async function obtenerDetalleCliente(
  clienteId: string,
  empresa?: string,
): Promise<DetalleCliente | null> {
  const filtro = empresa ? `?empresa=${encodeURIComponent(empresa)}` : '';
  try {
    return await pedir<DetalleCliente>(`/clientes/${encodeURIComponent(clienteId)}${filtro}`);
  } catch (e) {
    // 404 es tanto "no existe" como "no es tuyo": la API no los distingue a
    // propósito, y acá tampoco hace falta.
    if (e instanceof ErrorApi && e.status === 404) return null;
    throw e;
  }
}

/**
 * Carga o corrige la razón social de un contribuyente ARCA.
 * El nombre es global: vale en todo el panel, no sólo en este cliente.
 */
export function guardarNombreContribuyente(
  cuit: string,
  nombre: string,
): Promise<{ cuit: string; nombre: string }> {
  return pedir<{ cuit: string; nombre: string }>(
    `/contribuyentes/${encodeURIComponent(cuit)}`,
    { method: 'PUT', body: JSON.stringify({ nombre }) },
  );
}

/** Registra la apertura dentro de la app y devuelve el detalle persistido. */
export function marcarNotificacionVista(
  clienteId: string,
  notificacionId: string,
): Promise<Notificacion> {
  return pedir<Notificacion>(
    `/clientes/${encodeURIComponent(clienteId)}/notificaciones/${encodeURIComponent(notificacionId)}/vista`,
    { method: 'POST' },
  );
}

export function actualizarLecturaNotificacion(
  clienteId: string,
  notificacionId: string,
  leido: boolean,
): Promise<{ leidoAppEn: string | null }> {
  return pedir<{ leidoAppEn: string | null }>(
    `/clientes/${encodeURIComponent(clienteId)}/notificaciones/${encodeURIComponent(notificacionId)}/lectura`,
    { method: 'PATCH', body: JSON.stringify({ leido }) },
  );
}

export function actualizarLecturaPlan(
  clienteId: string,
  planId: string,
  leido: boolean,
): Promise<{ leidoAppEn: string | null }> {
  return pedir<{ leidoAppEn: string | null }>(
    `/clientes/${encodeURIComponent(clienteId)}/planes/${encodeURIComponent(planId)}/lectura`,
    { method: 'PATCH', body: JSON.stringify({ leido }) },
  );
}

/** Descarga autenticada: un enlace comun no incluiria el token Bearer. */
export function descargarAdjuntoNotificacion(
  clienteId: string,
  notificacionId: string,
  adjuntoId: string,
): Promise<Blob> {
  return pedirBlob(
    `/clientes/${encodeURIComponent(clienteId)}/notificaciones/${encodeURIComponent(notificacionId)}/adjuntos/${encodeURIComponent(adjuntoId)}`,
  );
}

/* --- Administración --- */

export function obtenerAdministracionClientes(): Promise<AdministracionClientes> {
  return pedir<AdministracionClientes>('/clientes/administracion');
}

export function crearCliente(datos: { cuit: string; razonSocial: string }): Promise<Cliente> {
  return pedir<Cliente>('/clientes', { method: 'POST', body: JSON.stringify(datos) });
}

/**
 * Pide acceso a una empresa que otra cuenta ya tiene cargada.
 *
 * La clave viaja igual que en el alta de credenciales: se cifra en el servidor
 * y no vuelve nunca. Acá no otorga nada — deja el pedido en cola para que el
 * worker pruebe contra ARCA que esa clave puede actuar por ese CUIT.
 */
export function pedirAccesoAEmpresa(datos: {
  cuit: string;
  usuarioCuit: string;
  clave: string;
}): Promise<{ solicitud: SolicitudAcceso; job: SyncJob }> {
  return pedir('/clientes/solicitudes', { method: 'POST', body: JSON.stringify(datos) });
}

export function listarSolicitudes(): Promise<SolicitudAcceso[]> {
  return pedir<SolicitudAcceso[]>('/clientes/solicitudes');
}

/**
 * Espera el veredicto del worker sobre un pedido de acceso.
 *
 * No usa `esperarJob`: seguir el job significa pedir `/clientes/:id/jobs`, y
 * esa empresa todavía no está en la cuenta — la barrera multi-tenant responde
 * 404, que es exactamente lo que tiene que hacer. La solicitud propia sí es
 * visible, así que el estado se sigue por ahí.
 */
export async function esperarSolicitud(
  solicitudId: string,
  alActualizar?: (solicitud: SolicitudAcceso) => void,
): Promise<SolicitudAcceso> {
  const limite = Date.now() + 15 * 60_000;
  while (Date.now() < limite) {
    const solicitud = (await listarSolicitudes()).find(
      (candidata) => candidata.id === solicitudId,
    );
    if (solicitud) alActualizar?.(solicitud);
    if (solicitud && solicitud.estado !== 'PENDIENTE') return solicitud;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('La verificación sigue en curso. Volvé a consultar en unos minutos.');
}

/** El acceso se manda y no vuelve nunca: no hay endpoint que lo devuelva. */
export function guardarCredencial(
  clienteId: string,
  usuarioCuit: string,
  clave: string,
): Promise<Cliente> {
  return pedir<Cliente>(`/clientes/${encodeURIComponent(clienteId)}/credencial`, {
    method: 'POST',
    body: JSON.stringify({ usuarioCuit, clave }),
  });
}

export function sincronizarAhora(clienteId: string): Promise<SyncJob> {
  return pedir<SyncJob>(`/clientes/${encodeURIComponent(clienteId)}/sincronizar`, { method: 'POST' });
}

export function sincronizarCompleto(clienteId: string): Promise<SyncJob> {
  return pedir<SyncJob>(`/clientes/${encodeURIComponent(clienteId)}/sincronizar-completa`, {
    method: 'POST',
  });
}

export function sincronizarFacilidades(clienteId: string): Promise<SyncJob> {
  return pedir<SyncJob>(`/clientes/${encodeURIComponent(clienteId)}/sincronizar-facilidades`, {
    method: 'POST',
  });
}

export function sincronizarDomicilio(clienteId: string): Promise<SyncJob> {
  return pedir<SyncJob>(`/clientes/${encodeURIComponent(clienteId)}/sincronizar-domicilio`, {
    method: 'POST',
  });
}

export function sincronizarSaldos(clienteId: string): Promise<SyncJob> {
  return pedir<SyncJob>(`/clientes/${encodeURIComponent(clienteId)}/sincronizar-saldos`, {
    method: 'POST',
  });
}

export function obtenerJobs(clienteId: string): Promise<SyncJob[]> {
  return pedir<SyncJob[]>(`/clientes/${encodeURIComponent(clienteId)}/jobs`);
}

/** Mantiene el popup ligado al job real, incluso si ARCA tarda varios minutos. */
export async function esperarJob(
  clienteId: string,
  jobId: string,
  alActualizar?: (job: SyncJob) => void,
): Promise<SyncJob> {
  const limite = Date.now() + 15 * 60_000;
  while (Date.now() < limite) {
    const job = (await obtenerJobs(clienteId)).find((candidato) => candidato.id === jobId);
    if (job) alActualizar?.(job);
    if (job && !['PENDING', 'RUNNING'].includes(job.estado)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('El worker continúa ejecutándose. Volvé a consultar el cliente en unos minutos.');
}

export function eliminarCliente(clienteId: string): Promise<void> {
  return pedir<void>(`/clientes/${encodeURIComponent(clienteId)}`, { method: 'DELETE' });
}

/* --- Gestión de usuarios (sólo administradores) --- */

export function listarUsuarios(): Promise<UsuarioGestion[]> {
  return pedir<UsuarioGestion[]>('/usuarios');
}

export function crearUsuario(datos: {
  nombre: string;
  email: string;
  password: string;
  limiteClientes: number;
}): Promise<UsuarioGestion> {
  return pedir<UsuarioGestion>('/usuarios', { method: 'POST', body: JSON.stringify(datos) });
}

export function actualizarUsuario(
  usuarioId: string,
  cambios: {
    nombre?: string;
    password?: string;
    limiteClientes?: number;
    activo?: boolean;
  },
): Promise<UsuarioGestion> {
  return pedir<UsuarioGestion>(`/usuarios/${encodeURIComponent(usuarioId)}`, {
    method: 'PATCH',
    body: JSON.stringify(cambios),
  });
}

/**
 * Otorga o quita permisos de administrador.
 *
 * Va aparte de `actualizarUsuario` porque la API mantiene el 409 sobre las
 * cuentas admin en `PATCH /usuarios/:id`: el rol es lo único que se les cambia.
 * Al bajar a `user` el cupo es obligatorio — sin límite es sólo para admins.
 */
export function cambiarRolUsuario(
  usuarioId: string,
  cambio: { rol: 'admin' } | { rol: 'user'; limiteClientes: number },
): Promise<UsuarioGestion> {
  return pedir<UsuarioGestion>(`/usuarios/${encodeURIComponent(usuarioId)}/rol`, {
    method: 'PATCH',
    body: JSON.stringify(cambio),
  });
}

/** Comparte una empresa ya cargada con otra cuenta, sin volver a darla de alta. */
export function asignarClienteAUsuario(
  usuarioId: string,
  clienteId: string,
): Promise<UsuarioGestion> {
  return pedir<UsuarioGestion>(
    `/usuarios/${encodeURIComponent(usuarioId)}/clientes/${encodeURIComponent(clienteId)}`,
    { method: 'POST' },
  );
}

export function quitarClienteDeUsuario(usuarioId: string, clienteId: string): Promise<void> {
  return pedir<void>(
    `/usuarios/${encodeURIComponent(usuarioId)}/clientes/${encodeURIComponent(clienteId)}`,
    { method: 'DELETE' },
  );
}

/* --- Utilidades de dominio --- */

/**
 * Validación de CUIT del lado del cliente, para dar feedback mientras se
 * escribe. La API valida igual: esto es comodidad, no seguridad.
 */
export function validarCuit(entrada: string): string | null {
  const cuit = entrada.replace(/\D/g, '');
  if (cuit.length !== 11) return `Tiene ${cuit.length} dígitos y debe tener 11.`;

  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(cuit[i]), 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;

  if (Number(cuit[10]) !== esperado) return 'El dígito verificador no es correcto.';
  return null;
}

export function diasHasta(fechaIso: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const objetivo = new Date(`${fechaIso}T00:00:00`);
  return Math.round((objetivo.getTime() - hoy.getTime()) / 86_400_000);
}
