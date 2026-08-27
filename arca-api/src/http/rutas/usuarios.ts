import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { hashearPassword } from '../../crypto/password.js';
import type { UsuarioGestion } from '../../dominio/tipos.js';
import type { Repositorio } from '../../repo/tipos.js';
import { requiereAdmin, requiereAuth } from '../auth.js';
import { ErrorHttp } from '../errores.js';

const esquemaAlta = z.object({
  nombre: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  password: z.string().min(6).max(200),
  limiteClientes: z.number().int().min(0).max(10_000),
});

const esquemaCambios = z
  .object({
    nombre: z.string().trim().min(2).max(100).optional(),
    password: z.string().min(6).max(200).optional(),
    limiteClientes: z.number().int().min(0).max(10_000).optional(),
    activo: z.boolean().optional(),
  })
  .refine((cambios) => Object.keys(cambios).length > 0);

export function rutasUsuarios(repo: Repositorio, config: Config): Router {
  const router = Router();
  router.use(requiereAuth(config.jwtSecret, repo), requiereAdmin);

  async function conClientes(usuario: UsuarioGestion) {
    const clientes = await repo.listarClientesDe(usuario.id);
    return {
      ...usuario,
      clientes: clientes.map(({ id, cuit, razonSocial }) => ({ id, cuit, razonSocial })),
    };
  }

  router.get('/', async (_req, res) => {
    res.json(await Promise.all((await repo.listarUsuarios()).map(conClientes)));
  });

  router.post('/', async (req, res) => {
    const parseo = esquemaAlta.safeParse(req.body);
    if (!parseo.success) {
      throw new ErrorHttp(400, 'Revisá nombre, email, contraseña y límite de clientes.');
    }
    const email = parseo.data.email.toLowerCase();
    if (await repo.existeEmailUsuario(email)) {
      throw new ErrorHttp(409, 'Ya existe una cuenta con ese email.');
    }
    const passwordHash = await hashearPassword(parseo.data.password);
    const usuario = await repo.crearUsuario({
      email,
      nombre: parseo.data.nombre,
      passwordHash,
      limiteClientes: parseo.data.limiteClientes,
    });
    res.status(201).json(await conClientes(usuario));
  });

  router.patch('/:id', async (req, res) => {
    const id = req.params['id'];
    const parseo = esquemaCambios.safeParse(req.body);
    if (typeof id !== 'string' || !parseo.success) {
      throw new ErrorHttp(400, 'Los cambios de la cuenta no son válidos.');
    }
    const actual = (await repo.listarUsuarios()).find((usuario) => usuario.id === id);
    if (!actual) throw new ErrorHttp(404, 'No existe ese usuario.');
    if (actual.rol === 'admin') {
      throw new ErrorHttp(409, 'Las cuentas administradoras no se modifican desde este panel.');
    }

    const cambios: {
      nombre?: string;
      passwordHash?: string;
      limiteClientes?: number;
      activo?: boolean;
    } = {};
    if (parseo.data.nombre !== undefined) cambios.nombre = parseo.data.nombre;
    if (parseo.data.limiteClientes !== undefined) {
      cambios.limiteClientes = parseo.data.limiteClientes;
    }
    if (parseo.data.activo !== undefined) cambios.activo = parseo.data.activo;
    if (parseo.data.password !== undefined) {
      cambios.passwordHash = await hashearPassword(parseo.data.password);
    }
    const actualizado = await repo.actualizarUsuario(id, cambios);
    if (!actualizado) throw new ErrorHttp(404, 'No existe ese usuario.');
    res.json(await conClientes(actualizado));
  });

  /**
   * Asigna una empresa YA CARGADA a otra cuenta.
   *
   * Sin esta ruta, un cliente dado de alta por alguien queda inaccesible para
   * el resto para siempre: `POST /clientes` rechaza el CUIT repetido, así que
   * no existe un segundo camino para llegar al mismo contribuyente.
   */
  router.post('/:id/clientes/:clienteId', async (req, res) => {
    const id = req.params['id'];
    const clienteId = req.params['clienteId'];
    if (typeof id !== 'string' || typeof clienteId !== 'string') {
      throw new ErrorHttp(400, 'La cuenta o el cliente no son válidos.');
    }
    const destino = (await repo.listarUsuarios()).find((usuario) => usuario.id === id);
    if (!destino) throw new ErrorHttp(404, 'No existe ese usuario.');

    // A diferencia de la baja, acá SÍ se admite una cuenta administradora: si
    // un ayudante dio de alta el cliente, el titular no tiene ningún otro
    // camino para acceder a él.

    // El cupo se controla también en la asignación. Si sólo lo mirara el alta,
    // asignar sería exactamente la forma de saltearlo.
    if (destino.limiteClientes !== null) {
      const cantidad = await repo.cantidadClientesDe(destino.id);
      if (cantidad >= destino.limiteClientes) {
        throw new ErrorHttp(
          409,
          `La cuenta tiene ${cantidad} clientes y su cupo es de ${destino.limiteClientes}.`,
        );
      }
    }

    const resultado = await repo.asignarClienteA(destino.id, clienteId);
    if (resultado === 'CLIENTE_INEXISTENTE') throw new ErrorHttp(404, 'No existe ese cliente.');
    if (resultado === 'YA_ASIGNADO') {
      throw new ErrorHttp(409, 'Ese cliente ya está asignado a la cuenta.');
    }
    res.status(201).json(await conClientes(destino));
  });

  /**
   * Desasigna una empresa de una cuenta. Es deliberadamente una ruta de
   * administrador: el titular no puede ciclar clientes para reutilizar cupos.
   */
  router.delete('/:id/clientes/:clienteId', async (req, res) => {
    const id = req.params['id'];
    const clienteId = req.params['clienteId'];
    if (typeof id !== 'string' || typeof clienteId !== 'string') {
      throw new ErrorHttp(400, 'La cuenta o el cliente no son válidos.');
    }
    const actual = (await repo.listarUsuarios()).find((usuario) => usuario.id === id);
    if (!actual) throw new ErrorHttp(404, 'No existe ese usuario.');
    if (actual.rol === 'admin') {
      throw new ErrorHttp(409, 'Las cuentas administradoras no se modifican desde este panel.');
    }
    const cliente = await repo.obtenerClienteDe(id, clienteId);
    if (!cliente) throw new ErrorHttp(404, 'Ese cliente no está asignado a la cuenta.');

    await repo.eliminarClienteDe(id, cliente.id);
    res.status(204).end();
  });

  return router;
}
