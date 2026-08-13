import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Hash de contrasenas de USUARIOS del panel (no de claves fiscales — esas se
 * cifran, ver envelope.ts, porque hay que poder recuperarlas para loguear en
 * ARCA. Las de usuario no: nunca hay que recuperarlas, solo verificarlas).
 *
 * scrypt viene en Node, sin dependencias, y es deliberadamente costoso en CPU
 * y memoria para que probar contrasenas a lo bruto sea caro.
 */

const BYTES_SALT = 16;
const BYTES_HASH = 64;

export async function hashearPassword(password: string): Promise<string> {
  const salt = randomBytes(BYTES_SALT);
  const hash = await scrypt(password, salt, BYTES_HASH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verificarPassword(password: string, guardado: string): Promise<boolean> {
  const [algoritmo, saltB64, hashB64] = guardado.split('$');
  if (algoritmo !== 'scrypt' || !saltB64 || !hashB64) return false;

  const esperado = Buffer.from(hashB64, 'base64');
  const calculado = await scrypt(password, Buffer.from(saltB64, 'base64'), esperado.length);
  return timingSafeEqual(esperado, calculado);
}
