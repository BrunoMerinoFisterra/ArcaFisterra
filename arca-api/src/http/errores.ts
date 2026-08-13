import type { NextFunction, Request, Response } from 'express';

/** Error con status HTTP, para cortar desde cualquier capa. */
export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorHttp';
  }
}

export const noAutenticado = () => new ErrorHttp(401, 'No autenticado.');
export const sinPermiso = () => new ErrorHttp(403, 'No tenés permisos para esto.');

/**
 * 404 para un cliente ajeno, no 403.
 *
 * Un 403 confirmaria que ese id existe. Para un usuario sin acceso, un cliente
 * de otro estudio tiene que ser indistinguible de uno inexistente.
 */
export const clienteNoEncontrado = () => new ErrorHttp(404, 'No existe ese cliente.');

export function manejadorErrores(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ErrorHttp) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    err.type === 'entity.too.large'
  ) {
    res.status(413).json({ error: 'El archivo supera el tamaño permitido.' });
    return;
  }

  // Un error inesperado puede traer detalles internos (rutas, SQL, stack).
  // Se loguea completo del lado servidor y se responde algo generico.
  console.error('[error no manejado]', err);
  res.status(500).json({ error: 'Error interno.' });
}
