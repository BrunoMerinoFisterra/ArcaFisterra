import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { verificarPassword } from '../../crypto/password.js';
import type { Repositorio } from '../../repo/tipos.js';
import { firmarToken, requiereAuth, usuarioDe } from '../auth.js';
import { ErrorHttp } from '../errores.js';

const esquemaLogin = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

  return router;
}

/**
 * Hash de una contrasena aleatoria, solo para gastar el mismo tiempo de scrypt
 * cuando el email no existe. Nunca va a matchear.
 */
const HASH_SENUELO =
  'scrypt$YWJjZGVmZ2hpamtsbW5vcA==$' +
  'ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGE=';
