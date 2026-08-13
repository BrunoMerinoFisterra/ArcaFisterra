import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Rol, Usuario } from '../dominio/tipos.js';
import type { Repositorio } from '../repo/tipos.js';
import { noAutenticado, sinPermiso } from './errores.js';

export const VIGENCIA_TOKEN = '8h';

interface Payload {
  sub: string;
  email: string;
  nombre: string;
  rol: Rol;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: Usuario;
    }
  }
}

export function firmarToken(secreto: string, usuario: Usuario): string {
  const payload: Payload = {
    sub: usuario.id,
    email: usuario.email,
    nombre: usuario.nombre,
    rol: usuario.rol,
  };
  return jwt.sign(payload, secreto, { expiresIn: VIGENCIA_TOKEN });
}

/**
 * Exige un JWT valido y deja el usuario en req.usuario.
 *
 * El rol sale del token firmado, no de nada que mande el cliente. La UI del
 * front esconde secciones segun el rol, pero eso es cosmetico: la autorizacion
 * real pasa por aca.
 */
export function requiereAuth(secreto: string, repo: Repositorio) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(noAutenticado());

    try {
      const payload = jwt.verify(header.slice(7), secreto) as Payload;
      // El JWT prueba la identidad, pero el estado actual sale siempre de la
      // base. Así una pausa o cambio de rol invalida una sesión ya abierta.
      void repo
        .buscarUsuarioPorId(payload.sub)
        .then((actual) => {
          if (!actual) return next(noAutenticado());
          const { passwordHash: _descartado, ...publico } = actual;
          req.usuario = publico;
          next();
        })
        .catch(next);
    } catch {
      // Token vencido, firma invalida o manoseado: todos son 401.
      next(noAutenticado());
    }
  };
}

export function requiereAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.usuario?.rol !== 'admin') return next(sinPermiso());
  next();
}

/** Atajo para rutas ya autenticadas. */
export function usuarioDe(req: Request): Usuario {
  if (!req.usuario) throw noAutenticado();
  return req.usuario;
}
