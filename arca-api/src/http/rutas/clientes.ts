import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { cifrarAccesoArca } from '../../crypto/envelope.js';
import { formatearCuit, validarCuit } from '../../dominio/cuit.js';
import { armarResumen, porUrgencia } from '../../dominio/resumen.js';
import type { Repositorio } from '../../repo/tipos.js';
import { requiereAuth, usuarioDe } from '../auth.js';
import { clienteNoEncontrado, ErrorHttp } from '../errores.js';

const esquemaAlta = z.object({
  cuit: z.string().min(1),
  razonSocial: z.string().min(1).max(200),
});

const esquemaCredencial = z.object({
  usuarioCuit: z.string().min(1),
  clave: z.string().min(1).max(200),
});

const esquemaLectura = z.object({ leido: z.boolean() });

export function rutasClientes(repo: Repositorio, config: Config): Router {
  const router = Router();
  router.use(requiereAuth(config.jwtSecret, repo));

  /**
   * Resuelve un cliente comprobando que el usuario tenga acceso.
   *
   * TODA ruta que reciba un :id pasa por aca. Es la barrera multi-tenant: sin
   * esto, cambiar el id en la URL deja ver los datos fiscales de otro
   * contribuyente. Devuelve 404 y no 403 para no confirmar que el id existe.
   */
  async function clienteVisible(id: unknown, usuarioId: string) {
    // Express tipa los params como string | string[]: un `?id=a&id=b` llega
    // como array. Solo se acepta un string suelto.
    if (typeof id !== 'string' || id.length === 0) throw clienteNoEncontrado();
    const cliente = await repo.obtenerClienteDe(usuarioId, id);
    if (!cliente) throw clienteNoEncontrado();
    return cliente;
  }

  const mensajeCupoExcedido = (cantidad: number, limite: number) =>
    `Tu cuenta tiene ${cantidad} clientes activos y un cupo de ${limite}. ` +
    `El acceso fiscal está bloqueado hasta que un administrador quite ${cantidad - limite} ` +
    `${cantidad - limite === 1 ? 'cliente' : 'clientes'} de tu cuenta.`;

  /** Lista básica que permanece disponible para poder regularizar el cupo. */
  router.get('/administracion', async (req, res) => {
    const usuario = usuarioDe(req);
    const clientes = await repo.listarClientesDe(usuario.id);
    const cantidadClientes = clientes.length;
    res.json({
      clientes,
      cantidadClientes,
      limiteClientes: usuario.limiteClientes,
      excedido:
        usuario.limiteClientes !== null && cantidadClientes > usuario.limiteClientes,
    });
  });

  /** Los usuarios no pueden rotar clientes para reutilizar un cupo ya consumido. */
  router.delete('/:id', async (req, res) => {
    const usuario = usuarioDe(req);
    if (usuario.rol !== 'admin') {
      throw new ErrorHttp(403, 'Sólo un administrador puede quitar clientes de una cuenta.');
    }
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    await repo.eliminarClienteDe(usuario.id, cliente.id);
    res.status(204).end();
  });

  // Bloqueo central: cubre tablero, detalles, adjuntos, lectura y todos los
  // módulos de sincronización. No depende de que el frontend esconda botones.
  router.use(async (req, _res, next) => {
    const usuario = usuarioDe(req);
    if (usuario.limiteClientes === null) return next();
    const cantidad = await repo.cantidadClientesDe(usuario.id);
    if (cantidad > usuario.limiteClientes) {
      return next(new ErrorHttp(409, mensajeCupoExcedido(cantidad, usuario.limiteClientes)));
    }
    next();
  });

  /** Tablero: un resumen por cliente, ya ordenado por urgencia. */
  router.get('/', async (req, res) => {
    const usuario = usuarioDe(req);
    const clientes = await repo.listarClientesDe(usuario.id);
    const resumenes = await Promise.all(clientes.map((c) => armarResumen(repo, c)));
    res.json(resumenes.sort(porUrgencia));
  });

  router.get('/:id', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    const [notificaciones, saldos, planes, vencimientos, ddjjPendientes, comprobantes] = await Promise.all([
      repo.notificacionesDe(cliente.id),
      repo.saldosDe(cliente.id),
      repo.planesDe(cliente.id),
      repo.vencimientosDe(cliente.id),
      repo.ddjjPendientesDe(cliente.id),
      repo.comprobantesDe(cliente.id),
    ]);

    res.json({ cliente, notificaciones, saldos, planes, vencimientos, ddjjPendientes, comprobantes });
  });

  router.post('/', async (req, res) => {
    const usuario = usuarioDe(req);
    const parseo = esquemaAlta.safeParse(req.body);
    if (!parseo.success) throw new ErrorHttp(400, 'Faltan el CUIT o la razón social.');

    const cantidadActual = await repo.cantidadClientesDe(usuario.id);
    if (usuario.limiteClientes !== null && cantidadActual >= usuario.limiteClientes) {
      throw new ErrorHttp(
        409,
        `Alcanzaste el límite de ${usuario.limiteClientes} clientes de tu cuenta.`,
      );
    }

    const problema = validarCuit(parseo.data.cuit);
    if (problema) throw new ErrorHttp(400, problema);

    const cuit = formatearCuit(parseo.data.cuit);
    if (await repo.existeCuit(cuit)) {
      throw new ErrorHttp(409, 'Ya existe un cliente con ese CUIT.');
    }

    const cliente = await repo.crearCliente(
      { cuit, razonSocial: parseo.data.razonSocial.trim() },
      usuario.id,
    );
    res.status(201).json(cliente);
  });

  /**
   * Guarda el acceso ARCA (usuario CUIT y clave fiscal).
   *
   * Entra y no vuelve nunca: se cifra acá y la respuesta es el cliente, que por
   * tipo no tiene ningún campo de credencial. No existe endpoint para leerla.
   */
  router.post('/:id/credencial', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    const parseo = esquemaCredencial.safeParse(req.body);
    if (!parseo.success) {
      throw new ErrorHttp(400, 'El usuario CUIT y la clave no pueden estar vacíos.');
    }

    const problemaCuit = validarCuit(parseo.data.usuarioCuit);
    if (problemaCuit) throw new ErrorHttp(400, `Usuario ARCA: ${problemaCuit}`);

    const cifrada = cifrarAccesoArca(config.claveMaestra, {
      usuarioCuit: parseo.data.usuarioCuit.replace(/\D/g, ''),
      clave: parseo.data.clave,
    });
    res.json(await repo.guardarCredencial(cliente.id, cifrada));
  });

  /** Encola un job para el worker. El scraping no corre acá. */
  router.post('/:id/sincronizar', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    res.status(202).json(await repo.encolarSync(cliente.id, 'mis-comprobantes'));
  });

  /** Una sola sesión ARCA para todos los servicios del cliente. */
  router.post('/:id/sincronizar-completa', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    res.status(202).json(await repo.encolarSync(cliente.id, 'sincronizacion-completa'));
  });

  /** Sincronización independiente de Presentaciones → Detalle → Ver Pagos. */
  router.post('/:id/sincronizar-facilidades', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    res.status(202).json(await repo.encolarSync(cliente.id, 'mis-facilidades'));
  });

  /** Lee la bandeja del DFE sin abrir ni marcar comunicaciones como leídas. */
  router.post('/:id/sincronizar-domicilio', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    res.status(202).json(await repo.encolarSync(cliente.id, 'domicilio-fiscal'));
  });

  /** Lee la pestaña Deudas del Sistema de Cuentas Tributarias. */
  router.post('/:id/sincronizar-saldos', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    res.status(202).json(
      await repo.encolarSync(cliente.id, 'sistema-cuentas-tributarias'),
    );
  });

  /** Registra una vista local sin abrir ni modificar la comunicación en ARCA. */
  router.post('/:id/notificaciones/:notificacionId/vista', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    const notificacionId = req.params['notificacionId'];
    if (typeof notificacionId !== 'string' || notificacionId.length === 0) {
      throw clienteNoEncontrado();
    }
    const notificacion = await repo.marcarNotificacionVista(cliente.id, notificacionId);
    if (!notificacion) throw clienteNoEncontrado();
    res.json(notificacion);
  });

  /** Lectura local reversible. No modifica el estado legal de la comunicación en ARCA. */
  router.patch('/:id/notificaciones/:notificacionId/lectura', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    const notificacionId = req.params['notificacionId'];
    const parseo = esquemaLectura.safeParse(req.body);
    if (typeof notificacionId !== 'string' || !parseo.success) {
      throw new ErrorHttp(400, 'Estado de lectura inválido.');
    }
    const lectura = await repo.actualizarLecturaNotificacion(
      cliente.id,
      notificacionId,
      parseo.data.leido,
    );
    if (!lectura) throw clienteNoEncontrado();
    res.json(lectura);
  });

  /** Lectura local reversible del detalle de un plan de facilidades. */
  router.patch('/:id/planes/:planId/lectura', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    const planId = req.params['planId'];
    const parseo = esquemaLectura.safeParse(req.body);
    if (typeof planId !== 'string' || !parseo.success) {
      throw new ErrorHttp(400, 'Estado de lectura inválido.');
    }
    const lectura = await repo.actualizarLecturaPlan(cliente.id, planId, parseo.data.leido);
    if (!lectura) throw clienteNoEncontrado();
    res.json(lectura);
  });

  /** Descarga autenticada de un adjunto guardado localmente. */
  router.get('/:id/notificaciones/:notificacionId/adjuntos/:adjuntoId', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    const notificacionId = req.params['notificacionId'];
    const adjuntoId = req.params['adjuntoId'];
    if (typeof notificacionId !== 'string' || typeof adjuntoId !== 'string') {
      throw clienteNoEncontrado();
    }
    const adjunto = await repo.adjuntoNotificacionDe(
      cliente.id,
      notificacionId,
      adjuntoId,
    );
    if (!adjunto) throw clienteNoEncontrado();

    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(adjunto.mimeType)
      ? adjunto.mimeType
      : 'application/octet-stream';
    const nombreAscii = adjunto.nombre
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 180) || 'adjunto';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(adjunto.contenido.byteLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nombreAscii}"; filename*=UTF-8''${encodeURIComponent(adjunto.nombre)}`,
    );
    res.send(Buffer.from(adjunto.contenido));
  });

  router.get('/:id/jobs', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    res.json(await repo.jobsDe(cliente.id));
  });

  return router;
}
