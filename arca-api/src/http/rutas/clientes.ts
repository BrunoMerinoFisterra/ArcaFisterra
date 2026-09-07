import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { cifrarAccesoArca } from '../../crypto/envelope.js';
import { formatearCuit, validarCuit } from '../../dominio/cuit.js';
import {
  armarResumen,
  armarResumenEmpresa,
  porUrgencia,
  porUrgenciaEmpresa,
} from '../../dominio/resumen.js';
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

const esquemaSolicitud = z.object({
  cuit: z.string().min(1),
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

  /**
   * Pide acceso a una empresa que otra cuenta ya tiene cargada.
   *
   * Va ANTES de `/:id` a propósito: Express resuelve por orden de registro y
   * `/solicitudes` matchearía como un id de cliente.
   *
   * No asigna nada acá. Deja la solicitud PENDIENTE y encola el job que la
   * verifica contra ARCA con la clave fiscal que manda quien la pide. Esa
   * prueba es lo único que separa "compartir una empresa entre dos oficinas"
   * de "cualquiera lee la carpeta fiscal ajena escribiendo un CUIT público".
   */
  router.post('/solicitudes', async (req, res) => {
    const usuario = usuarioDe(req);
    const parseo = esquemaSolicitud.safeParse(req.body);
    if (!parseo.success) {
      throw new ErrorHttp(400, 'Faltan el CUIT de la empresa, el usuario ARCA o la clave.');
    }

    const problema = validarCuit(parseo.data.cuit);
    if (problema) throw new ErrorHttp(400, problema);
    const problemaUsuario = validarCuit(parseo.data.usuarioCuit);
    if (problemaUsuario) throw new ErrorHttp(400, `Usuario ARCA: ${problemaUsuario}`);

    // El cupo se controla igual que en el alta: sin esto, pedir acceso sería
    // exactamente la forma de saltearlo.
    if (usuario.limiteClientes !== null) {
      const cantidad = await repo.cantidadClientesDe(usuario.id);
      if (cantidad >= usuario.limiteClientes) {
        throw new ErrorHttp(
          409,
          `Alcanzaste el límite de ${usuario.limiteClientes} clientes de tu cuenta.`,
        );
      }
    }

    const cifrada = cifrarAccesoArca(config.claveMaestra, {
      usuarioCuit: parseo.data.usuarioCuit.replace(/\D/g, ''),
      clave: parseo.data.clave,
    });

    const resultado = await repo.solicitarAcceso(
      usuario.id,
      formatearCuit(parseo.data.cuit),
      cifrada,
    );

    if (resultado.estado === 'CLIENTE_INEXISTENTE') {
      throw new ErrorHttp(404, 'No hay ninguna empresa cargada con ese CUIT.');
    }
    if (resultado.estado === 'YA_ASIGNADO') {
      throw new ErrorHttp(409, 'Esa empresa ya está en tu cuenta.');
    }
    if (resultado.estado === 'YA_PENDIENTE') {
      throw new ErrorHttp(
        409,
        'Ya hay un pedido en curso para esa empresa. Esperá a que termine antes de reintentar.',
      );
    }
    res.status(202).json({ solicitud: resultado.solicitud, job: resultado.job });
  });

  /** Solicitudes propias, para que la pantalla siga el resultado. */
  router.get('/solicitudes', async (req, res) => {
    res.json(await repo.solicitudesDe(usuarioDe(req).id));
  });

  /**
   * Normaliza `?empresa=`. Devuelve undefined si no vino o no es un CUIT.
   *
   * Un valor basura se ignora en vez de rechazarse: el filtro es una
   * comodidad de la pantalla, no una barrera de seguridad — esa la sigue
   * haciendo `clienteVisible` sobre la cuenta.
   */
  function empresaPedida(valor: unknown): string | undefined {
    if (typeof valor !== 'string') return undefined;
    const digitos = valor.replace(/\D/g, '');
    return digitos.length === 11 ? digitos : undefined;
  }

  /**
   * El panel principal: todas las empresas de todas las cuentas del usuario.
   *
   * Va ANTES de `/:id` a proposito — si no, Express haria matchear "empresas"
   * como si fuera un id de cliente.
   */
  router.get('/empresas', async (req, res) => {
    const usuario = usuarioDe(req);
    const empresas = await repo.empresasDeUsuario(usuario.id);

    // Las cuentas se leen una sola vez y se indexan: son pocas y varias
    // empresas comparten la misma, asi que pedirla por empresa seria repetir
    // la misma consulta N veces.
    const cuentas = new Map(
      (await repo.listarClientesDe(usuario.id)).map((cliente) => [cliente.id, cliente]),
    );
    const resumenes = await Promise.all(
      empresas
        .filter((empresa) => cuentas.has(empresa.clienteId))
        .map((empresa) => armarResumenEmpresa(repo, empresa, cuentas.get(empresa.clienteId)!)),
    );
    res.json(resumenes.sort(porUrgenciaEmpresa));
  });

  /** Las empresas que esta cuenta representa, para el panel y el selector. */
  router.get('/:id/empresas', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    res.json(await repo.empresasDe(cliente.id));
  });

  /**
   * Sincroniza UNA empresa.
   *
   * Es distinto de `POST /:id/sincronizar`, que recorre la cuenta entera en una
   * pasada por servicio. Acá el worker se posiciona en ese CUIT y no toca a las
   * demas empresas de la cuenta.
   */
  router.post('/:id/empresas/:cuit/sincronizar', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);
    if (cliente.estadoCredencial !== 'OK') {
      throw new ErrorHttp(409, 'No se puede sincronizar: la credencial no está en condiciones.');
    }
    const empresa = empresaPedida(req.params['cuit']);
    if (!empresa) throw new ErrorHttp(400, 'El CUIT de la empresa no es válido.');

    const disponibles = await repo.empresasDe(cliente.id);
    // Comparado en digitos: `empresaPedida` normaliza asi y el repositorio
    // guarda con guiones. Comparar los strings crudos no matchea nunca, y el
    // 404 resultante se ve en la pantalla como "No existe ese cliente".
    if (!disponibles.some((candidata) => candidata.cuit.replace(/\D/g, '') === empresa)) {
      throw new ErrorHttp(404, 'Esa empresa no está entre las de esta cuenta.');
    }
    res.status(202).json(await repo.encolarSync(cliente.id, 'sincronizacion-completa', empresa));
  });

  router.get('/:id', async (req, res) => {
    const usuario = usuarioDe(req);
    const cliente = await clienteVisible(req.params['id'], usuario.id);

    // `?empresa=<cuit>` acota TODO el detalle a una de las empresas de la
    // cuenta. Sin el, sigue devolviendo la cuenta entera — que es la mezcla de
    // todos los representados, y es lo que ve la pantalla de la cuenta.
    const empresa = empresaPedida(req.query['empresa']);
    if (empresa) {
      const disponibles = await repo.empresasDe(cliente.id);
      // 404 y no 403, igual que `clienteVisible`: no confirmamos que un CUIT
      // exista bajo otra cuenta.
      //
      // La comparación va en dígitos por lo mismo que en la ruta de
      // sincronizar: `empresaPedida` normaliza así y el repositorio guarda con
      // guiones, así que los strings crudos no matchean nunca.
      if (!disponibles.some((candidata) => candidata.cuit.replace(/\D/g, '') === empresa)) {
        throw new ErrorHttp(404, 'Esa empresa no está entre las de esta cuenta.');
      }
    }

    const [notificaciones, saldos, planes, vencimientos, ddjjPendientes, comprobantes] = await Promise.all([
      repo.notificacionesDe(cliente.id, empresa),
      repo.saldosDe(cliente.id, empresa),
      repo.planesDe(cliente.id, empresa),
      repo.vencimientosDe(cliente.id, empresa),
      repo.ddjjPendientesDe(cliente.id, empresa),
      repo.comprobantesDe(cliente.id, empresa),
    ]);

    // Cuentas Tributarias y Mis Comprobantes agrupan por contribuyente, y ARCA
    // no informa el nombre en ninguno de los dos: se resuelve acá para los
    // CUITs que efectivamente aparecen.
    const contribuyentes = await repo.nombresDeContribuyentes([
      ...saldos.map((s) => s.contribuyenteCuit),
      ...vencimientos.map((v) => v.contribuyenteCuit),
      ...ddjjPendientes.map((d) => d.contribuyenteCuit),
      ...comprobantes.map((c) => c.contribuyenteCuit),
    ]);

    res.json({
      cliente,
      notificaciones,
      saldos,
      planes,
      vencimientos,
      ddjjPendientes,
      comprobantes,
      contribuyentes,
    });
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
      // El código importa: el front lo usa para ofrecer el pedido de acceso en
      // vez de dejar a la oficina sin salida. Sin él, "ya existe" era el final
      // del camino aunque la empresa sí se pueda compartir.
      throw new ErrorHttp(
        409,
        'Esa empresa ya está cargada en el sistema. Podés pedir acceso con tu clave fiscal.',
        'CUIT_YA_CARGADO',
      );
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
