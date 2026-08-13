/** Utilidad local para corregir el CUIT objetivo sin perder el acceso ARCA. */
import { DatabaseSync } from 'node:sqlite';
import { cifrarAccesoArca, descifrarAccesoArca } from '../src/crypto/envelope.js';
import { cargarConfig } from '../src/config.js';
import { formatearCuit, validarCuit } from '../src/dominio/cuit.js';
import { crearRepositorioSqlite } from '../src/repo/sqlite.js';

const [clienteId, nuevoCuitEntrada] = process.argv.slice(2);
if (!clienteId || !nuevoCuitEntrada) {
  throw new Error('Uso: tsx scripts/corregir-cliente-cuit.ts <cliente-id> <nuevo-cuit>');
}
const problema = validarCuit(nuevoCuitEntrada);
if (problema) throw new Error(problema);
const nuevoCuit = formatearCuit(nuevoCuitEntrada);

const config = cargarConfig();
const repo = crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: false });
try {
  const cliente = await repo.clienteParaSync(clienteId);
  if (!cliente) throw new Error('Cliente inexistente.');
  if (cliente.cuit === nuevoCuit) throw new Error('El cliente ya tiene ese CUIT.');
  if (await repo.existeCuit(nuevoCuit)) throw new Error(`Ya existe otro cliente con ${nuevoCuit}.`);

  const credencial = await repo.leerCredencialCifrada(cliente.id);
  if (credencial) {
    const acceso = descifrarAccesoArca(config.claveMaestra, credencial, cliente.cuit);
    try {
      // Convierte también credenciales legacy para que el login no dependa del CUIT anterior.
      await repo.guardarCredencial(cliente.id, cifrarAccesoArca(config.claveMaestra, acceso));
    } finally {
      acceso.clave = '';
    }
  }
  repo.cerrar();

  const db = new DatabaseSync(config.sqlitePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM arca_planes WHERE cliente_id = ?').run(cliente.id);
    db.prepare(
      `UPDATE arca_clientes
          SET cuit = ?, estado_sync = 'NUNCA', ultimo_sync = NULL,
              detalle_sync = 'CUIT objetivo corregido. Volvé a sincronizar los módulos.'
        WHERE id = ?`,
    ).run(nuevoCuit, cliente.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  console.log(`${cliente.razonSocial}: ${cliente.cuit} -> ${nuevoCuit}`);
} finally {
  try {
    repo.cerrar();
  } catch {
    // Ya se cerró antes de la actualización directa.
  }
  config.claveMaestra.fill(0);
}
