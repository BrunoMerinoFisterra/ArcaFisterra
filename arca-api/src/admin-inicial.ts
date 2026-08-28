import type { Config } from './config.js';
import { hashearPassword } from './crypto/password.js';
import type { Repositorio } from './repo/tipos.js';

/**
 * Crea la cuenta administradora del primer arranque.
 *
 * Resuelve el huevo y la gallina de una instalación nueva: con SEMBRAR_DEMO=0
 * la base arranca sin usuarios, y `POST /usuarios` exige ser admin — así que
 * sin esto no hay forma de que entre nadie.
 *
 * Es idempotente y no destructivo: si ya existe cualquier usuario no hace nada
 * y deja las variables sin efecto. Eso importa más de lo que parece. Estas
 * variables viven en el `.env` del servidor para siempre, así que un reinicio
 * cualquiera no puede recrear ni pisar cuentas; y si alguien cambia la
 * contraseña desde Mi Cuenta, el valor viejo del archivo no la revive.
 *
 * La contraseña nunca se loguea. Queda en el `.env` y en la cabeza de quien lo
 * escribió, y el mensaje empuja a cambiarla desde la app en el primer ingreso.
 */
export async function crearAdminInicialSiHaceFalta(
  repo: Repositorio,
  config: Config,
): Promise<void> {
  const admin = config.adminInicial;
  if (!admin) return;

  // El hash se calcula siempre, incluso cuando después no se use: el chequeo
  // de "la base está vacía" tiene que pasar dentro de la transacción del alta,
  // así que no se puede consultar antes sin abrir una ventana de carrera.
  const creado = await repo.crearAdminInicial({
    email: admin.email,
    nombre: admin.nombre,
    passwordHash: await hashearPassword(admin.password),
  });

  if (creado) {
    console.log(`  admin inicial: creado ${creado.email} — cambiá la contraseña al entrar`);
  } else {
    console.log('  admin inicial: ya había usuarios, no se creó ninguno');
  }
}
