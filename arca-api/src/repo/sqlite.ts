import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Cliente,
  Comprobante,
  CuotaPlan,
  DeclaracionJuradaPendiente,
  EmpresaRepresentada,
  EstadoCredencial,
  EstadoJob,
  EstadoSync,
  Notificacion,
  NotificacionAdjunto,
  PlanPago,
  Rol,
  SaldoTributario,
  SolicitudAcceso,
  SyncJob,
  UsuarioConHash,
  UsuarioGestion,
  Vencimiento,
} from '../dominio/tipos.js';
import { estadoNotificacion } from '../dominio/notificaciones.js';
import { formatearCuit } from '../dominio/cuit.js';
import type { Repositorio } from './tipos.js';
import { prepararEsquemaSqlite } from './migraciones.js';

/**
 * Repositorio sobre SQLite, usando el `node:sqlite` que viene en Node 24.
 *
 * Es una base LOCAL para desarrollo, no la de producción: ahí va Azure SQL.
 * El esquema (`esquema.sql`) está escrito para mapear 1:1 a T-SQL, así que la
 * implementación `mssql.ts` va a ser las mismas queries con otros tipos y otra
 * sintaxis de parámetros.
 *
 * Lo que sí prueba de verdad: que la interfaz `Repositorio` funciona contra una
 * base relacional, que el aislamiento multi-tenant se puede expresar en SQL, y
 * que la unicidad que hace idempotente el sync la garantiza la base.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));

type FilaUsuario = {
  id: string;
  email: string;
  nombre: string;
  rol: string;
  password_hash: string;
  activo: number;
  limite_clientes: number | null;
};

function aUsuarioConHash(f: FilaUsuario): UsuarioConHash {
  return {
    id: f.id,
    email: f.email,
    nombre: f.nombre,
    rol: f.rol as Rol,
    activo: f.activo === 1,
    limiteClientes: f.limite_clientes,
    passwordHash: f.password_hash,
  };
}

type FilaCliente = {
  id: string;
  cuit: string;
  razon_social: string;
  estado_credencial: string;
  estado_sync: string;
  ultimo_sync: string | null;
  detalle_sync: string | null;
  credencial_cargada_en: string | null;
};

function aCliente(f: FilaCliente): Cliente {
  const cliente: Cliente = {
    id: f.id,
    cuit: f.cuit,
    razonSocial: f.razon_social,
    estadoCredencial: f.estado_credencial as EstadoCredencial,
    estadoSync: f.estado_sync as EstadoSync,
    ultimoSync: f.ultimo_sync,
    credencialCargadaEn: f.credencial_cargada_en,
  };
  if (f.detalle_sync) cliente.detalleSync = f.detalle_sync;
  return cliente;
}

export interface OpcionesSqlite {
  /** Ruta del archivo, o ':memory:' para una base efímera (tests). */
  archivo: string;
  /** Carga datos de demostración si la base está vacía. */
  sembrar?: boolean;
}

export function crearRepositorioSqlite(opciones: OpcionesSqlite): Repositorio & {
  cerrar: () => void;
} {
  const db = new DatabaseSync(opciones.archivo);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  prepararEsquemaSqlite(db, readFileSync(join(AQUI, 'esquema.sql'), 'utf8'));

  if (opciones.sembrar !== false) sembrarSiVacia(db);

  const todos = <T>(sql: string, ...args: unknown[]): T[] =>
    db.prepare(sql).all(...(args as never[])) as T[];
  const uno = <T>(sql: string, ...args: unknown[]): T | null =>
    (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null;
  const correr = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[]));

  /**
   * Toda lectura de un cliente pasa por este JOIN con arca_user_clientes.
   * Es el aislamiento multi-tenant expresado en SQL: sin fila de asignación,
   * el cliente sencillamente no aparece.
   */
  const SELECT_CLIENTE_DE = `
    SELECT c.* FROM arca_clientes c
    JOIN arca_user_clientes uc ON uc.cliente_id = c.id
    WHERE uc.usuario_id = ?`;

  /**
   * Forma canonica del CUIT de un contribuyente EN LA BASE: con guiones.
   *
   * No es cosmetica. Las cuatro tablas viejas ya guardaban asi, y escribir
   * `30712011196` en unas y `30-71201119-6` en otras hace que el filtro por
   * empresa no matchee nada: el panel lista la empresa y al entrar aparece
   * vacia. Peor todavia, deja tablas con los dos formatos mezclados, donde
   * cualquier filtro devuelve una parte.
   *
   * El repositorio es la capa que tiene que garantizarlo — es su contrato de
   * persistencia, y depender de que cada llamador formatee igual es depender
   * de que nadie se olvide.
   */
  const canonico = (cuit: string): string => formatearCuit(cuit);

  /**
   * Acota una lectura a UNA de las empresas de la cuenta.
   *
   * Sin CUIT devuelve lo de la cuenta entera, que es lo que veia el detalle
   * hasta ahora: la mezcla de todos los representados.
   */
  const filtroEmpresa = (cuit?: string) => (cuit ? ' AND contribuyente_cuit = ?' : '');
  const argsEmpresa = (clienteId: string, cuit?: string) =>
    cuit ? [clienteId, canonico(cuit)] : [clienteId];

  /**
   * Las filas del panel: una por (cuenta, empresa).
   *
   * La razon social sale del cache del padron y cae al CUIT si todavia no se
   * resolvio — mostrar el numero es peor que mostrar nada, pero mucho mejor que
   * esconder la empresa.
   */
  const leerEmpresas = (donde: string, parametro: string): EmpresaRepresentada[] =>
    todos<{
      cliente_id: string;
      cuit: string;
      visto_en: string;
      nombre: string | null;
      cliente_cuit: string;
      cliente_razon: string;
    }>(
      `SELECT r.cliente_id, r.cuit, r.visto_en,
              p.nombre        AS nombre,
              c.cuit          AS cliente_cuit,
              c.razon_social  AS cliente_razon
         FROM arca_representados r
         JOIN arca_clientes c ON c.id = r.cliente_id
         -- El cache del padron guarda el CUIT en digitos y los representados
         -- con guiones. Sin normalizar, el JOIN no matchea nunca y toda
         -- empresa se muestra con su numero en vez de su razon social.
         LEFT JOIN arca_contribuyentes p ON p.cuit = REPLACE(r.cuit, '-', '')
         ${donde}
        ORDER BY c.razon_social, p.nombre, r.cuit`,
      parametro,
    ).map<EmpresaRepresentada>((f) => ({
      clienteId: f.cliente_id,
      cuit: f.cuit,
      nombre: f.nombre ?? f.cuit,
      nombreCargado: f.nombre !== null,
      representante: { cuit: f.cliente_cuit, razonSocial: f.cliente_razon },
      // Comparado en digitos: los dos vienen de la base pero de tablas que
      // podrian formatear distinto, y esto no debe depender de eso.
      esTitular: f.cuit.replace(/\D/g, '') === f.cliente_cuit.replace(/\D/g, ''),
      vistoEn: f.visto_en,
    }));

  type FilaNotificacion = {
    id: string;
    cliente_id: string;
    contribuyente_cuit: string;
    id_comunicacion: string;
    fecha: string;
    organismo: string;
    asunto: string;
    leida: number;
    vista_app_en: string | null;
    leido_app_en: string | null;
    cuerpo: string | null;
  };
  type FilaAdjunto = {
    id: string;
    notificacion_id: string;
    nombre: string;
    mime_type: string;
    tamano: number;
  };

  const leerNotificaciones = (
    clienteId: string,
    notificacionId?: string,
    contribuyenteCuit?: string,
  ): Notificacion[] => {
    const filtroId = notificacionId ? ' AND id = ?' : '';
    const filtroCuit = contribuyenteCuit ? ' AND contribuyente_cuit = ?' : '';
    const args: string[] = [clienteId];
    if (notificacionId) args.push(notificacionId);
    if (contribuyenteCuit) args.push(canonico(contribuyenteCuit));
    const filas = todos<FilaNotificacion>(
      `SELECT * FROM arca_notificaciones
        WHERE cliente_id = ?${filtroId}${filtroCuit}
        ORDER BY fecha DESC`,
      ...args,
    );
    if (filas.length === 0) return [];

    const filtroAdjuntoId = notificacionId ? ' AND n.id = ?' : '';
    // Los MISMOS filtros y en el mismo orden que la consulta de arriba, porque
    // comparte `args`. Al sumar el filtro por empresa alla y no aca, esta
    // recibia un parametro de mas y fallaba con "column index out of range" —
    // y como el detalle entero se arma con esto, la pantalla quedaba en 404.
    const filtroCuitAdjunto = contribuyenteCuit ? ' AND n.contribuyente_cuit = ?' : '';
    const adjuntos = todos<FilaAdjunto>(
      `SELECT a.id, a.notificacion_id, a.nombre, a.mime_type, a.tamano
         FROM arca_notificacion_adjuntos a
         JOIN arca_notificaciones n ON n.id = a.notificacion_id
        WHERE n.cliente_id = ?${filtroAdjuntoId}${filtroCuitAdjunto}
        ORDER BY a.nombre`,
      ...args,
    );
    const adjuntosPorNotificacion = new Map<string, NotificacionAdjunto[]>();
    for (const adjunto of adjuntos) {
      const lista = adjuntosPorNotificacion.get(adjunto.notificacion_id) ?? [];
      lista.push({
        id: adjunto.id,
        nombre: adjunto.nombre,
        mimeType: adjunto.mime_type,
        tamano: adjunto.tamano,
      });
      adjuntosPorNotificacion.set(adjunto.notificacion_id, lista);
    }

    return filas.map((fila) => {
      const leida = fila.leida === 1;
      return {
        id: fila.id,
        clienteId: fila.cliente_id,
        contribuyenteCuit: fila.contribuyente_cuit,
        idComunicacion: fila.id_comunicacion,
        fecha: fila.fecha,
        organismo: fila.organismo,
        asunto: fila.asunto,
        leida,
        vistaAppEn: fila.vista_app_en,
        leidoAppEn: fila.leido_app_en,
        cuerpo: fila.cuerpo,
        adjuntos: adjuntosPorNotificacion.get(fila.id) ?? [],
        estado: estadoNotificacion(leida, fila.vista_app_en),
      };
    });
  };

  return {
    cerrar: () => db.close(),

    async buscarUsuarioPorEmail(email) {
      const f = uno<FilaUsuario>(
        'SELECT * FROM arca_users WHERE lower(email) = lower(?) AND activo = 1',
        email,
      );
      return f ? aUsuarioConHash(f) : null;
    },

    async buscarUsuarioPorId(id) {
      const f = uno<FilaUsuario>('SELECT * FROM arca_users WHERE id = ? AND activo = 1', id);
      return f ? aUsuarioConHash(f) : null;
    },

    async listarUsuarios() {
      return todos<FilaUsuario & { clientes_asignados: number }>(
        `SELECT u.*, COUNT(uc.cliente_id) AS clientes_asignados
           FROM arca_users u
           LEFT JOIN arca_user_clientes uc ON uc.usuario_id = u.id
          GROUP BY u.id
          ORDER BY CASE WHEN u.rol = 'admin' THEN 0 ELSE 1 END, lower(u.nombre)`,
      ).map<UsuarioGestion>((f) => ({
        id: f.id,
        email: f.email,
        nombre: f.nombre,
        rol: f.rol as Rol,
        activo: f.activo === 1,
        limiteClientes: f.limite_clientes,
        clientesAsignados: f.clientes_asignados,
      }));
    },

    async existeEmailUsuario(email) {
      return uno('SELECT 1 AS x FROM arca_users WHERE lower(email) = lower(?)', email) !== null;
    },

    async crearAdminInicial(datos) {
      // BEGIN IMMEDIATE y no dos consultas sueltas: el chequeo de "no hay
      // usuarios" y el alta tienen que ser indivisibles. Con la API y N workers
      // sobre el mismo archivo, dos arranques simultáneos podrían ver la tabla
      // vacía los dos y crear dos administradores.
      db.exec('BEGIN IMMEDIATE');
      try {
        const hay = uno<{ n: number }>('SELECT COUNT(*) AS n FROM arca_users');
        if (!hay || hay.n > 0) {
          db.exec('COMMIT');
          return null;
        }
        const id = randomUUID();
        correr(
          `INSERT INTO arca_users
             (id, email, nombre, rol, password_hash, activo, limite_clientes)
           VALUES (?, ?, ?, 'admin', ?, 1, NULL)`,
          id,
          datos.email,
          datos.nombre,
          datos.passwordHash,
        );
        db.exec('COMMIT');
        return {
          id,
          email: datos.email,
          nombre: datos.nombre,
          rol: 'admin',
          activo: true,
          limiteClientes: null,
          clientesAsignados: 0,
        };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async crearUsuario(datos) {
      const id = randomUUID();
      correr(
        `INSERT INTO arca_users
           (id, email, nombre, rol, password_hash, activo, limite_clientes)
         VALUES (?, ?, ?, 'user', ?, 1, ?)`,
        id,
        datos.email,
        datos.nombre,
        datos.passwordHash,
        datos.limiteClientes,
      );
      return {
        id,
        email: datos.email,
        nombre: datos.nombre,
        rol: 'user',
        activo: true,
        limiteClientes: datos.limiteClientes,
        clientesAsignados: 0,
      };
    },

    async actualizarUsuario(usuarioId, cambios) {
      const actual = uno<FilaUsuario>('SELECT * FROM arca_users WHERE id = ?', usuarioId);
      if (!actual) return null;
      correr(
        `UPDATE arca_users
            SET nombre = ?, password_hash = ?, activo = ?, limite_clientes = ?
          WHERE id = ?`,
        cambios.nombre ?? actual.nombre,
        cambios.passwordHash ?? actual.password_hash,
        cambios.activo === undefined ? actual.activo : cambios.activo ? 1 : 0,
        cambios.limiteClientes ?? actual.limite_clientes,
        usuarioId,
      );
      const [gestion] = todos<FilaUsuario & { clientes_asignados: number }>(
        `SELECT u.*, COUNT(uc.cliente_id) AS clientes_asignados
           FROM arca_users u
           LEFT JOIN arca_user_clientes uc ON uc.usuario_id = u.id
          WHERE u.id = ?
          GROUP BY u.id`,
        usuarioId,
      );
      return gestion
        ? {
            id: gestion.id,
            email: gestion.email,
            nombre: gestion.nombre,
            rol: gestion.rol as Rol,
            activo: gestion.activo === 1,
            limiteClientes: gestion.limite_clientes,
            clientesAsignados: gestion.clientes_asignados,
          }
        : null;
    },

    async cambiarRolUsuario(usuarioId, cambio) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const actual = uno<FilaUsuario>('SELECT * FROM arca_users WHERE id = ?', usuarioId);
        if (!actual) {
          db.exec('ROLLBACK');
          return { ok: false, motivo: 'NO_EXISTE' };
        }

        // El COUNT va dentro de la transacción a propósito: ver arriba, en el
        // contrato. Es la unica barrera contra quedarse sin ningun admin.
        if (cambio.rol === 'user' && actual.rol === 'admin') {
          const admins =
            uno<{ n: number }>(`SELECT COUNT(*) AS n FROM arca_users WHERE rol = 'admin'`)?.n ?? 0;
          if (admins <= 1) {
            db.exec('ROLLBACK');
            return { ok: false, motivo: 'ULTIMO_ADMIN' };
          }
        }

        correr(
          'UPDATE arca_users SET rol = ?, limite_clientes = ? WHERE id = ?',
          cambio.rol,
          cambio.rol === 'admin' ? null : cambio.limiteClientes,
          usuarioId,
        );
        const [gestion] = todos<FilaUsuario & { clientes_asignados: number }>(
          `SELECT u.*, COUNT(uc.cliente_id) AS clientes_asignados
             FROM arca_users u
             LEFT JOIN arca_user_clientes uc ON uc.usuario_id = u.id
            WHERE u.id = ?
            GROUP BY u.id`,
          usuarioId,
        );
        db.exec('COMMIT');
        return gestion
          ? {
              ok: true,
              usuario: {
                id: gestion.id,
                email: gestion.email,
                nombre: gestion.nombre,
                rol: gestion.rol as Rol,
                activo: gestion.activo === 1,
                limiteClientes: gestion.limite_clientes,
                clientesAsignados: gestion.clientes_asignados,
              },
            }
          : { ok: false, motivo: 'NO_EXISTE' };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async cantidadClientesDe(usuarioId) {
      return uno<{ n: number }>(
        'SELECT COUNT(*) AS n FROM arca_user_clientes WHERE usuario_id = ?',
        usuarioId,
      )?.n ?? 0;
    },

    async listarClientesDe(usuarioId) {
      return todos<FilaCliente>(`${SELECT_CLIENTE_DE} ORDER BY c.razon_social`, usuarioId).map(
        aCliente,
      );
    },

    async obtenerClienteDe(usuarioId, clienteId) {
      const f = uno<FilaCliente>(`${SELECT_CLIENTE_DE} AND c.id = ?`, usuarioId, clienteId);
      return f ? aCliente(f) : null;
    },

    async existeCuit(cuit) {
      return uno('SELECT 1 AS x FROM arca_clientes WHERE cuit = ?', cuit) !== null;
    },

    async crearCliente(datos, usuarioId) {
      const id = randomUUID();
      correr(
        `INSERT INTO arca_clientes
           (id, cuit, razon_social, estado_credencial, estado_sync, detalle_sync)
         VALUES (?, ?, ?, 'SIN_CARGAR', 'NUNCA', ?)`,
        id,
        datos.cuit,
        datos.razonSocial,
        'Falta cargar la clave fiscal del cliente.',
      );
      // Quien lo crea queda con acceso; si no, lo perdería de vista al instante.
      correr('INSERT INTO arca_user_clientes (usuario_id, cliente_id) VALUES (?, ?)', usuarioId, id);
      const f = uno<FilaCliente>('SELECT * FROM arca_clientes WHERE id = ?', id);
      if (!f) throw new Error('no se pudo crear el cliente');
      return aCliente(f);
    },

    async clientesParaSyncAutomatica(anteriorAIso) {
      return todos<FilaCliente>(
        `SELECT * FROM arca_clientes
          WHERE estado_credencial = 'OK'
            AND (ultimo_sync IS NULL OR ultimo_sync < ?)
          ORDER BY COALESCE(ultimo_sync, '') , razon_social`,
        anteriorAIso,
      ).map(aCliente);
    },

    async nombresDeContribuyentes(cuits) {
      const digitos = [...new Set(cuits.map((cuit) => cuit.replace(/\D/g, '')))].filter(
        (cuit) => cuit.length === 11,
      );
      if (digitos.length === 0) return {};
      const huecos = digitos.map(() => '?').join(',');

      // Los clientes primero: si el CUIT ya es un cliente del panel, su razón
      // social es la fuente de verdad y no hay que cargar nada a mano.
      const resuelto: Record<string, string> = {};
      for (const fila of todos<{ cuit: string; razon_social: string }>(
        `SELECT cuit, razon_social FROM arca_clientes
          WHERE REPLACE(REPLACE(cuit, '-', ''), ' ', '') IN (${huecos})`,
        ...digitos,
      )) {
        resuelto[fila.cuit.replace(/\D/g, '')] = fila.razon_social;
      }

      for (const fila of todos<{ cuit: string; nombre: string }>(
        `SELECT cuit, nombre FROM arca_contribuyentes WHERE cuit IN (${huecos})`,
        ...digitos,
      )) {
        if (!resuelto[fila.cuit]) resuelto[fila.cuit] = fila.nombre;
      }
      return resuelto;
    },

    async guardarNombreContribuyente(cuit, nombre) {
      correr(
        `INSERT INTO arca_contribuyentes (cuit, nombre, actualizado_en)
         VALUES (?, ?, ?)
         ON CONFLICT(cuit) DO UPDATE SET nombre = excluded.nombre,
                                         actualizado_en = excluded.actualizado_en`,
        cuit.replace(/\D/g, ''),
        nombre,
        new Date().toISOString(),
      );
    },

    async asignarClienteA(usuarioId, clienteId) {
      // En transacción para que el chequeo de existencia y el alta de la
      // asignación no se separen: el PRIMARY KEY de arca_user_clientes ya
      // impide el duplicado, pero así el llamador recibe YA_ASIGNADO en vez de
      // un error de constraint.
      db.exec('BEGIN IMMEDIATE');
      try {
        const existe = uno<{ id: string }>(
          'SELECT id FROM arca_clientes WHERE id = ?',
          clienteId,
        );
        if (!existe) {
          db.exec('COMMIT');
          return 'CLIENTE_INEXISTENTE';
        }
        const yaAsignado = uno<{ cliente_id: string }>(
          'SELECT cliente_id FROM arca_user_clientes WHERE usuario_id = ? AND cliente_id = ?',
          usuarioId,
          clienteId,
        );
        if (yaAsignado) {
          db.exec('COMMIT');
          return 'YA_ASIGNADO';
        }
        correr(
          'INSERT INTO arca_user_clientes (usuario_id, cliente_id) VALUES (?, ?)',
          usuarioId,
          clienteId,
        );
        db.exec('COMMIT');
        return 'ASIGNADO';
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async solicitarAcceso(usuarioId, cuit, cifrada) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const cliente = uno<{ id: string; cuit: string; razon_social: string }>(
          'SELECT id, cuit, razon_social FROM arca_clientes WHERE cuit = ?',
          cuit,
        );
        if (!cliente) {
          db.exec('COMMIT');
          return { estado: 'CLIENTE_INEXISTENTE' as const };
        }

        const yaAsignado = uno(
          'SELECT 1 AS x FROM arca_user_clientes WHERE usuario_id = ? AND cliente_id = ?',
          usuarioId,
          cliente.id,
        );
        if (yaAsignado) {
          db.exec('COMMIT');
          return { estado: 'YA_ASIGNADO' as const };
        }

        const pendiente = uno<FilaSolicitud>(
          `SELECT s.*, c.cuit, c.razon_social
             FROM arca_solicitudes_acceso s
             JOIN arca_clientes c ON c.id = s.cliente_id
            WHERE s.usuario_id = ? AND s.cliente_id = ? AND s.estado = 'PENDIENTE'`,
          usuarioId,
          cliente.id,
        );
        if (pendiente) {
          db.exec('COMMIT');
          return { estado: 'YA_PENDIENTE' as const, solicitud: aSolicitud(pendiente) };
        }

        const id = randomUUID();
        const creadoEn = new Date().toISOString();
        correr(
          `INSERT INTO arca_solicitudes_acceso
             (id, cliente_id, usuario_id, estado, creado_en,
              ciphertext, iv, auth_tag, dek_envuelta, dek_iv, dek_auth_tag)
           VALUES (?, ?, ?, 'PENDIENTE', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          cliente.id,
          usuarioId,
          creadoEn,
          cifrada.ciphertext,
          cifrada.iv,
          cifrada.authTag,
          cifrada.dekEnvuelta,
          cifrada.dekIv,
          cifrada.dekAuthTag,
        );

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
          solicitudId: id,
        };
        correr(
          `INSERT INTO arca_sync_jobs
             (id, cliente_id, modulo, estado, intentos, creado_en,
              progreso_actual, progreso_total, paso_actual, solicitud_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          job.id,
          job.clienteId,
          job.modulo,
          job.estado,
          job.intentos,
          job.creadoEn,
          job.progresoActual,
          job.progresoTotal,
          job.pasoActual,
          id,
        );
        // A diferencia de `encolarSync`, el cliente NO pasa a SINCRONIZANDO:
        // esta empresa es de otra oficina y su tablero no tiene por qué
        // moverse porque un tercero esté pidiendo acceso.
        db.exec('COMMIT');
        return {
          estado: 'ENCOLADA' as const,
          solicitud: {
            id,
            clienteId: cliente.id,
            cuit: cliente.cuit,
            razonSocial: cliente.razon_social,
            estado: 'PENDIENTE' as const,
            creadoEn,
          },
          job,
        };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async solicitudesDe(usuarioId) {
      return todos<FilaSolicitud>(
        `SELECT s.*, c.cuit, c.razon_social
           FROM arca_solicitudes_acceso s
           JOIN arca_clientes c ON c.id = s.cliente_id
          WHERE s.usuario_id = ?
          ORDER BY s.creado_en DESC`,
        usuarioId,
      ).map(aSolicitud);
    },

    async solicitudParaVerificar(solicitudId) {
      const f = uno<{
        id: string;
        cliente_id: string;
        cuit: string;
        ciphertext: string | null;
        iv: string | null;
        auth_tag: string | null;
        dek_envuelta: string | null;
        dek_iv: string | null;
        dek_auth_tag: string | null;
      }>(
        `SELECT s.id, s.cliente_id, c.cuit,
                s.ciphertext, s.iv, s.auth_tag, s.dek_envuelta, s.dek_iv, s.dek_auth_tag
           FROM arca_solicitudes_acceso s
           JOIN arca_clientes c ON c.id = s.cliente_id
          WHERE s.id = ? AND s.estado = 'PENDIENTE'`,
        solicitudId,
      );
      if (
        !f ||
        f.ciphertext === null ||
        f.iv === null ||
        f.auth_tag === null ||
        f.dek_envuelta === null ||
        f.dek_iv === null ||
        f.dek_auth_tag === null
      ) {
        return null;
      }
      return {
        id: f.id,
        clienteId: f.cliente_id,
        cuit: f.cuit,
        cifrada: {
          ciphertext: f.ciphertext,
          iv: f.iv,
          authTag: f.auth_tag,
          dekEnvuelta: f.dek_envuelta,
          dekIv: f.dek_iv,
          dekAuthTag: f.dek_auth_tag,
        },
      };
    },

    async renombrarClienteDe(usuarioId, clienteId, razonSocial) {
      // El EXISTS contra arca_user_clientes es el mismo aislamiento que el
      // resto del repositorio, y va DENTRO del UPDATE a proposito: chequear
      // aparte y despues escribir deja una ventana entre las dos consultas.
      const r = correr(
        `UPDATE arca_clientes
            SET razon_social = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM arca_user_clientes
               WHERE usuario_id = ? AND cliente_id = arca_clientes.id
            )`,
        razonSocial,
        clienteId,
        usuarioId,
      );
      if (Number(r.changes) === 0) return null;
      const f = uno<FilaCliente>(`${SELECT_CLIENTE_DE} AND c.id = ?`, usuarioId, clienteId);
      return f ? aCliente(f) : null;
    },

    async eliminarClienteDe(usuarioId, clienteId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        correr(
          'DELETE FROM arca_user_clientes WHERE usuario_id = ? AND cliente_id = ?',
          usuarioId,
          clienteId,
        );
        const asignacionesRestantes = uno<{ n: number }>(
          'SELECT COUNT(*) AS n FROM arca_user_clientes WHERE cliente_id = ?',
          clienteId,
        )?.n ?? 0;
        if (asignacionesRestantes === 0) {
          // Credenciales y datos fiscales caen por ON DELETE CASCADE.
          correr('DELETE FROM arca_clientes WHERE id = ?', clienteId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async guardarCredencial(clienteId, c) {
      const ahora = new Date().toISOString();
      correr(
        `INSERT INTO arca_credenciales
           (cliente_id, ciphertext, iv, auth_tag, dek_envuelta, dek_iv, dek_auth_tag, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cliente_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           dek_envuelta = excluded.dek_envuelta,
           dek_iv = excluded.dek_iv,
           dek_auth_tag = excluded.dek_auth_tag,
           actualizado_en = excluded.actualizado_en`,
        clienteId,
        c.ciphertext,
        c.iv,
        c.authTag,
        c.dekEnvuelta,
        c.dekIv,
        c.dekAuthTag,
        ahora,
      );
      correr(
        `UPDATE arca_clientes
            SET credencial_cargada_en = ?,
                estado_credencial = 'OK',
                estado_sync = CASE WHEN ultimo_sync IS NULL THEN 'NUNCA' ELSE 'OK' END,
                detalle_sync = NULL
          WHERE id = ?`,
        ahora,
        clienteId,
      );
      const f = uno<FilaCliente>('SELECT * FROM arca_clientes WHERE id = ?', clienteId);
      if (!f) throw new Error('cliente inexistente');
      return aCliente(f);
    },

    async leerCredencialCifrada(clienteId) {
      const f = uno<{
        ciphertext: string;
        iv: string;
        auth_tag: string;
        dek_envuelta: string;
        dek_iv: string;
        dek_auth_tag: string;
      }>('SELECT * FROM arca_credenciales WHERE cliente_id = ?', clienteId);
      return f
        ? {
            ciphertext: f.ciphertext,
            iv: f.iv,
            authTag: f.auth_tag,
            dekEnvuelta: f.dek_envuelta,
            dekIv: f.dek_iv,
            dekAuthTag: f.dek_auth_tag,
          }
        : null;
    },

    async empresasDe(clienteId) {
      return leerEmpresas('WHERE r.cliente_id = ?', clienteId);
    },

    async empresasDeUsuario(usuarioId) {
      // El JOIN con arca_user_clientes es el mismo aislamiento que el resto del
      // repositorio: no hay forma de listar empresas de una cuenta ajena.
      return leerEmpresas(
        `WHERE r.cliente_id IN (SELECT cliente_id FROM arca_user_clientes WHERE usuario_id = ?)`,
        usuarioId,
      );
    },

    async registrarRepresentados(clienteId, servicio, cuits) {
      const ahora = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const cuit of cuits) {
          const digitos = cuit.replace(/\D/g, '');
          if (digitos.length !== 11) continue;
          const guardado = canonico(digitos);
          // Acumulativo: cada servicio ve su propia lista de delegaciones, y
          // borrar las que este no ofrece haria desaparecer del panel empresas
          // que si existen en otro. Solo se pisa `visto_en`.
          correr(
            `INSERT INTO arca_representados (cliente_id, cuit, visto_en, actualizado_en)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (cliente_id, cuit) DO UPDATE
                SET visto_en = excluded.visto_en,
                    actualizado_en = excluded.actualizado_en`,
            clienteId,
            guardado,
            servicio,
            ahora,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async notificacionesDe(clienteId, contribuyenteCuit) {
      return leerNotificaciones(clienteId, undefined, contribuyenteCuit);
    },

    async marcarNotificacionVista(clienteId, notificacionId) {
      correr(
        `UPDATE arca_notificaciones
            SET vista_app_en = COALESCE(vista_app_en, ?)
          WHERE cliente_id = ? AND id = ?`,
        new Date().toISOString(),
        clienteId,
        notificacionId,
      );
      return leerNotificaciones(clienteId, notificacionId)[0] ?? null;
    },

    async actualizarLecturaNotificacion(clienteId, notificacionId, leido) {
      const leidoAppEn = leido ? new Date().toISOString() : null;
      const resultado = correr(
        `UPDATE arca_notificaciones
            SET leido_app_en = ?,
                vista_app_en = CASE
                  WHEN ? IS NOT NULL THEN COALESCE(vista_app_en, ?)
                  ELSE vista_app_en
                END
          WHERE cliente_id = ? AND id = ?`,
        leidoAppEn,
        leidoAppEn,
        leidoAppEn,
        clienteId,
        notificacionId,
      );
      return Number(resultado.changes) > 0 ? { leidoAppEn } : null;
    },

    async adjuntoNotificacionDe(clienteId, notificacionId, adjuntoId) {
      const fila = uno<{
        id: string;
        nombre: string;
        mime_type: string;
        tamano: number;
        contenido: Uint8Array;
      }>(
        `SELECT a.id, a.nombre, a.mime_type, a.tamano, a.contenido
           FROM arca_notificacion_adjuntos a
           JOIN arca_notificaciones n ON n.id = a.notificacion_id
          WHERE n.cliente_id = ? AND n.id = ? AND a.id = ?`,
        clienteId,
        notificacionId,
        adjuntoId,
      );
      return fila
        ? {
            id: fila.id,
            nombre: fila.nombre,
            mimeType: fila.mime_type,
            tamano: fila.tamano,
            contenido: fila.contenido,
          }
        : null;
    },

    async guardarNotificaciones(clienteId, notificaciones) {
      // La clave lleva el contribuyente: el id de comunicacion solo es unico
      // dentro de su buzon, y sin el CUIT dos empresas de la misma cuenta se
      // pisarian entre si al contar insertadas contra actualizadas.
      const clave = (cuit: string, idComunicacion: string) => `${cuit} ${idComunicacion}`;
      const existentes = new Set(
        todos<{ contribuyente_cuit: string; id_comunicacion: string }>(
          'SELECT contribuyente_cuit, id_comunicacion FROM arca_notificaciones WHERE cliente_id = ?',
          clienteId,
        ).map((fila) => clave(fila.contribuyente_cuit, fila.id_comunicacion)),
      );
      const guardarSinDetalle = db.prepare(
        `INSERT INTO arca_notificaciones
           (id, cliente_id, contribuyente_cuit, id_comunicacion, fecha, organismo, asunto, leida)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cliente_id, contribuyente_cuit, id_comunicacion) DO UPDATE SET
           fecha = excluded.fecha,
           organismo = excluded.organismo,
           asunto = excluded.asunto,
           leida = MAX(arca_notificaciones.leida, excluded.leida)`,
      );
      const guardarConDetalle = db.prepare(
        `INSERT INTO arca_notificaciones
           (id, cliente_id, contribuyente_cuit, id_comunicacion, fecha, organismo, asunto, leida, cuerpo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cliente_id, contribuyente_cuit, id_comunicacion) DO UPDATE SET
           fecha = excluded.fecha,
           organismo = excluded.organismo,
           asunto = excluded.asunto,
           leida = MAX(arca_notificaciones.leida, excluded.leida),
           cuerpo = excluded.cuerpo`,
      );
      // Con el CUIT: sin el, los adjuntos podrian colgarse de la comunicacion
      // homonima de OTRA empresa de la misma cuenta.
      const idNotificacion = db.prepare(
        `SELECT id FROM arca_notificaciones
          WHERE cliente_id = ? AND contribuyente_cuit = ? AND id_comunicacion = ?`,
      );
      const borrarAdjuntos = db.prepare(
        'DELETE FROM arca_notificacion_adjuntos WHERE notificacion_id = ?',
      );
      const guardarAdjunto = db.prepare(
        `INSERT INTO arca_notificacion_adjuntos
           (id, notificacion_id, id_archivo, nombre, mime_type, tamano, sha256, contenido)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let insertadas = 0;
      let actualizadas = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const notificacion of notificaciones) {
          const yaExistia = existentes.has(
            clave(canonico(notificacion.contribuyenteCuit), notificacion.idComunicacion),
          );
          const parametros = [
            randomUUID(),
            clienteId,
            canonico(notificacion.contribuyenteCuit),
            notificacion.idComunicacion,
            notificacion.fecha,
            notificacion.organismo,
            notificacion.asunto,
            notificacion.leida ? 1 : 0,
          ] as const;
          if (notificacion.detalle) {
            guardarConDetalle.run(...parametros, notificacion.detalle.cuerpo);
            const fila = idNotificacion.get(
              clienteId,
              canonico(notificacion.contribuyenteCuit),
              notificacion.idComunicacion,
            ) as
              | { id: string }
              | undefined;
            if (!fila) throw new Error('No se pudo resolver la notificación recién guardada.');
            borrarAdjuntos.run(fila.id);
            for (const adjunto of notificacion.detalle.adjuntos) {
              guardarAdjunto.run(
                randomUUID(),
                fila.id,
                adjunto.idArchivo,
                adjunto.nombre,
                adjunto.mimeType,
                adjunto.tamano,
                adjunto.sha256,
                adjunto.contenido,
              );
            }
          } else {
            guardarSinDetalle.run(...parametros);
          }
          existentes.add(notificacion.idComunicacion);
          if (yaExistia) actualizadas += 1;
          else insertadas += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { insertadas, actualizadas };
    },

    async saldosDe(clienteId, contribuyenteCuit) {
      return todos<{
        cliente_id: string;
        contribuyente_cuit: string;
        establecimiento: string;
        impuesto: string;
        concepto: string;
        subconcepto: string;
        periodo: string;
        anticipo_cuota: string;
        fecha_vencimiento: string;
        saldo: number;
        interes_resarcitorio: number;
        interes_punitorio: number;
      }>(
        `SELECT * FROM arca_saldos
          WHERE cliente_id = ?${filtroEmpresa(contribuyenteCuit)}
          ORDER BY fecha_vencimiento, impuesto, periodo, anticipo_cuota`,
        ...argsEmpresa(clienteId, contribuyenteCuit),
      ).map<SaldoTributario>((f) => ({
        clienteId: f.cliente_id,
        contribuyenteCuit: f.contribuyente_cuit,
        establecimiento: f.establecimiento,
        impuesto: f.impuesto,
        concepto: f.concepto,
        subconcepto: f.subconcepto,
        periodo: f.periodo,
        anticipoCuota: f.anticipo_cuota,
        fechaVencimiento: f.fecha_vencimiento || null,
        saldo: f.saldo,
        interesResarcitorio: f.interes_resarcitorio,
        interesPunitorio: f.interes_punitorio,
      }));
    },

    async reemplazarSaldos(clienteId, saldos) {
      const insertar = db.prepare(
        `INSERT INTO arca_saldos
           (cliente_id, contribuyente_cuit, establecimiento, impuesto, concepto, subconcepto,
            periodo, anticipo_cuota, fecha_vencimiento, saldo,
            interes_resarcitorio, interes_punitorio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        correr('DELETE FROM arca_saldos WHERE cliente_id = ?', clienteId);
        for (const saldo of saldos) {
          insertar.run(
            clienteId,
            saldo.contribuyenteCuit,
            saldo.establecimiento,
            saldo.impuesto,
            saldo.concepto,
            saldo.subconcepto,
            saldo.periodo,
            saldo.anticipoCuota,
            saldo.fechaVencimiento ?? '',
            saldo.saldo,
            saldo.interesResarcitorio,
            saldo.interesPunitorio,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return saldos.length;
    },

    async planesDe(clienteId, contribuyenteCuit) {
      const filas = todos<{
        id: string;
        cliente_id: string;
        contribuyente_cuit: string;
        numero: string;
        concepto: string;
        fecha_presentacion: string | null;
        fecha_consolidacion: string | null;
        tipo_plan: string;
        monto_consolidado: number;
        estado: string;
        situacion: string;
        cuotas_totales: number;
        cuotas_pagas: number;
        cuotas_impagas: number;
        monto_cuota: number;
        proximo_vencimiento: string | null;
        total_pagado: number;
        leido_app_en: string | null;
      }>(
        `SELECT * FROM arca_planes WHERE cliente_id = ?${filtroEmpresa(contribuyenteCuit)}
          ORDER BY fecha_presentacion DESC, numero`,
        ...argsEmpresa(clienteId, contribuyenteCuit),
      );
      const cuotas = todos<{
        id: string;
        plan_id: string;
        numero: number;
        variante: number;
        capital: number;
        interes_financiero: number;
        interes_resarcitorio: number;
        total: number;
        fecha_vencimiento: string | null;
        pago: string;
        estado: string;
      }>(
        `SELECT pc.* FROM arca_plan_cuotas pc
          JOIN arca_planes p ON p.id = pc.plan_id
         WHERE p.cliente_id = ?
         ORDER BY pc.plan_id, pc.numero, pc.variante`,
        clienteId,
      ).map<CuotaPlan>((f) => ({
        id: f.id,
        planId: f.plan_id,
        numero: f.numero,
        variante: f.variante,
        capital: f.capital,
        interesFinanciero: f.interes_financiero,
        interesResarcitorio: f.interes_resarcitorio,
        total: f.total,
        fechaVencimiento: f.fecha_vencimiento,
        pago: f.pago,
        estado: f.estado,
      }));
      return filas.map<PlanPago>((f) => ({
        id: f.id,
        clienteId: f.cliente_id,
        contribuyenteCuit: f.contribuyente_cuit,
        numero: f.numero,
        concepto: f.concepto,
        fechaPresentacion: f.fecha_presentacion,
        fechaConsolidacion: f.fecha_consolidacion,
        tipoPlan: f.tipo_plan,
        montoConsolidado: f.monto_consolidado,
        estado: f.estado,
        situacion: f.situacion,
        cuotasTotales: f.cuotas_totales,
        cuotasPagas: f.cuotas_pagas,
        cuotasImpagas: f.cuotas_impagas,
        montoCuota: f.monto_cuota,
        proximoVencimiento: f.proximo_vencimiento,
        totalPagado: f.total_pagado,
        leidoAppEn: f.leido_app_en,
        cuotas: cuotas.filter((c) => c.planId === f.id),
      }));
    },

    async actualizarLecturaPlan(clienteId, planId, leido) {
      const leidoAppEn = leido ? new Date().toISOString() : null;
      const resultado = correr(
        `UPDATE arca_planes SET leido_app_en = ?
          WHERE cliente_id = ? AND id = ?`,
        leidoAppEn,
        clienteId,
        planId,
      );
      return Number(resultado.changes) > 0 ? { leidoAppEn } : null;
    },

    async vencimientosDe(clienteId, contribuyenteCuit) {
      return todos<{
        id: string;
        cliente_id: string;
        contribuyente_cuit: string;
        impuesto: string;
        concepto: string;
        subconcepto: string;
        periodo: string;
        anticipo_cuota: string;
        fecha: string;
        detalle: string;
      }>(
        `SELECT * FROM arca_vencimientos
          WHERE cliente_id = ?${filtroEmpresa(contribuyenteCuit)}
          ORDER BY contribuyente_cuit, fecha`,
        ...argsEmpresa(clienteId, contribuyenteCuit),
      ).map<Vencimiento>((f) => ({
        id: f.id,
        clienteId: f.cliente_id,
        contribuyenteCuit: f.contribuyente_cuit,
        impuesto: f.impuesto,
        concepto: f.concepto,
        subconcepto: f.subconcepto,
        periodo: f.periodo,
        anticipoCuota: f.anticipo_cuota,
        fecha: f.fecha,
        detalle: f.detalle,
      }));
    },

    async reemplazarVencimientos(clienteId, vencimientos) {
      const insertar = db.prepare(
        `INSERT INTO arca_vencimientos
           (id, cliente_id, contribuyente_cuit, impuesto, concepto, subconcepto,
            periodo, anticipo_cuota, fecha, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        correr('DELETE FROM arca_vencimientos WHERE cliente_id = ?', clienteId);
        for (const vencimiento of vencimientos) {
          insertar.run(
            randomUUID(),
            clienteId,
            vencimiento.contribuyenteCuit,
            vencimiento.impuesto,
            vencimiento.concepto,
            vencimiento.subconcepto,
            vencimiento.periodo,
            vencimiento.anticipoCuota,
            vencimiento.fecha,
            vencimiento.detalle,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return vencimientos.length;
    },

    async ddjjPendientesDe(clienteId, contribuyenteCuit) {
      return todos<{
        id: string;
        cliente_id: string;
        contribuyente_cuit: string;
        establecimiento: string;
        impuesto: string;
        concepto: string;
        subconcepto: string;
        periodo: string;
        fecha: string;
      }>(
        `SELECT * FROM arca_ddjj_pendientes
          WHERE cliente_id = ?${filtroEmpresa(contribuyenteCuit)}
          ORDER BY contribuyente_cuit, periodo DESC, impuesto`,
        ...argsEmpresa(clienteId, contribuyenteCuit),
      ).map<DeclaracionJuradaPendiente>((fila) => ({
        id: fila.id,
        clienteId: fila.cliente_id,
        contribuyenteCuit: fila.contribuyente_cuit,
        establecimiento: fila.establecimiento,
        impuesto: fila.impuesto,
        concepto: fila.concepto,
        subconcepto: fila.subconcepto,
        periodo: fila.periodo,
        fecha: fila.fecha || null,
      }));
    },

    async reemplazarDdjjPendientes(clienteId, declaraciones) {
      const insertar = db.prepare(
        `INSERT INTO arca_ddjj_pendientes
           (id, cliente_id, contribuyente_cuit, establecimiento, impuesto,
            concepto, subconcepto, periodo, fecha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        correr('DELETE FROM arca_ddjj_pendientes WHERE cliente_id = ?', clienteId);
        for (const declaracion of declaraciones) {
          insertar.run(
            randomUUID(),
            clienteId,
            declaracion.contribuyenteCuit,
            declaracion.establecimiento,
            declaracion.impuesto,
            declaracion.concepto,
            declaracion.subconcepto,
            declaracion.periodo,
            declaracion.fecha ?? '',
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return declaraciones.length;
    },

    async comprobantesDe(clienteId, contribuyenteCuit) {
      return todos<{
        id: string;
        cliente_id: string;
        contribuyente_cuit: string;
        tipo: string;
        fecha: string;
        codigo_comprobante: number;
        tipo_comprobante: string;
        punto_venta: number;
        numero: number;
        contraparte: string;
        cuit_contraparte: string;
        neto: number;
        iva: number;
        total: number;
      }>(
        `SELECT * FROM arca_comprobantes WHERE cliente_id = ?${filtroEmpresa(contribuyenteCuit)}
          ORDER BY fecha DESC`,
        ...argsEmpresa(clienteId, contribuyenteCuit),
      ).map<Comprobante>((f) => ({
        id: f.id,
        clienteId: f.cliente_id,
        contribuyenteCuit: f.contribuyente_cuit,
        tipo: f.tipo as Comprobante['tipo'],
        fecha: f.fecha,
        codigoComprobante: f.codigo_comprobante,
        tipoComprobante: f.tipo_comprobante,
        puntoVenta: f.punto_venta,
        numero: f.numero,
        contraparte: f.contraparte,
        cuitContraparte: f.cuit_contraparte,
        neto: f.neto,
        iva: f.iva,
        total: f.total,
      }));
    },

    async guardarComprobantes(clienteId, comprobantes) {
      let insertados = 0;
      // `DO NOTHING` sobre la clave natural: si el comprobante ya está, se
      // ignora. Es la base la que decide, no una consulta previa que dos jobs
      // concurrentes podrían pasar a la vez.
      const stmt = db.prepare(
        `INSERT INTO arca_comprobantes
           (id, cliente_id, contribuyente_cuit, tipo, fecha, codigo_comprobante,
            tipo_comprobante, punto_venta, numero, contraparte, cuit_contraparte,
            neto, iva, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cliente_id, contribuyente_cuit, tipo, codigo_comprobante, punto_venta, numero)
           DO NOTHING`,
      );

      db.exec('BEGIN');
      try {
        for (const c of comprobantes) {
          const r = stmt.run(
            randomUUID(),
            clienteId,
            c.contribuyenteCuit,
            c.tipo,
            c.fecha,
            c.codigoComprobante,
            c.tipoComprobante,
            c.puntoVenta,
            c.numero,
            c.contraparte,
            c.cuitContraparte,
            c.neto,
            c.iva,
            c.total,
          );
          if (Number(r.changes) > 0) insertados += 1;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      return { insertados, repetidos: comprobantes.length - insertados };
    },

    async reemplazarPlanes(clienteId, planes) {
      const lecturas = new Map(
        todos<{ numero: string; leido_app_en: string | null }>(
          'SELECT numero, leido_app_en FROM arca_planes WHERE cliente_id = ?',
          clienteId,
        ).map((fila) => [fila.numero, fila.leido_app_en] as const),
      );
      const insertarPlan = db.prepare(
        `INSERT INTO arca_planes
           (id, cliente_id, contribuyente_cuit, numero, concepto, fecha_presentacion,
            fecha_consolidacion, tipo_plan, monto_consolidado, estado, situacion,
            cuotas_totales, cuotas_pagas, cuotas_impagas, monto_cuota,
            proximo_vencimiento, total_pagado, leido_app_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertarCuota = db.prepare(
        `INSERT INTO arca_plan_cuotas
           (id, plan_id, numero, variante, capital, interes_financiero,
            interes_resarcitorio, total, fecha_vencimiento, pago, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let cantidadCuotas = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        // La lista de ARCA es una foto completa; reemplazar evita conservar
        // estados o cuotas que cambiaron entre sincronizaciones.
        correr('DELETE FROM arca_planes WHERE cliente_id = ?', clienteId);
        for (const plan of planes) {
          const planId = randomUUID();
          insertarPlan.run(
            planId,
            clienteId,
            canonico(plan.contribuyenteCuit),
            plan.numero,
            plan.concepto,
            plan.fechaPresentacion,
            plan.fechaConsolidacion,
            plan.tipoPlan,
            plan.montoConsolidado,
            plan.estado,
            plan.situacion,
            plan.cuotasTotales,
            plan.cuotasPagas,
            plan.cuotasImpagas,
            plan.montoCuota,
            plan.proximoVencimiento,
            plan.totalPagado,
            lecturas.get(plan.numero) ?? null,
          );
          for (const cuota of plan.cuotas) {
            insertarCuota.run(
              randomUUID(),
              planId,
              cuota.numero,
              cuota.variante,
              cuota.capital,
              cuota.interesFinanciero,
              cuota.interesResarcitorio,
              cuota.total,
              cuota.fechaVencimiento,
              cuota.pago,
              cuota.estado,
            );
            cantidadCuotas += 1;
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { planes: planes.length, cuotas: cantidadCuotas };
    },

    async encolarSync(clienteId, modulo, contribuyenteCuit) {
      const empresa = contribuyenteCuit?.replace(/\D/g, '') || null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const activo = uno<{
          id: string;
          cliente_id: string;
          modulo: string;
          estado: EstadoJob;
          intentos: number;
          creado_en: string;
          iniciado_en: string | null;
          finalizado_en: string | null;
          progreso_actual: number;
          progreso_total: number;
          paso_actual: string | null;
          error: string | null;
        }>(
          // El COALESCE separa por empresa: sincronizar la empresa A no debe
          // devolver —ni bloquear— el job de la B de la misma cuenta. Que
          // despues corran de a una lo garantiza `arca_sync_locks`.
          `SELECT * FROM arca_sync_jobs
            WHERE cliente_id = ?
              AND estado IN ('PENDING', 'RUNNING')
              AND COALESCE(contribuyente_cuit, '') = ?
              AND (modulo = ? OR modulo = 'sincronizacion-completa' OR ? = 'sincronizacion-completa')
            ORDER BY creado_en LIMIT 1`,
          clienteId,
          empresa ?? '',
          modulo,
          modulo,
        );
        if (activo) {
          correr(`UPDATE arca_clientes SET estado_sync = 'SINCRONIZANDO' WHERE id = ?`, clienteId);
          db.exec('COMMIT');
          return aSyncJob(activo);
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
          ...(empresa ? { contribuyenteCuit: empresa } : {}),
        };
        correr(
          `INSERT INTO arca_sync_jobs
             (id, cliente_id, modulo, estado, intentos, creado_en,
              progreso_actual, progreso_total, paso_actual, contribuyente_cuit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          job.id,
          job.clienteId,
          job.modulo,
          job.estado,
          job.intentos,
          job.creadoEn,
          job.progresoActual,
          job.progresoTotal,
          job.pasoActual,
          empresa,
        );
        correr(`UPDATE arca_clientes SET estado_sync = 'SINCRONIZANDO' WHERE id = ?`, clienteId);
        db.exec('COMMIT');
        return job;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async jobsDe(clienteId) {
      return todos<{
        id: string;
        cliente_id: string;
        modulo: string;
        estado: string;
        intentos: number;
        creado_en: string;
        error: string | null;
        iniciado_en: string | null;
        finalizado_en: string | null;
        progreso_actual: number;
        progreso_total: number;
        paso_actual: string | null;
      }>(
        'SELECT * FROM arca_sync_jobs WHERE cliente_id = ? ORDER BY creado_en DESC',
        clienteId,
      ).map(aSyncJob);
    },

    async actualizarProgresoJob(jobId, progreso, workerId) {
      const actualizado = correr(
        `UPDATE arca_sync_jobs
            SET progreso_actual = ?, progreso_total = ?, paso_actual = ?
          WHERE id = ? AND estado = 'RUNNING'
            AND (? IS NULL OR worker_id = ?)`,
        progreso.actual,
        progreso.total,
        progreso.paso,
        jobId,
        workerId ?? null,
        workerId ?? null,
      );
      if (Number(actualizado.changes) !== 1) {
        throw new Error(`no se pudo actualizar el progreso del job ${jobId}`);
      }
    },

    /* --- Cola: sólo el worker --- */

    async tomarProximoJob(workerId, ahoraIso, leaseHastaIso) {
      // El SELECT y el UPDATE van en una transacción porque tienen que ser
      // atómicos frente a otro worker: dos que lean el mismo PENDING terminan
      // logueando dos veces en simultáneo contra ARCA con la misma clave.
      //
      // En SQLite alcanza con esto (una sola conexión escribe a la vez). En
      // Azure SQL el equivalente es:
      //   UPDATE TOP(1) arca_sync_jobs WITH (READPAST, UPDLOCK)
      //     SET estado = 'RUNNING', intentos = intentos + 1
      //     OUTPUT inserted.*
      //   WHERE estado = 'PENDING'
      // — un solo statement, sin ventana entre leer y escribir.
      db.exec('BEGIN IMMEDIATE');
      try {
        const f = uno<{
          id: string;
          cliente_id: string;
          modulo: string;
          estado: string;
          intentos: number;
          creado_en: string;
          iniciado_en: string | null;
          finalizado_en: string | null;
          progreso_actual: number;
          progreso_total: number;
          paso_actual: string | null;
          error: string | null;
          solicitud_id: string | null;
        }>(
          `SELECT * FROM arca_sync_jobs
            WHERE estado = 'PENDING'
              AND (disponible_desde IS NULL OR disponible_desde <= ?)
            ORDER BY creado_en
            LIMIT 1`,
          ahoraIso,
        );
        if (!f) {
          db.exec('COMMIT');
          return null;
        }
        const iniciadoEn = new Date().toISOString();
        correr(
          `UPDATE arca_sync_jobs
              SET estado = 'RUNNING', intentos = intentos + 1, iniciado_en = ?,
                  worker_id = ?, heartbeat_en = ?, lease_hasta = ?,
                  disponible_desde = NULL, paso_actual = 'Preparando acceso ARCA'
            WHERE id = ?`,
          iniciadoEn,
          workerId,
          ahoraIso,
          leaseHastaIso,
          f.id,
        );
        // Verificar una solicitud de acceso no es sincronizar: la empresa no
        // se toca. Si se marcara SINCRONIZANDO, la oficina que ya la tiene
        // vería su tablero moverse por un pedido de un tercero.
        if (!f.solicitud_id) {
          correr(
            `UPDATE arca_clientes SET estado_sync = 'SINCRONIZANDO' WHERE id = ?`,
            f.cliente_id,
          );
        }
        db.exec('COMMIT');
        return {
          ...aSyncJob(f),
          estado: 'RUNNING' as EstadoJob,
          intentos: f.intentos + 1,
          iniciadoEn,
          pasoActual: 'Preparando acceso ARCA',
        };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    async adquirirBloqueoCuenta(jobId, workerId, claveCuenta, ahoraIso, leaseHastaIso) {
      db.exec('BEGIN IMMEDIATE');
      try {
        correr('DELETE FROM arca_sync_locks WHERE lease_hasta <= ?', ahoraIso);
        const propietario = uno<{ id: string }>(
          `SELECT id FROM arca_sync_jobs
            WHERE id = ? AND estado = 'RUNNING' AND worker_id = ?`,
          jobId,
          workerId,
        );
        if (!propietario) {
          db.exec('COMMIT');
          return false;
        }
        const existente = uno<{ job_id: string; worker_id: string }>(
          'SELECT job_id, worker_id FROM arca_sync_locks WHERE clave = ?',
          claveCuenta,
        );
        if (existente) {
          const propio = existente.job_id === jobId && existente.worker_id === workerId;
          if (propio) {
            correr(
              'UPDATE arca_sync_locks SET lease_hasta = ? WHERE clave = ?',
              leaseHastaIso,
              claveCuenta,
            );
          }
          db.exec('COMMIT');
          return propio;
        }
        correr(
          `INSERT INTO arca_sync_locks (clave, job_id, worker_id, lease_hasta)
           VALUES (?, ?, ?, ?)`,
          claveCuenta,
          jobId,
          workerId,
          leaseHastaIso,
        );
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async renovarLeaseJob(jobId, workerId, leaseHastaIso) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const ahora = new Date().toISOString();
        const actualizado = correr(
          `UPDATE arca_sync_jobs
              SET heartbeat_en = ?, lease_hasta = ?
            WHERE id = ? AND estado = 'RUNNING' AND worker_id = ?`,
          ahora,
          leaseHastaIso,
          jobId,
          workerId,
        );
        if (Number(actualizado.changes) === 1) {
          correr(
            `UPDATE arca_sync_locks SET lease_hasta = ?
              WHERE job_id = ? AND worker_id = ?`,
            leaseHastaIso,
            jobId,
            workerId,
          );
        }
        db.exec('COMMIT');
        return Number(actualizado.changes) === 1;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async reencolarJob(jobId, workerId, disponibleDesdeIso, detalle) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const job = uno<{ cliente_id: string }>(
          `SELECT cliente_id FROM arca_sync_jobs
            WHERE id = ? AND estado = 'RUNNING' AND worker_id = ?`,
          jobId,
          workerId,
        );
        if (!job) throw new Error(`el worker ${workerId} no es propietario del job ${jobId}`);
        correr('DELETE FROM arca_sync_locks WHERE job_id = ? AND worker_id = ?', jobId, workerId);
        correr(
          `UPDATE arca_sync_jobs
              SET estado = 'PENDING', worker_id = NULL, heartbeat_en = NULL,
                  lease_hasta = NULL, disponible_desde = ?, paso_actual = ?
            WHERE id = ? AND estado = 'RUNNING' AND worker_id = ?`,
          disponibleDesdeIso,
          detalle,
          jobId,
          workerId,
        );
        correr(
          `UPDATE arca_clientes
              SET estado_sync = 'SINCRONIZANDO', detalle_sync = ?
            WHERE id = ?`,
          detalle,
          job.cliente_id,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async recuperarJobsInterrumpidos(ahoraIso, antesDeIsoLegacy) {
      db.exec('BEGIN IMMEDIATE');
      try {
        correr('DELETE FROM arca_sync_locks WHERE lease_hasta <= ?', ahoraIso);
        const abandonados = todos<{ id: string; cliente_id: string }>(
          `SELECT id, cliente_id FROM arca_sync_jobs
            WHERE estado = 'RUNNING'
              AND ((lease_hasta IS NOT NULL AND lease_hasta <= ?)
                OR (lease_hasta IS NULL AND COALESCE(iniciado_en, creado_en) < ?))`,
          ahoraIso,
          antesDeIsoLegacy,
        );
        const ahora = ahoraIso;
        for (const job of abandonados) {
          correr('DELETE FROM arca_sync_locks WHERE job_id = ?', job.id);
          correr(
            `UPDATE arca_sync_jobs
                SET estado = 'ERROR', error = ?, finalizado_en = ?, paso_actual = 'Interrumpido',
                    worker_id = NULL, heartbeat_en = NULL, lease_hasta = NULL
              WHERE id = ? AND estado = 'RUNNING'`,
            'El worker se interrumpio antes de terminar el job.',
            ahora,
            job.id,
          );
          correr(
            `UPDATE arca_clientes
                SET estado_sync = 'ERROR', detalle_sync = ?
              WHERE id = ? AND estado_sync = 'SINCRONIZANDO'`,
            'La sincronizacion anterior se interrumpio. Podes volver a encolarla.',
            job.cliente_id,
          );
        }
        db.exec('COMMIT');
        return abandonados.length;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async clienteParaSync(clienteId) {
      const f = uno<FilaCliente>('SELECT * FROM arca_clientes WHERE id = ?', clienteId);
      return f ? aCliente(f) : null;
    },

    async finalizarJob(jobId, r, workerId) {
      const job = uno<{ cliente_id: string; solicitud_id: string | null }>(
        'SELECT cliente_id, solicitud_id FROM arca_sync_jobs WHERE id = ?',
        jobId,
      );
      if (!job) throw new Error(`job inexistente: ${jobId}`);

      const estadoSync: EstadoSync =
        r.estado === 'DONE' ? 'OK' : r.estado === 'NEEDS_HUMAN' ? 'NECESITA_HUMANO' : 'ERROR';

      db.exec('BEGIN');
      try {
        const actualizado = correr(
          `UPDATE arca_sync_jobs
              SET estado = ?, error = ?, finalizado_en = ?,
                  progreso_actual = CASE WHEN ? = 'DONE' THEN progreso_total ELSE progreso_actual END,
                  paso_actual = CASE WHEN ? = 'DONE' THEN 'Completado' ELSE paso_actual END,
                  worker_id = NULL, heartbeat_en = NULL, lease_hasta = NULL
            WHERE id = ? AND estado = 'RUNNING'
              AND (? IS NULL OR worker_id = ?)`,
          r.estado,
          r.estado === 'DONE' ? null : (r.detalle ?? null),
          new Date().toISOString(),
          r.estado,
          r.estado,
          jobId,
          workerId ?? null,
          workerId ?? null,
        );
        if (Number(actualizado.changes) !== 1) throw new Error(`no se pudo cerrar el job ${jobId}`);
        correr('DELETE FROM arca_sync_locks WHERE job_id = ?', jobId);

        // Un job de verificación resuelve su solicitud y NO toca al cliente.
        //
        // Esta rama es la garantía de seguridad de toda la función: si cayera
        // en el UPDATE de abajo, una clave equivocada de quien pide acceso
        // dejaría marcada como INVALIDA la credencial de la oficina que ya
        // tenía la empresa, y le cortaría las sincronizaciones.
        if (job.solicitud_id) {
          const aprobada = r.estado === 'DONE';
          correr(
            `UPDATE arca_solicitudes_acceso
                SET estado = ?, detalle = ?, resuelto_en = ?,
                    ciphertext = NULL, iv = NULL, auth_tag = NULL,
                    dek_envuelta = NULL, dek_iv = NULL, dek_auth_tag = NULL
              WHERE id = ? AND estado = 'PENDIENTE'`,
            aprobada ? 'APROBADA' : 'RECHAZADA',
            r.detalle ?? null,
            new Date().toISOString(),
            job.solicitud_id,
          );
          if (aprobada) {
            const solicitud = uno<{ usuario_id: string; cliente_id: string }>(
              'SELECT usuario_id, cliente_id FROM arca_solicitudes_acceso WHERE id = ?',
              job.solicitud_id,
            );
            if (solicitud) {
              correr(
                `INSERT OR IGNORE INTO arca_user_clientes (usuario_id, cliente_id)
                 VALUES (?, ?)`,
                solicitud.usuario_id,
                solicitud.cliente_id,
              );
            }
          }
          db.exec('COMMIT');
          return;
        }

        correr(
          `UPDATE arca_clientes
              SET estado_sync = ?,
                  ultimo_sync = ?,
                  detalle_sync = ?,
                  estado_credencial = COALESCE(?, estado_credencial)
            WHERE id = ?`,
          estadoSync,
          new Date().toISOString(),
          r.detalle ?? null,
          r.estadoCredencial ?? null,
          job.cliente_id,
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Semilla de demostración — TODO ficticio                             */
/* ------------------------------------------------------------------ */

function sembrarSiVacia(db: DatabaseSync): void {
  const hay = db.prepare('SELECT COUNT(*) AS n FROM arca_users').get() as { n: number };
  if (hay.n > 0) return;

  // Se calcula acá y no se hardcodea: un hash escrito a mano en el fuente es
  // un valor que nadie verificó y que puede simplemente no corresponder a la
  // password que dice. El formato es el mismo que produce hashearPassword().
  const salt = randomBytes(16);
  const HASH_DEMO = `scrypt$${salt.toString('base64')}$${scryptSync('demo', salt, 64).toString('base64')}`;

  const dia = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const hora = (n: number) => {
    const d = new Date();
    d.setHours(d.getHours() - n);
    return d.toISOString();
  };

  db.exec('BEGIN');
  try {
    for (const [id, email, nombre, rol, limiteClientes] of [
      ['u1', 'bruno@fisterra.com', 'Bruno Merino', 'admin', null],
      ['u2', 'ayudante@fisterra.com', 'Ayudante', 'user', 5],
    ] as const) {
      db.prepare(
        `INSERT INTO arca_users
           (id, email, nombre, rol, password_hash, limite_clientes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, email, nombre, rol, HASH_DEMO, limiteClientes);
    }

    const clientes: Array<[string, string, string, string, string, string | null, string | null, string | null]> = [
      ['c1', '30-71234567-1', 'Molinos del Sur S.A.', 'OK', 'OK', hora(3), null, dia(-140)],
      ['c2', '30-70987654-2', 'Delta Logística S.R.L.', 'OK', 'OK', hora(5), null, dia(-98)],
      ['c3', '27-28456789-2', 'Bertoni, Andrea Lucía', 'OK', 'OK', hora(4), null, dia(-61)],
      ['c4', '30-69874521-1', 'Textil Norte S.A.', 'VENCIDA', 'NECESITA_HUMANO', hora(72), 'ARCA exige cambiar la clave fiscal. Cambiala en el portal y actualizala acá.', dia(-210)],
      ['c5', '30-71122334-3', 'Comercial Rivadavia S.R.L.', 'INVALIDA', 'ERROR', hora(96), 'La clave fiscal guardada es incorrecta. Actualizala antes de volver a sincronizar.', dia(-175)],
      ['c6', '20-25478963-2', 'Ferretería Belgrano', 'SIN_CARGAR', 'NUNCA', null, 'Falta cargar la clave fiscal del cliente.', null],
    ];
    for (const c of clientes) {
      db.prepare(
        `INSERT INTO arca_clientes
           (id, cuit, razon_social, estado_credencial, estado_sync, ultimo_sync,
            detalle_sync, credencial_cargada_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...c);
    }
    const cuitDe = (clienteId: string) =>
      clientes.find(([id]) => id === clienteId)?.[1] ?? '';

    // Asignaciones desparejas a propósito: sin un usuario que vea menos, el
    // aislamiento multi-tenant no se puede probar de verdad.
    const asignar = db.prepare(
      'INSERT INTO arca_user_clientes (usuario_id, cliente_id) VALUES (?, ?)',
    );
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) asignar.run('u1', c);
    for (const c of ['c1', 'c2']) asignar.run('u2', c);

    const notif = db.prepare(
      // El contribuyente sale del propio cliente: en los datos de demo cada
      // cuenta se representa solo a si misma.
      `INSERT INTO arca_notificaciones
         (id, cliente_id, contribuyente_cuit, id_comunicacion, fecha, organismo, asunto, leida)
       VALUES (?, ?, (SELECT cuit FROM arca_clientes WHERE id = ?), ?, ?, 'ARCA', ?, ?)`,
    );
    notif.run('n1', 'c1', 'c1', 'ARCA-1001', dia(-1), 'Intimación por falta de presentación — IVA 07/2026', 0);
    notif.run('n2', 'c1', 'c1', 'ARCA-1002', dia(-6), 'Constancia de presentación F.731', 1);
    notif.run('n3', 'c2', 'c2', 'ARCA-1003', dia(-2), 'Vista de actuaciones — Fiscalización electrónica', 0);
    notif.run('n4', 'c2', 'c2', 'ARCA-1004', dia(-3), 'Aviso de vencimiento de plan de facilidades', 0);
    notif.run('n5', 'c3', 'c3', 'ARCA-1005', dia(-9), 'Recategorización de Monotributo disponible', 1);
    notif.run('n6', 'c4', 'c4', 'ARCA-1006', dia(-4), 'Notificación de deuda — Aportes Seguridad Social', 0);

    // Cada cuenta de demo se representa a si misma, que es lo que pasa de
    // verdad apenas se sincroniza por primera vez. Sin esto el panel de
    // empresas arranca vacio en este motor y en el otro no.
    const representado = db.prepare(
      `INSERT OR IGNORE INTO arca_representados (cliente_id, cuit, visto_en, actualizado_en)
       VALUES (?, (SELECT cuit FROM arca_clientes WHERE id = ?), 'demo', ?)`,
    );
    for (const clienteId of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
      representado.run(clienteId, clienteId, new Date().toISOString());
    }

    const saldo = db.prepare(
      `INSERT INTO arca_saldos
         (cliente_id, contribuyente_cuit, impuesto, periodo, saldo)
       VALUES (?, ?, ?, ?, ?)`,
    );
    saldo.run('c1', cuitDe('c1'), 'IVA', '07/2026', -1_284_500.35);
    saldo.run('c1', cuitDe('c1'), 'Ganancias', '2025', 430_120);
    saldo.run('c1', cuitDe('c1'), 'Seguridad Social', '07/2026', -98_400.5);
    saldo.run('c2', cuitDe('c2'), 'IVA', '07/2026', 215_900.8);
    saldo.run('c2', cuitDe('c2'), 'Ganancias', '2025', -2_450_000);
    saldo.run('c3', cuitDe('c3'), 'Monotributo', '08/2026', 0);
    saldo.run('c4', cuitDe('c4'), 'IVA', '06/2026', -5_120_300.75);
    saldo.run('c4', cuitDe('c4'), 'Seguridad Social', '06/2026', -740_050);

    const plan = db.prepare(
      `INSERT INTO arca_planes
         (id, cliente_id, contribuyente_cuit, numero, concepto, cuotas_totales,
          cuotas_pagas, cuotas_impagas, monto_cuota, proximo_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    plan.run('p1', 'c1', cuitDe('c1'), 'RG 5321 — 000148223', 'IVA 2025 — Moratoria', 24, 14, 0, 187_400, dia(9));
    plan.run('p2', 'c2', cuitDe('c2'), 'RG 4268 — 000097431', 'Ganancias 2024', 12, 7, 2, 342_800, dia(-5));
    plan.run('p3', 'c4', cuitDe('c4'), 'RG 5321 — 000151980', 'Seguridad Social 2025', 36, 4, 3, 96_250, dia(-18));

    const venc = db.prepare(
      `INSERT INTO arca_vencimientos
         (id, cliente_id, contribuyente_cuit, impuesto, periodo, fecha)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    venc.run('v1', 'c1', cuitDe('c1'), 'IVA', '07/2026', dia(4));
    venc.run('v2', 'c1', cuitDe('c1'), 'SICORE', '07/2026', dia(7));
    venc.run('v3', 'c1', cuitDe('c1'), 'F.931', '07/2026', dia(20));
    venc.run('v4', 'c2', cuitDe('c2'), 'IVA', '07/2026', dia(5));
    venc.run('v5', 'c2', cuitDe('c2'), 'F.931', '07/2026', dia(11));
    venc.run('v6', 'c3', cuitDe('c3'), 'Monotributo', '08/2026', dia(15));
    venc.run('v7', 'c4', cuitDe('c4'), 'IVA', '07/2026', dia(6));
    venc.run('v8', 'c5', cuitDe('c5'), 'IVA', '07/2026', dia(6));

    const comp = db.prepare(
      `INSERT INTO arca_comprobantes
         (id, cliente_id, contribuyente_cuit, tipo, fecha, codigo_comprobante, tipo_comprobante,
          punto_venta, numero, contraparte, cuit_contraparte, neto, iva, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    comp.run('k1', 'c1', cuitDe('c1'), 'EMITIDO', dia(-2), 1, 'Factura A', 3, 20_481, 'Distribuidora Paraná S.A.', '30-70112233-6', 1_240_000, 260_400, 1_500_400);
    comp.run('k2', 'c1', cuitDe('c1'), 'EMITIDO', dia(-8), 1, 'Factura A', 3, 20_480, 'Agro Insumos del Litoral S.R.L.', '30-71455667-9', 890_000, 186_900, 1_076_900);
    comp.run('k3', 'c1', cuitDe('c1'), 'RECIBIDO', dia(-4), 1, 'Factura A', 12, 884_321, 'Transporte Andino S.A.', '30-68997744-4', 415_000, 87_150, 502_150);
    comp.run('k4', 'c1', cuitDe('c1'), 'RECIBIDO', dia(-11), 3, 'Nota de Crédito A', 12, 884_190, 'Transporte Andino S.A.', '30-68997744-4', -62_000, -13_020, -75_020);
    comp.run('k5', 'c2', cuitDe('c2'), 'EMITIDO', dia(-1), 6, 'Factura B', 7, 15_233, 'Consumidor Final', '—', 268_000, 56_280, 324_280);
    comp.run('k6', 'c2', cuitDe('c2'), 'RECIBIDO', dia(-3), 1, 'Factura A', 4, 331_200, 'Combustibles Cuyo S.A.', '30-70554433-2', 1_890_000, 396_900, 2_286_900);
    comp.run('k7', 'c3', cuitDe('c3'), 'EMITIDO', dia(-6), 11, 'Factura C', 1, 412, 'Estudio Jurídico Roldán', '30-71889900-8', 480_000, 0, 480_000);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

interface FilaSolicitud {
  id: string;
  cliente_id: string;
  cuit: string;
  razon_social: string;
  estado: string;
  detalle: string | null;
  creado_en: string;
  resuelto_en: string | null;
}

function aSolicitud(f: FilaSolicitud): SolicitudAcceso {
  const solicitud: SolicitudAcceso = {
    id: f.id,
    clienteId: f.cliente_id,
    cuit: f.cuit,
    razonSocial: f.razon_social,
    estado: f.estado as SolicitudAcceso['estado'],
    creadoEn: f.creado_en,
  };
  if (f.detalle) solicitud.detalle = f.detalle;
  if (f.resuelto_en) solicitud.resueltoEn = f.resuelto_en;
  return solicitud;
}

function aSyncJob(f: {
  id: string;
  cliente_id: string;
  modulo: string;
  estado: string;
  intentos: number;
  creado_en: string;
  iniciado_en?: string | null;
  finalizado_en?: string | null;
  progreso_actual: number;
  progreso_total: number;
  paso_actual?: string | null;
  error: string | null;
  solicitud_id?: string | null;
  contribuyente_cuit?: string | null;
}): SyncJob {
  const job: SyncJob = {
    id: f.id,
    clienteId: f.cliente_id,
    modulo: f.modulo,
    estado: f.estado as EstadoJob,
    intentos: f.intentos,
    creadoEn: f.creado_en,
    progresoActual: f.progreso_actual,
    progresoTotal: f.progreso_total,
  };
  if (f.iniciado_en) job.iniciadoEn = f.iniciado_en;
  if (f.finalizado_en) job.finalizadoEn = f.finalizado_en;
  if (f.error) job.error = f.error;
  if (f.paso_actual) job.pasoActual = f.paso_actual;
  if (f.solicitud_id) job.solicitudId = f.solicitud_id;
  if (f.contribuyente_cuit) job.contribuyenteCuit = f.contribuyente_cuit;
  return job;
}
