import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearORecrearClienteDemo, USUARIO_DEMO_PASSWORD } from '../src/repo/cliente-demo.js';
import { crearRepositorioSqlite } from '../src/repo/sqlite.js';

const carpetaApi = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rutaConfigurada = process.env['SQLITE_PATH'] ?? 'arca.db';
const archivo = isAbsolute(rutaConfigurada)
  ? rutaConfigurada
  : resolve(carpetaApi, rutaConfigurada);

// Aplica el esquema y las migraciones antes de insertar la foto ficticia.
crearRepositorioSqlite({ archivo, sembrar: false }).cerrar();

const db = new DatabaseSync(archivo);
try {
  const resultado = await crearORecrearClienteDemo(db);
  console.log(`Cliente demo listo en ${archivo}`);
  console.log(`  cliente         : ${resultado.clienteId}`);
  console.log(`  acceso local    : ${resultado.usuarioEmail} / ${USUARIO_DEMO_PASSWORD}`);
  console.log(`  notificaciones  : ${resultado.notificaciones}`);
  console.log(`  saldos          : ${resultado.saldos}`);
  console.log(`  planes          : ${resultado.planes}`);
  console.log(`  vencimientos    : ${resultado.vencimientos}`);
  console.log(`  comprobantes    : ${resultado.comprobantes}`);
} finally {
  db.close();
}
