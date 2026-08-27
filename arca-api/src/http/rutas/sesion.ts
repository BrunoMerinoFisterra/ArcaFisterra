import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { hashearPassword, verificarPassword } from '../../crypto/password.js';
import type { Repositorio } from '../../repo/tipos.js';
import { firmarToken, requiereAuth, usuarioDe } from '../auth.js';
import { ErrorHttp } from '../errores.js';

const esquemaLogin = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const esquemaCambioPassword = z.object({
  passwordActual: z.string().min(1),
  passwordNueva: z.string().min(6).max(200),
});

/** Ventana y tope de intentos fallidos por email. */
const VENTANA_MS = 15 * 60_000;
const MAX_INTENTOS = 8;

export function rutasSesion(repo: Repositorio, config: Config): Router {
  const router = Router();

  /**
   * Freno simple de fuerza bruta, por email.
   *
   * En memoria alcanza para un proceso; con varias instancias hay que moverlo
   * a un store compartido. Vale la pena igual: sin ningun limite, probar
   * contrasenas contra este endpoint no cuesta nada.
   */
  const intentos = new Map<string, { fallos: number; desde: number }>();

  function registrarFallo(email: string): void {
    const ahora = Date.now();
    const actual = intentos.get(email);
    if (!actual || ahora - actual.desde > VENTANA_MS) {
      intentos.set(email, { fallos: 1, desde: ahora });
    } else {
      actual.fallos += 1;
    }
  }

  function bloqueado(email: string): boolean {
    const actual = intentos.get(email);
    if (!actual) return false;
    if (Date.now() - actual.desde > VENTANA_MS) {
      intentos.delete(email);
      return false;
    }
    return actual.fallos >= MAX_INTENTOS;
  }

  router.post('/login', async (req, res) => {
    const parseo = esquemaLogin.safeParse(req.body);
    if (!parseo.success) throw new ErrorHttp(400, 'Email o contraseña incorrectos.');

    const email = parseo.data.email.toLowerCase().trim();
    if (bloqueado(email)) {
      throw new ErrorHttp(429, 'Demasiados intentos fallidos. Esperá unos minutos.');
    }

    const usuario = await repo.buscarUsuarioPorEmail(email);

    // Se verifica el password incluso si el usuario no existe, contra un hash
    // descartable, para que el tiempo de respuesta no revele que direcciones
    // estan dadas de alta.
    const hash = usuario?.passwordHash ?? HASH_SENUELO;
    const ok = await verificarPassword(parseo.data.password, hash);

    if (!usuario || !ok) {
      registrarFallo(email);
      // Mismo mensaje en ambos casos: distinguirlos le confirma a un atacante
      // que emails existen.
      throw new ErrorHttp(401, 'Email o contraseña incorrectos.');
    }

    intentos.delete(email);
    const { passwordHash: _descartado, ...publico } = usuario;
    res.json({ token: firmarToken(config.jwtSecret, publico), usuario: publico });
  });

  router.get('/yo', requiereAuth(config.jwtSecret, repo), (req, res) => {
    res.json(usuarioDe(req));
  });

  /**
   * Cambio de la contraseña PROPIA.
   *
   * Vive acá y no en /usuarios porque no es administrar cuentas ajenas: la
   * cambia cada uno para sí, incluidos los administradores — que hasta ahora no
   * tenían ningún camino, porque `PATCH /usuarios/:id` rechaza las cuentas
   * admin y no hay otra ruta que toque contraseñas.
   *
   * Exige la contraseña actual. Sin eso, una sesión prestada o robada alcanza
   * para cambiar la clave y dejar afuera al dueño de la cuenta.
   */
  router.patch('/password', requiereAuth(config.jwtSecret, repo), async (req, res) => {
    const usuario = usuarioDe(req);
    const parseo = esquemaCambioPassword.safeParse(req.body);
    if (!parseo.success) {
      throw new ErrorHttp(400, 'La contraseña nueva tiene que tener al menos 6 caracteres.');
    }

    // El hash sale de la base, no del token: el JWT prueba identidad, no clave.
    const actual = await repo.buscarUsuarioPorId(usuario.id);
    if (!actual) throw new ErrorHttp(401, 'La sesión ya no es válida.');

    if (!(await verificarPassword(parseo.data.passwordActual, actual.passwordHash))) {
      throw new ErrorHttp(403, 'La contraseña actual no es correcta.');
    }
    if (parseo.data.passwordNueva === parseo.data.passwordActual) {
      throw new ErrorHttp(400, 'La contraseña nueva tiene que ser distinta de la actual.');
    }

    const passwordHash = await hashearPassword(parseo.data.passwordNueva);
    if (!(await repo.actualizarUsuario(usuario.id, { passwordHash }))) {
      throw new ErrorHttp(404, 'No existe la cuenta.');
    }
    res.status(204).end();
  });

  return router;
}

/**
 * Hash de una contrasena aleatoria, solo para gastar el mismo tiempo de scrypt
 * cuando el email no existe. Nunca va a matchear.
 */
const HASH_SENUELO =
  'scrypt$YWJjZGVmZ2hpamtsbW5vcA==$' +
  'ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGE=';
