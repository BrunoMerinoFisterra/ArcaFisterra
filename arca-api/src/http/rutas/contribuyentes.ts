import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { validarCuit } from '../../dominio/cuit.js';
import type { Repositorio } from '../../repo/tipos.js';
import { requiereAuth } from '../auth.js';
import { ErrorHttp } from '../errores.js';

const esquemaNombre = z.object({
  nombre: z.string().trim().min(2).max(200),
});

/**
 * Razón social de los contribuyentes que Cuentas Tributarias agrupa por CUIT.
 *
 * Va en un router propio y no bajo /clientes porque el dato NO es de un
 * cliente: un CUIT tiene una sola razón social, y cargarla una vez la muestra
 * en todo el panel, sin importar desde qué cliente se mire.
 *
 * No exige rol admin a propósito: no es un dato sensible ni consume cupo, y
 * pedir un administrador para escribir un nombre sería fricción sin ganancia.
 * Quien puede ver el grupo puede nombrarlo.
 */
export function rutasContribuyentes(repo: Repositorio, config: Config): Router {
  const router = Router();
  router.use(requiereAuth(config.jwtSecret, repo));

  router.put('/:cuit', async (req, res) => {
    const cuit = req.params['cuit'];
    if (typeof cuit !== 'string') throw new ErrorHttp(400, 'CUIT inválido.');

    // Se valida el dígito verificador igual que en el alta de clientes: un CUIT
    // mal tipeado acá deja un nombre huérfano que no matchea con nada y que
    // nadie va a notar, porque el grupo sigue mostrándose sin nombre.
    const problema = validarCuit(cuit);
    if (problema) throw new ErrorHttp(400, problema);

    const parseo = esquemaNombre.safeParse(req.body);
    if (!parseo.success) {
      throw new ErrorHttp(400, 'La razón social tiene que tener entre 2 y 200 caracteres.');
    }

    await repo.guardarNombreContribuyente(cuit, parseo.data.nombre);
    res.json({ cuit, nombre: parseo.data.nombre });
  });

  return router;
}
