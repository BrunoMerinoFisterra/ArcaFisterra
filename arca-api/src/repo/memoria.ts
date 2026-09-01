import { randomUUID } from 'node:crypto';
import type { CredencialCifrada } from '../crypto/envelope.js';
import { hashearPassword } from '../crypto/password.js';
import type {
  Cliente,
  Comprobante,
  DeclaracionJuradaPendiente,
  Notificacion,
  PlanPago,
  SaldoTributario,
  SolicitudAcceso,
  SyncJob,
  UsuarioConHash,
  Vencimiento,
} from '../dominio/tipos.js';
import { estadoNotificacion } from '../dominio/notificaciones.js';
import type { NotificacionAdjuntoContenido, Repositorio } from './tipos.js';

/**
 * Repositorio en memoria con datos de demostracion. TODO ficticio.
 *
 * No persiste: reiniciar el proceso vuelve al estado inicial. Sirve para
 * desarrollar y testear sin depender de la Azure SQL, y para que el front
 * tenga contra que hablar.
 *
 * Las asignaciones usuario->cliente estan a proposito desparejas: `ayudante`
 * ve solo dos clientes. Sin eso, el aislamiento multi-tenant no se puede
 * probar de verdad — con un solo usuario que ve todo, un filtro roto pasa
 * desapercibido.
 */

const PASSWORD_DEMO = 'demo';

function diasDesdeHoy(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function horasAtras(horas: number): string {
  const d = new Date();
  d.setHours(d.getHours() - horas);
  return d.toISOString();
}

export async function crearRepositorioMemoria(): Promise<Repositorio> {
  const hash = await hashearPassword(PASSWORD_DEMO);

  const usuarios: UsuarioConHash[] = [
    {
      id: 'u1',
      email: 'bruno@fisterra.com',
      nombre: 'Bruno Merino',
      rol: 'admin',
      activo: true,
      limiteClientes: null,
      passwordHash: hash,
    },
    {
      id: 'u2',
      email: 'ayudante@fisterra.com',
      nombre: 'Ayudante',
      rol: 'user',
      activo: true,
      limiteClientes: 5,
      passwordHash: hash,
    },
  ];

  const clientes: Cliente[] = [
    {
      id: 'c1',
      cuit: '30-71234567-1',
      razonSocial: 'Molinos del Sur S.A.',
      estadoCredencial: 'OK',
      estadoSync: 'OK',
      ultimoSync: horasAtras(3),
      credencialCargadaEn: diasDesdeHoy(-140),
    },
    {
      id: 'c2',
      cuit: '30-70987654-2',
      razonSocial: 'Delta Logística S.R.L.',
      estadoCredencial: 'OK',
      estadoSync: 'OK',
      ultimoSync: horasAtras(5),
      credencialCargadaEn: diasDesdeHoy(-98),
    },
    {
      id: 'c3',
      cuit: '27-28456789-2',
      razonSocial: 'Bertoni, Andrea Lucía',
      estadoCredencial: 'OK',
      estadoSync: 'OK',
      ultimoSync: horasAtras(4),
      credencialCargadaEn: diasDesdeHoy(-61),
    },
    {
      id: 'c4',
      cuit: '30-69874521-1',
      razonSocial: 'Textil Norte S.A.',
      estadoCredencial: 'VENCIDA',
      estadoSync: 'NECESITA_HUMANO',
      ultimoSync: horasAtras(72),
      detalleSync: 'ARCA exige cambiar la clave fiscal. Cambiala en el portal y actualizala acá.',
      credencialCargadaEn: diasDesdeHoy(-210),
    },
    {
      id: 'c5',
      cuit: '30-71122334-3',
      razonSocial: 'Comercial Rivadavia S.R.L.',
      estadoCredencial: 'INVALIDA',
      estadoSync: 'ERROR',
      ultimoSync: horasAtras(96),
      detalleSync:
        'La clave fiscal guardada es incorrecta. Actualizala antes de volver a sincronizar.',
      credencialCargadaEn: diasDesdeHoy(-175),
    },
    {
      id: 'c6',
      cuit: '20-25478963-2',
      razonSocial: 'Ferretería Belgrano',
      estadoCredencial: 'SIN_CARGAR',
      estadoSync: 'NUNCA',
      ultimoSync: null,
      detalleSync: 'Falta cargar la clave fiscal del cliente.',
      credencialCargadaEn: null,
    },
  ];

  /** CUIT del cliente sembrado, para no repetirlo en cada fila de demo. */
  const cuitDe = (clienteId: string): string =>
    clientes.find((cliente) => cliente.id === clienteId)?.cuit ?? '';

  /** Espeja la tabla arca_user_clientes. */
  const asignaciones = new Map<string, Set<string>>([
    ['u1', new Set(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])],
    ['u2', new Set(['c1', 'c2'])],
  ]);

  const credenciales = new Map<string, CredencialCifrada>();
  /** Espeja arca_solicitudes_acceso, con la credencial de un solo uso aparte. */
  const solicitudes: Array<SolicitudAcceso & { usuarioId: string }> = [];
  const credencialesSolicitud = new Map<string, CredencialCifrada>();
  /** CUIT (11 dígitos, sin guiones) -> razón social cargada a mano. */
  const nombresContribuyentes = new Map<string, string>();
  const jobs: SyncJob[] = [];
  const propietariosJob = new Map<string, string>();
  const leasesJob = new Map<string, string>();
  const disponiblesDesde = new Map<string, string>();
  const bloqueosCuenta = new Map<
    string,
    { jobId: string; workerId: string; leaseHasta: string }
  >();

  function liberarBloqueoDeJob(jobId: string): void {
    for (const [clave, bloqueo] of bloqueosCuenta) {
      if (bloqueo.jobId === jobId) bloqueosCuenta.delete(clave);
    }
  }

  const notificacionDemo = (
    id: string,
    clienteId: string,
    idComunicacion: string,
    dias: number,
    asunto: string,
    leida: boolean,
  ): Notificacion => ({
    id,
    clienteId,
    idComunicacion,
    fecha: diasDesdeHoy(dias),
    organismo: 'ARCA',
    asunto,
    leida,
    vistaAppEn: null,
    leidoAppEn: null,
    cuerpo: leida ? asunto : null,
    adjuntos: [],
    estado: estadoNotificacion(leida, null),
  });
  const notificaciones: Notificacion[] = [
    notificacionDemo('n1', 'c1', 'ARCA-1001', -1, 'Intimación por falta de presentación — IVA 07/2026', false),
    notificacionDemo('n2', 'c1', 'ARCA-1002', -6, 'Constancia de presentación F.731', true),
    notificacionDemo('n3', 'c2', 'ARCA-1003', -2, 'Vista de actuaciones — Fiscalización electrónica', false),
    notificacionDemo('n4', 'c2', 'ARCA-1004', -3, 'Aviso de vencimiento de plan de facilidades', false),
    notificacionDemo('n5', 'c3', 'ARCA-1005', -9, 'Recategorización de Monotributo disponible', true),
    notificacionDemo('n6', 'c4', 'ARCA-1006', -4, 'Notificación de deuda — Aportes Seguridad Social', false),
  ];
  const adjuntosNotificaciones = new Map<
    string,
    NotificacionAdjuntoContenido & { notificacionId: string }
  >();

  const saldoDemo = (
    clienteId: string,
    impuesto: string,
    periodo: string,
    saldo: number,
  ): SaldoTributario => ({
    clienteId,
    contribuyenteCuit: clientes.find((cliente) => cliente.id === clienteId)?.cuit ?? '',
    establecimiento: '0',
    impuesto,
    concepto: '',
    subconcepto: '',
    periodo,
    anticipoCuota: '0',
    fechaVencimiento: null,
    saldo,
    interesResarcitorio: 0,
    interesPunitorio: 0,
  });
  const saldos: SaldoTributario[] = [
    saldoDemo('c1', 'IVA', '07/2026', -1_284_500.35),
    saldoDemo('c1', 'Ganancias', '2025', 430_120),
    saldoDemo('c1', 'Seguridad Social', '07/2026', -98_400.5),
    saldoDemo('c2', 'IVA', '07/2026', 215_900.8),
    saldoDemo('c2', 'Ganancias', '2025', -2_450_000),
    saldoDemo('c3', 'Monotributo', '08/2026', 0),
    saldoDemo('c4', 'IVA', '06/2026', -5_120_300.75),
    saldoDemo('c4', 'Seguridad Social', '06/2026', -740_050),
  ];

  const planes: PlanPago[] = [
    { id: 'p1', clienteId: 'c1', numero: 'RG 5321 — 000148223', concepto: 'IVA 2025 — Moratoria', fechaPresentacion: null, fechaConsolidacion: null, tipoPlan: '', montoConsolidado: 0, estado: 'Aceptada', situacion: 'Vigente', cuotasTotales: 24, cuotasPagas: 14, montoCuota: 187_400, proximoVencimiento: diasDesdeHoy(9), cuotasImpagas: 0, totalPagado: 0, leidoAppEn: null, cuotas: [] },
    { id: 'p2', clienteId: 'c2', numero: 'RG 4268 — 000097431', concepto: 'Ganancias 2024', fechaPresentacion: null, fechaConsolidacion: null, tipoPlan: '', montoConsolidado: 0, estado: 'Aceptada', situacion: 'Vigente', cuotasTotales: 12, cuotasPagas: 7, montoCuota: 342_800, proximoVencimiento: diasDesdeHoy(-5), cuotasImpagas: 2, totalPagado: 0, leidoAppEn: null, cuotas: [] },
    { id: 'p3', clienteId: 'c4', numero: 'RG 5321 — 000151980', concepto: 'Seguridad Social 2025', fechaPresentacion: null, fechaConsolidacion: null, tipoPlan: '', montoConsolidado: 0, estado: 'Aceptada', situacion: 'Plan caduco', cuotasTotales: 36, cuotasPagas: 4, montoCuota: 96_250, proximoVencimiento: diasDesdeHoy(-18), cuotasImpagas: 3, totalPagado: 0, leidoAppEn: null, cuotas: [] },
  ];

  const vencimientoDemo = (
    id: string,
    clienteId: string,
    impuesto: string,
    periodo: string,
    fecha: string,
  ): Vencimiento => ({
    id,
    clienteId,
    contribuyenteCuit: clientes.find((cliente) => cliente.id === clienteId)?.cuit ?? '',
    impuesto,
    concepto: '',
    subconcepto: '',
    periodo,
    anticipoCuota: '',
    fecha,
    detalle: '',
  });
  const vencimientos: Vencimiento[] = [
    vencimientoDemo('v1', 'c1', 'IVA', '07/2026', diasDesdeHoy(4)),
    vencimientoDemo('v2', 'c1', 'SICORE', '07/2026', diasDesdeHoy(7)),
    vencimientoDemo('v3', 'c1', 'F.931', '07/2026', diasDesdeHoy(20)),
    vencimientoDemo('v4', 'c2', 'IVA', '07/2026', diasDesdeHoy(5)),
    vencimientoDemo('v5', 'c2', 'F.931', '07/2026', diasDesdeHoy(11)),
    vencimientoDemo('v6', 'c3', 'Monotributo', '08/2026', diasDesdeHoy(15)),
    vencimientoDemo('v7', 'c4', 'IVA', '07/2026', diasDesdeHoy(6)),
    vencimientoDemo('v8', 'c5', 'IVA', '07/2026', diasDesdeHoy(6)),
  ];
  const ddjjPendientes: DeclaracionJuradaPendiente[] = [];

  const comprobantes: Comprobante[] = [
    { id: 'k1', clienteId: 'c1', contribuyenteCuit: cuitDe('c1'), tipo: 'EMITIDO', fecha: diasDesdeHoy(-2), codigoComprobante: 1, tipoComprobante: 'Factura A', puntoVenta: 3, numero: 20481, contraparte: 'Distribuidora Paraná S.A.', cuitContraparte: '30-70112233-6', neto: 1_240_000, iva: 260_400, total: 1_500_400 },
    { id: 'k2', clienteId: 'c1', contribuyenteCuit: cuitDe('c1'), tipo: 'EMITIDO', fecha: diasDesdeHoy(-8), codigoComprobante: 1, tipoComprobante: 'Factura A', puntoVenta: 3, numero: 20480, contraparte: 'Agro Insumos del Litoral S.R.L.', cuitContraparte: '30-71455667-9', neto: 890_000, iva: 186_900, total: 1_076_900 },
    { id: 'k3', clienteId: 'c1', contribuyenteCuit: cuitDe('c1'), tipo: 'RECIBIDO', fecha: diasDesdeHoy(-4), codigoComprobante: 1, tipoComprobante: 'Factura A', puntoVenta: 12, numero: 884_321, contraparte: 'Transporte Andino S.A.', cuitContraparte: '30-68997744-4', neto: 415_000, iva: 87_150, total: 502_150 },
    { id: 'k4', clienteId: 'c1', contribuyenteCuit: cuitDe('c1'), tipo: 'RECIBIDO', fecha: diasDesdeHoy(-11), codigoComprobante: 3, tipoComprobante: 'Nota de Crédito A', puntoVenta: 12, numero: 884_190, contraparte: 'Transporte Andino S.A.', cuitContraparte: '30-68997744-4', neto: -62_000, iva: -13_020, total: -75_020 },
    { id: 'k5', clienteId: 'c2', contribuyenteCuit: cuitDe('c2'), tipo: 'EMITIDO', fecha: diasDesdeHoy(-1), codigoComprobante: 6, tipoComprobante: 'Factura B', puntoVenta: 7, numero: 15_233, contraparte: 'Consumidor Final', cuitContraparte: '—', neto: 268_000, iva: 56_280, total: 324_280 },
    { id: 'k6', clienteId: 'c2', contribuyenteCuit: cuitDe('c2'), tipo: 'RECIBIDO', fecha: diasDesdeHoy(-3), codigoComprobante: 1, tipoComprobante: 'Factura A', puntoVenta: 4, numero: 331_200, contraparte: 'Combustibles Cuyo S.A.', cuitContraparte: '30-70554433-2', neto: 1_890_000, iva: 396_900, total: 2_286_900 },
    { id: 'k7', clienteId: 'c3', contribuyenteCuit: cuitDe('c3'), tipo: 'EMITIDO', fecha: diasDesdeHoy(-6), codigoComprobante: 11, tipoComprobante: 'Factura C', puntoVenta: 1, numero: 412, contraparte: 'Estudio Jurídico Roldán', cuitContraparte: '30-71889900-8', neto: 480_000, iva: 0, total: 480_000 },
  ];

  const puedeVer = (usuarioId: string, clienteId: string) =>
    asignaciones.get(usuarioId)?.has(clienteId) ?? false;

  const buscarCliente = (clienteId: string) => clientes.find((c) => c.id === clienteId) ?? null;

  return {
    async buscarUsuarioPorEmail(email) {
      return usuarios.find(
        (u) => u.activo && u.email.toLowerCase() === email.toLowerCase(),
      ) ?? null;
    },
    async buscarUsuarioPorId(id) {
      return usuarios.find((u) => u.activo && u.id === id) ?? null;
    },
    async listarUsuarios() {
      return usuarios
        .map((usuario) => ({
          id: usuario.id,
          email: usuario.email,
          nombre: usuario.nombre,
          rol: usuario.rol,
          activo: usuario.activo,
          limiteClientes: usuario.limiteClientes,
          clientesAsignados: asignaciones.get(usuario.id)?.size ?? 0,
        }))
        .sort((a, b) => {
          if (a.rol !== b.rol) return a.rol === 'admin' ? -1 : 1;
          return a.nombre.localeCompare(b.nombre, 'es');
        });
    },
    async existeEmailUsuario(email) {
      return usuarios.some((u) => u.email.toLowerCase() === email.toLowerCase());
    },
    async crearAdminInicial(datos) {
      if (usuarios.length > 0) return null;
      const usuario: UsuarioConHash = {
        id: randomUUID(),
        email: datos.email,
        nombre: datos.nombre,
        rol: 'admin',
        activo: true,
        limiteClientes: null,
        passwordHash: datos.passwordHash,
      };
      usuarios.push(usuario);
      asignaciones.set(usuario.id, new Set());
      return {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        activo: usuario.activo,
        limiteClientes: usuario.limiteClientes,
        clientesAsignados: 0,
      };
    },

    async crearUsuario(datos) {
      const usuario: UsuarioConHash = {
        id: randomUUID(),
        email: datos.email,
        nombre: datos.nombre,
        rol: 'user',
        activo: true,
        limiteClientes: datos.limiteClientes,
        passwordHash: datos.passwordHash,
      };
      usuarios.push(usuario);
      asignaciones.set(usuario.id, new Set());
      return {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        activo: usuario.activo,
        limiteClientes: usuario.limiteClientes,
        clientesAsignados: 0,
      };
    },
    async actualizarUsuario(usuarioId, cambios) {
      const usuario = usuarios.find((candidato) => candidato.id === usuarioId);
      if (!usuario) return null;
      if (cambios.nombre !== undefined) usuario.nombre = cambios.nombre;
      if (cambios.passwordHash !== undefined) usuario.passwordHash = cambios.passwordHash;
      if (cambios.limiteClientes !== undefined) usuario.limiteClientes = cambios.limiteClientes;
      if (cambios.activo !== undefined) usuario.activo = cambios.activo;
      return {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre,
        rol: usuario.rol,
        activo: usuario.activo,
        limiteClientes: usuario.limiteClientes,
        clientesAsignados: asignaciones.get(usuario.id)?.size ?? 0,
      };
    },
    async cantidadClientesDe(usuarioId) {
      return asignaciones.get(usuarioId)?.size ?? 0;
    },

    async listarClientesDe(usuarioId) {
      return clientes.filter((c) => puedeVer(usuarioId, c.id));
    },
    async obtenerClienteDe(usuarioId, clienteId) {
      if (!puedeVer(usuarioId, clienteId)) return null;
      return buscarCliente(clienteId);
    },
    async existeCuit(cuit) {
      return clientes.some((c) => c.cuit === cuit);
    },
    async crearCliente(datos, usuarioId) {
      const cliente: Cliente = {
        id: randomUUID(),
        cuit: datos.cuit,
        razonSocial: datos.razonSocial,
        estadoCredencial: 'SIN_CARGAR',
        estadoSync: 'NUNCA',
        ultimoSync: null,
        detalleSync: 'Falta cargar la clave fiscal del cliente.',
        credencialCargadaEn: null,
      };
      clientes.push(cliente);
      // Quien lo crea queda con acceso; si no, lo perderia de vista al instante.
      asignaciones.get(usuarioId)?.add(cliente.id);
      return cliente;
    },
    async clientesParaSyncAutomatica(anteriorAIso) {
      return clientes
        .filter(
          (cliente) =>
            cliente.estadoCredencial === 'OK' &&
            (cliente.ultimoSync === null || cliente.ultimoSync < anteriorAIso),
        )
        .sort((a, b) => (a.ultimoSync ?? '').localeCompare(b.ultimoSync ?? ''));
    },

    async nombresDeContribuyentes(cuits) {
      const digitos = [...new Set(cuits.map((cuit) => cuit.replace(/\D/g, '')))].filter(
        (cuit) => cuit.length === 11,
      );
      const resuelto: Record<string, string> = {};
      for (const cuit of digitos) {
        // El cliente cargado manda: ese nombre ya lo tenés.
        const cliente = clientes.find((c) => c.cuit.replace(/\D/g, '') === cuit);
        const nombre = cliente?.razonSocial ?? nombresContribuyentes.get(cuit);
        if (nombre) resuelto[cuit] = nombre;
      }
      return resuelto;
    },

    async guardarNombreContribuyente(cuit, nombre) {
      nombresContribuyentes.set(cuit.replace(/\D/g, ''), nombre);
    },

    async asignarClienteA(usuarioId, clienteId) {
      if (!clientes.some((cliente) => cliente.id === clienteId)) return 'CLIENTE_INEXISTENTE';
      const asignados = asignaciones.get(usuarioId) ?? new Set<string>();
      asignaciones.set(usuarioId, asignados);
      if (asignados.has(clienteId)) return 'YA_ASIGNADO';
      asignados.add(clienteId);
      return 'ASIGNADO';
    },

    async solicitarAcceso(usuarioId, cuit, cifrada) {
      const cliente = clientes.find((candidato) => candidato.cuit === cuit);
      if (!cliente) return { estado: 'CLIENTE_INEXISTENTE' as const };
      if (asignaciones.get(usuarioId)?.has(cliente.id)) return { estado: 'YA_ASIGNADO' as const };

      const pendiente = solicitudes.find(
        (s) => s.usuarioId === usuarioId && s.clienteId === cliente.id && s.estado === 'PENDIENTE',
      );
      if (pendiente) return { estado: 'YA_PENDIENTE' as const, solicitud: pendiente };

      const creadoEn = new Date().toISOString();
      const solicitud = {
        id: randomUUID(),
        usuarioId,
        clienteId: cliente.id,
        cuit: cliente.cuit,
        razonSocial: cliente.razonSocial,
        estado: 'PENDIENTE' as const,
        creadoEn,
      };
      solicitudes.push(solicitud);
      credencialesSolicitud.set(solicitud.id, cifrada);

      const job: SyncJob = {
        id: randomUUID(),
        clienteId: cliente.id,
        modulo: 'verificar-acceso',
        estado: 'PENDING',
        intentos: 0,
        creadoEn,
        progresoActual: 0,
        progresoTotal: 1,
        pasoActual: 'En cola',
        solicitudId: solicitud.id,
      };
      jobs.push(job);
      // Igual que en sqlite: el cliente NO pasa a SINCRONIZANDO. La empresa es
      // de otra oficina y su tablero no se mueve por un pedido de un tercero.
      return { estado: 'ENCOLADA' as const, solicitud, job };
    },

    async solicitudesDe(usuarioId) {
      return solicitudes
        .filter((s) => s.usuarioId === usuarioId)
        .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn))
        .map(({ usuarioId: _omitido, ...resto }) => resto);
    },

    async solicitudParaVerificar(solicitudId) {
      const solicitud = solicitudes.find((s) => s.id === solicitudId && s.estado === 'PENDIENTE');
      const cifrada = credencialesSolicitud.get(solicitudId);
      if (!solicitud || !cifrada) return null;
      return {
        id: solicitud.id,
        clienteId: solicitud.clienteId,
        cuit: solicitud.cuit,
        cifrada,
      };
    },

    async eliminarClienteDe(usuarioId, clienteId) {
      asignaciones.get(usuarioId)?.delete(clienteId);
      const sigueAsignado = [...asignaciones.values()].some((set) => set.has(clienteId));
      if (sigueAsignado) return;
      const i = clientes.findIndex((c) => c.id === clienteId);
      if (i >= 0) clientes.splice(i, 1);
      // Dar de baja borra la credencial: no se dejan claves huerfanas.
      credenciales.delete(clienteId);
      for (const set of asignaciones.values()) set.delete(clienteId);
    },

    async guardarCredencial(clienteId, cifrada) {
      const cliente = buscarCliente(clienteId);
      if (!cliente) throw new Error('cliente inexistente');
      credenciales.set(clienteId, cifrada);
      cliente.credencialCargadaEn = new Date().toISOString();
      cliente.estadoCredencial = 'OK';
      cliente.estadoSync = cliente.ultimoSync ? 'OK' : 'NUNCA';
      delete cliente.detalleSync;
      return cliente;
    },
    async leerCredencialCifrada(clienteId) {
      return credenciales.get(clienteId) ?? null;
    },

    async notificacionesDe(clienteId) {
      return notificaciones
        .filter((n) => n.clienteId === clienteId)
        .sort((a, b) => b.fecha.localeCompare(a.fecha));
    },
    async marcarNotificacionVista(clienteId, notificacionId) {
      const notificacion = notificaciones.find(
        (candidata) => candidata.clienteId === clienteId && candidata.id === notificacionId,
      );
      if (!notificacion) return null;
      notificacion.vistaAppEn ??= new Date().toISOString();
      notificacion.estado = estadoNotificacion(notificacion.leida, notificacion.vistaAppEn);
      return notificacion;
    },
    async actualizarLecturaNotificacion(clienteId, notificacionId, leido) {
      const notificacion = notificaciones.find(
        (candidata) => candidata.clienteId === clienteId && candidata.id === notificacionId,
      );
      if (!notificacion) return null;
      notificacion.leidoAppEn = leido ? new Date().toISOString() : null;
      if (leido) {
        notificacion.vistaAppEn ??= notificacion.leidoAppEn;
        notificacion.estado = estadoNotificacion(notificacion.leida, notificacion.vistaAppEn);
      }
      return { leidoAppEn: notificacion.leidoAppEn };
    },
    async adjuntoNotificacionDe(clienteId, notificacionId, adjuntoId) {
      const notificacion = notificaciones.find(
        (candidata) => candidata.clienteId === clienteId && candidata.id === notificacionId,
      );
      if (!notificacion) return null;
      const adjunto = adjuntosNotificaciones.get(adjuntoId);
      if (!adjunto || adjunto.notificacionId !== notificacionId) return null;
      const { notificacionId: _notificacionId, ...salida } = adjunto;
      return salida;
    },
    async guardarNotificaciones(clienteId, nuevas) {
      let insertadas = 0;
      let actualizadas = 0;
      for (const nueva of nuevas) {
        const existente = notificaciones.find(
          (n) => n.clienteId === clienteId && n.idComunicacion === nueva.idComunicacion,
        );
        if (existente) {
          existente.fecha = nueva.fecha;
          existente.organismo = nueva.organismo;
          existente.asunto = nueva.asunto;
          existente.leida ||= nueva.leida;
          if (nueva.detalle) {
            existente.cuerpo = nueva.detalle.cuerpo;
            for (const [id, adjunto] of adjuntosNotificaciones) {
              if (adjunto.notificacionId === existente.id) adjuntosNotificaciones.delete(id);
            }
            existente.adjuntos = nueva.detalle.adjuntos.map((adjunto) => {
              const id = randomUUID();
              adjuntosNotificaciones.set(id, {
                id,
                notificacionId: existente.id,
                nombre: adjunto.nombre,
                mimeType: adjunto.mimeType,
                tamano: adjunto.tamano,
                contenido: adjunto.contenido,
              });
              return { id, nombre: adjunto.nombre, mimeType: adjunto.mimeType, tamano: adjunto.tamano };
            });
          }
          existente.estado = estadoNotificacion(existente.leida, existente.vistaAppEn);
          actualizadas += 1;
        } else {
          const id = randomUUID();
          const adjuntos = (nueva.detalle?.adjuntos ?? []).map((adjunto) => {
            const idAdjunto = randomUUID();
            adjuntosNotificaciones.set(idAdjunto, {
              id: idAdjunto,
              notificacionId: id,
              nombre: adjunto.nombre,
              mimeType: adjunto.mimeType,
              tamano: adjunto.tamano,
              contenido: adjunto.contenido,
            });
            return {
              id: idAdjunto,
              nombre: adjunto.nombre,
              mimeType: adjunto.mimeType,
              tamano: adjunto.tamano,
            };
          });
          notificaciones.push({
            id,
            clienteId,
            idComunicacion: nueva.idComunicacion,
            fecha: nueva.fecha,
            organismo: nueva.organismo,
            asunto: nueva.asunto,
            leida: nueva.leida,
            vistaAppEn: null,
            leidoAppEn: null,
            cuerpo: nueva.detalle?.cuerpo ?? null,
            adjuntos,
            estado: estadoNotificacion(nueva.leida, null),
          });
          insertadas += 1;
        }
      }
      return { insertadas, actualizadas };
    },
    async saldosDe(clienteId) {
      return saldos.filter((s) => s.clienteId === clienteId);
    },
    async reemplazarSaldos(clienteId, nuevos) {
      for (let i = saldos.length - 1; i >= 0; i -= 1) {
        if (saldos[i]?.clienteId === clienteId) saldos.splice(i, 1);
      }
      saldos.push(...nuevos.map((saldo) => ({ ...saldo, clienteId })));
      return nuevos.length;
    },
    async planesDe(clienteId) {
      return planes.filter((p) => p.clienteId === clienteId);
    },
    async actualizarLecturaPlan(clienteId, planId, leido) {
      const plan = planes.find(
        (candidato) => candidato.clienteId === clienteId && candidato.id === planId,
      );
      if (!plan) return null;
      plan.leidoAppEn = leido ? new Date().toISOString() : null;
      return { leidoAppEn: plan.leidoAppEn };
    },
    async vencimientosDe(clienteId) {
      return vencimientos
        .filter((v) => v.clienteId === clienteId)
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
    },
    async reemplazarVencimientos(clienteId, nuevos) {
      for (let i = vencimientos.length - 1; i >= 0; i -= 1) {
        if (vencimientos[i]?.clienteId === clienteId) vencimientos.splice(i, 1);
      }
      vencimientos.push(
        ...nuevos.map((vencimiento) => ({
          ...vencimiento,
          id: randomUUID(),
          clienteId,
        })),
      );
      return nuevos.length;
    },
    async ddjjPendientesDe(clienteId) {
      return ddjjPendientes
        .filter((declaracion) => declaracion.clienteId === clienteId)
        .sort((a, b) =>
          a.contribuyenteCuit.localeCompare(b.contribuyenteCuit) ||
          b.periodo.localeCompare(a.periodo),
        );
    },
    async reemplazarDdjjPendientes(clienteId, nuevas) {
      for (let i = ddjjPendientes.length - 1; i >= 0; i -= 1) {
        if (ddjjPendientes[i]?.clienteId === clienteId) ddjjPendientes.splice(i, 1);
      }
      ddjjPendientes.push(
        ...nuevas.map((declaracion) => ({
          ...declaracion,
          id: randomUUID(),
          clienteId,
        })),
      );
      return nuevas.length;
    },
    async comprobantesDe(clienteId) {
      return comprobantes
        .filter((c) => c.clienteId === clienteId)
        .sort((a, b) => b.fecha.localeCompare(a.fecha));
    },

    async guardarComprobantes(clienteId, nuevos) {
      // Espeja el UNIQUE de la tabla arca_comprobantes. Acá se hace en código
      // porque no hay motor; en SQL lo garantiza un constraint, que es lo
      // correcto — dos jobs concurrentes se pisarían igual.
      const clave = (c: {
        contribuyenteCuit: string;
        tipo: string;
        codigoComprobante: number;
        puntoVenta: number;
        numero: number;
      }) =>
        `${c.contribuyenteCuit}|${c.tipo}|${c.codigoComprobante}|${c.puntoVenta}|${c.numero}`;
      const existentes = new Set(
        comprobantes.filter((c) => c.clienteId === clienteId).map(clave),
      );

      let insertados = 0;
      for (const c of nuevos) {
        if (existentes.has(clave(c))) continue;
        existentes.add(clave(c));
        comprobantes.push({ ...c, id: randomUUID(), clienteId });
        insertados += 1;
      }
      return { insertados, repetidos: nuevos.length - insertados };
    },

    async reemplazarPlanes(clienteId, nuevos) {
      const lecturas = new Map(
        planes
          .filter((plan) => plan.clienteId === clienteId)
          .map((plan) => [plan.numero, plan.leidoAppEn] as const),
      );
      for (let i = planes.length - 1; i >= 0; i -= 1) {
        if (planes[i]?.clienteId === clienteId) planes.splice(i, 1);
      }
      let cuotas = 0;
      for (const nuevo of nuevos) {
        const id = randomUUID();
        const filas = nuevo.cuotas.map((cuota) => ({ ...cuota, id: randomUUID(), planId: id }));
        planes.push({
          ...nuevo,
          id,
          clienteId,
          leidoAppEn: lecturas.get(nuevo.numero) ?? null,
          cuotas: filas,
        });
        cuotas += filas.length;
      }
      return { planes: nuevos.length, cuotas };
    },

    async encolarSync(clienteId, modulo) {
      const activo = jobs.find(
        (j) =>
          j.clienteId === clienteId &&
          (j.modulo === modulo ||
            j.modulo === 'sincronizacion-completa' ||
            modulo === 'sincronizacion-completa') &&
          (j.estado === 'PENDING' || j.estado === 'RUNNING'),
      );
      if (activo) {
        const cliente = buscarCliente(clienteId);
        if (cliente) cliente.estadoSync = 'SINCRONIZANDO';
        return activo;
      }
      const job: SyncJob = {
        id: randomUUID(),
        clienteId,
        modulo,
        estado: 'PENDING',
        intentos: 0,
        creadoEn: new Date().toISOString(),
        progresoActual: 0,
        progresoTotal: modulo === 'sincronizacion-completa' ? 4 : 1,
        pasoActual: 'En cola',
      };
      jobs.push(job);
      const cliente = buscarCliente(clienteId);
      if (cliente) cliente.estadoSync = 'SINCRONIZANDO';
      return job;
    },
    async jobsDe(clienteId) {
      return jobs.filter((j) => j.clienteId === clienteId);
    },

    async actualizarProgresoJob(jobId, progreso, workerId) {
      const job = jobs.find((candidato) => candidato.id === jobId && candidato.estado === 'RUNNING');
      if (!job) throw new Error(`no se pudo actualizar el progreso del job ${jobId}`);
      if (workerId && propietariosJob.get(jobId) !== workerId) {
        throw new Error(`el worker ${workerId} no es propietario del job ${jobId}`);
      }
      job.progresoActual = progreso.actual;
      job.progresoTotal = progreso.total;
      job.pasoActual = progreso.paso;
    },

    async tomarProximoJob(workerId, ahoraIso, leaseHastaIso) {
      const job = jobs.find(
        (j) =>
          j.estado === 'PENDING' &&
          (!disponiblesDesde.has(j.id) || disponiblesDesde.get(j.id)! <= ahoraIso),
      );
      if (!job) return null;
      job.estado = 'RUNNING';
      job.intentos += 1;
      job.iniciadoEn = ahoraIso;
      job.pasoActual = 'Preparando acceso ARCA';
      propietariosJob.set(job.id, workerId);
      leasesJob.set(job.id, leaseHastaIso);
      disponiblesDesde.delete(job.id);
      // Verificar una solicitud de acceso no es sincronizar: la empresa no se
      // toca. Ver el mismo guard en sqlite.ts.
      if (!job.solicitudId) {
        const cliente = buscarCliente(job.clienteId);
        if (cliente) cliente.estadoSync = 'SINCRONIZANDO';
      }
      return job;
    },

    async adquirirBloqueoCuenta(jobId, workerId, claveCuenta, ahoraIso, leaseHastaIso) {
      for (const [clave, bloqueo] of bloqueosCuenta) {
        if (bloqueo.leaseHasta <= ahoraIso) bloqueosCuenta.delete(clave);
      }
      const job = jobs.find((candidato) => candidato.id === jobId && candidato.estado === 'RUNNING');
      if (!job || propietariosJob.get(jobId) !== workerId) return false;
      const existente = bloqueosCuenta.get(claveCuenta);
      if (existente) {
        if (existente.jobId !== jobId || existente.workerId !== workerId) return false;
        existente.leaseHasta = leaseHastaIso;
        return true;
      }
      bloqueosCuenta.set(claveCuenta, { jobId, workerId, leaseHasta: leaseHastaIso });
      return true;
    },

    async renovarLeaseJob(jobId, workerId, leaseHastaIso) {
      const job = jobs.find((candidato) => candidato.id === jobId && candidato.estado === 'RUNNING');
      if (!job || propietariosJob.get(jobId) !== workerId) return false;
      leasesJob.set(jobId, leaseHastaIso);
      for (const bloqueo of bloqueosCuenta.values()) {
        if (bloqueo.jobId === jobId && bloqueo.workerId === workerId) {
          bloqueo.leaseHasta = leaseHastaIso;
        }
      }
      return true;
    },

    async reencolarJob(jobId, workerId, disponibleDesdeIso, detalle) {
      const job = jobs.find((candidato) => candidato.id === jobId && candidato.estado === 'RUNNING');
      if (!job || propietariosJob.get(jobId) !== workerId) {
        throw new Error(`el worker ${workerId} no es propietario del job ${jobId}`);
      }
      liberarBloqueoDeJob(jobId);
      propietariosJob.delete(jobId);
      leasesJob.delete(jobId);
      disponiblesDesde.set(jobId, disponibleDesdeIso);
      job.estado = 'PENDING';
      job.pasoActual = detalle;
      const cliente = buscarCliente(job.clienteId);
      if (cliente) {
        cliente.estadoSync = 'SINCRONIZANDO';
        cliente.detalleSync = detalle;
      }
    },

    async recuperarJobsInterrumpidos(ahoraIso, antesDeIsoLegacy) {
      for (const [clave, bloqueo] of bloqueosCuenta) {
        if (bloqueo.leaseHasta <= ahoraIso) bloqueosCuenta.delete(clave);
      }
      let recuperados = 0;
      for (const job of jobs) {
        const lease = leasesJob.get(job.id);
        if (
          job.estado !== 'RUNNING' ||
          (lease
            ? lease > ahoraIso
            : (job.iniciadoEn ?? job.creadoEn).localeCompare(antesDeIsoLegacy) >= 0)
        ) {
          continue;
        }
        liberarBloqueoDeJob(job.id);
        propietariosJob.delete(job.id);
        leasesJob.delete(job.id);
        job.estado = 'ERROR';
        job.error = 'El worker se interrumpio antes de terminar el job.';
        job.pasoActual = 'Interrumpido';
        job.finalizadoEn = new Date().toISOString();
        const cliente = buscarCliente(job.clienteId);
        if (cliente?.estadoSync === 'SINCRONIZANDO') {
          cliente.estadoSync = 'ERROR';
          cliente.detalleSync = 'La sincronizacion anterior se interrumpio. Podes volver a encolarla.';
        }
        recuperados += 1;
      }
      return recuperados;
    },

    async clienteParaSync(clienteId) {
      return buscarCliente(clienteId);
    },

    async finalizarJob(jobId, resultado, workerId) {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) throw new Error(`job inexistente: ${jobId}`);
      if (job.estado !== 'RUNNING') throw new Error(`el job ${jobId} no esta RUNNING`);
      if (workerId && propietariosJob.get(jobId) !== workerId) {
        throw new Error(`el worker ${workerId} no es propietario del job ${jobId}`);
      }
      liberarBloqueoDeJob(jobId);
      propietariosJob.delete(jobId);
      leasesJob.delete(jobId);
      job.estado = resultado.estado;
      job.finalizadoEn = new Date().toISOString();
      if (resultado.estado === 'DONE') {
        job.progresoActual = job.progresoTotal;
        job.pasoActual = 'Completado';
      }
      if (resultado.detalle) job.error = resultado.detalle;
      else delete job.error;

      // Un job de verificación resuelve su solicitud y NO toca al cliente: una
      // clave equivocada de quien pide acceso no puede marcar como inválida la
      // credencial de la oficina que ya tenía la empresa.
      if (job.solicitudId) {
        const solicitud = solicitudes.find((s) => s.id === job.solicitudId);
        if (solicitud && solicitud.estado === 'PENDIENTE') {
          solicitud.estado = resultado.estado === 'DONE' ? 'APROBADA' : 'RECHAZADA';
          solicitud.resueltoEn = new Date().toISOString();
          if (resultado.detalle) solicitud.detalle = resultado.detalle;
          if (solicitud.estado === 'APROBADA') {
            const asignados = asignaciones.get(solicitud.usuarioId) ?? new Set<string>();
            asignaciones.set(solicitud.usuarioId, asignados);
            asignados.add(solicitud.clienteId);
          }
        }
        // La credencial adjunta es de un solo uso.
        credencialesSolicitud.delete(job.solicitudId);
        return;
      }

      const cliente = buscarCliente(job.clienteId);
      if (!cliente) throw new Error(`cliente inexistente: ${job.clienteId}`);
      cliente.estadoSync =
        resultado.estado === 'DONE'
          ? 'OK'
          : resultado.estado === 'NEEDS_HUMAN'
            ? 'NECESITA_HUMANO'
            : 'ERROR';
      cliente.ultimoSync = new Date().toISOString();
      if (resultado.detalle) cliente.detalleSync = resultado.detalle;
      else delete cliente.detalleSync;
      if (resultado.estadoCredencial) cliente.estadoCredencial = resultado.estadoCredencial;
    },
  };
}
