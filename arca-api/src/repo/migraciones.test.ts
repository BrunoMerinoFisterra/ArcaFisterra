import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { crearRepositorioSqlite } from './sqlite.js';

test('migra comprobantes del esquema anterior sin borrar la base', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-migracion-'));
  const archivo = join(carpeta, 'legacy.db');
  const legacy = new DatabaseSync(archivo);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE arca_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL,
      rol TEXT NOT NULL, password_hash TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE arca_clientes (
      id TEXT PRIMARY KEY, cuit TEXT NOT NULL UNIQUE, razon_social TEXT NOT NULL,
      estado_credencial TEXT NOT NULL, estado_sync TEXT NOT NULL, ultimo_sync TEXT,
      detalle_sync TEXT, credencial_cargada_en TEXT, autorizacion_archivo TEXT,
      autorizacion_fecha TEXT
    );
    CREATE TABLE arca_comprobantes (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL, fecha TEXT NOT NULL, tipo_comprobante TEXT NOT NULL,
      punto_venta INTEGER NOT NULL, numero INTEGER NOT NULL, contraparte TEXT NOT NULL,
      cuit_contraparte TEXT NOT NULL, neto REAL NOT NULL, iva REAL NOT NULL,
      total REAL NOT NULL,
      UNIQUE (cliente_id, tipo, tipo_comprobante, punto_venta, numero)
    );
    INSERT INTO arca_users (id, email, nombre, rol, password_hash)
      VALUES ('u-legacy', 'legacy@example.com', 'Legacy', 'admin', 'no-importa');
    INSERT INTO arca_clientes
      (id, cuit, razon_social, estado_credencial, estado_sync)
      VALUES ('c-legacy', '30-71234567-1', 'Legacy S.A.', 'OK', 'OK');
    INSERT INTO arca_comprobantes
      (id, cliente_id, tipo, fecha, tipo_comprobante, punto_venta, numero,
       contraparte, cuit_contraparte, neto, iva, total)
      VALUES ('k-legacy', 'c-legacy', 'RECIBIDO', '2026-08-01', 'Factura A', 2, 15,
              'Proveedor', '30-70000000-0', 100, 21, 121);
  `);
  legacy.close();

  const repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const comprobantes = await repo.comprobantesDe('c-legacy');
    assert.equal(comprobantes.length, 1);
    assert.equal(comprobantes[0]?.codigoComprobante, 1);
    assert.equal(comprobantes[0]?.total, 121);
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});

test('migra saldos resumidos al esquema detallado sin perder importes', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-migracion-saldos-'));
  const archivo = join(carpeta, 'legacy.db');
  const legacy = new DatabaseSync(archivo);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE arca_clientes (
      id TEXT PRIMARY KEY, cuit TEXT NOT NULL UNIQUE, razon_social TEXT NOT NULL,
      estado_credencial TEXT NOT NULL, estado_sync TEXT NOT NULL, ultimo_sync TEXT,
      detalle_sync TEXT, credencial_cargada_en TEXT
    );
    CREATE TABLE arca_saldos (
      cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
      impuesto TEXT NOT NULL, periodo TEXT NOT NULL, saldo REAL NOT NULL,
      PRIMARY KEY (cliente_id, impuesto, periodo)
    );
    INSERT INTO arca_clientes
      (id, cuit, razon_social, estado_credencial, estado_sync)
      VALUES ('c-legacy', '30-71234567-1', 'Legacy S.A.', 'OK', 'OK');
    INSERT INTO arca_saldos (cliente_id, impuesto, periodo, saldo)
      VALUES ('c-legacy', 'IVA', '07/2026', -1250.50);
  `);
  legacy.close();

  const repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const [saldo] = await repo.saldosDe('c-legacy');
    assert.equal(saldo?.saldo, -1250.5);
    assert.equal(saldo?.contribuyenteCuit, '30-71234567-1');
    assert.equal(saldo?.concepto, '');
    assert.equal(saldo?.interesResarcitorio, 0);
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});

test('migra notificaciones anteriores y agrega el estado local sin perderlas', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-migracion-dfe-'));
  const archivo = join(carpeta, 'legacy.db');
  const legacy = new DatabaseSync(archivo);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE arca_clientes (
      id TEXT PRIMARY KEY, cuit TEXT NOT NULL UNIQUE, razon_social TEXT NOT NULL,
      estado_credencial TEXT NOT NULL, estado_sync TEXT NOT NULL, ultimo_sync TEXT,
      detalle_sync TEXT, credencial_cargada_en TEXT
    );
    CREATE TABLE arca_notificaciones (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
      id_comunicacion TEXT NOT NULL, fecha TEXT NOT NULL, organismo TEXT NOT NULL,
      asunto TEXT NOT NULL, leida INTEGER NOT NULL DEFAULT 0,
      UNIQUE (cliente_id, id_comunicacion)
    );
    INSERT INTO arca_clientes
      (id, cuit, razon_social, estado_credencial, estado_sync)
      VALUES ('c-dfe', '30-71234567-1', 'Legacy DFE S.A.', 'OK', 'OK');
    INSERT INTO arca_notificaciones
      (id, cliente_id, id_comunicacion, fecha, organismo, asunto, leida)
      VALUES ('n-dfe', 'c-dfe', '123', '2026-08-01', 'ARCA', 'Mensaje anterior', 0);
  `);
  legacy.close();

  const repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const [notificacion] = await repo.notificacionesDe('c-dfe');
    assert.equal(notificacion?.id, 'n-dfe');
    assert.equal(notificacion?.estado, 'SIN_LEER');
    assert.equal(notificacion?.vistaAppEn, null);
    assert.equal(notificacion?.leidoAppEn, null);
    assert.equal(notificacion?.cuerpo, null);
    assert.deepEqual(notificacion?.adjuntos, []);
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});

test('migra cuentas anteriores y asigna cupos sin tocar sus clientes', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-migracion-usuarios-'));
  const archivo = join(carpeta, 'legacy.db');
  const legacy = new DatabaseSync(archivo);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE arca_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL,
      rol TEXT NOT NULL, password_hash TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE arca_clientes (
      id TEXT PRIMARY KEY, cuit TEXT NOT NULL UNIQUE, razon_social TEXT NOT NULL,
      estado_credencial TEXT NOT NULL, estado_sync TEXT NOT NULL, ultimo_sync TEXT,
      detalle_sync TEXT, credencial_cargada_en TEXT
    );
    CREATE TABLE arca_user_clientes (
      usuario_id TEXT NOT NULL REFERENCES arca_users(id) ON DELETE CASCADE,
      cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
      PRIMARY KEY (usuario_id, cliente_id)
    );
    INSERT INTO arca_users (id, email, nombre, rol, password_hash) VALUES
      ('admin-legacy', 'admin@legacy.test', 'Admin', 'admin', 'hash'),
      ('user-legacy', 'user@legacy.test', 'Usuario', 'user', 'hash');
    INSERT INTO arca_clientes
      (id, cuit, razon_social, estado_credencial, estado_sync)
      VALUES ('cliente-legacy', '30-00000000-7', 'Cliente Legacy', 'OK', 'OK');
    INSERT INTO arca_user_clientes (usuario_id, cliente_id)
      VALUES ('user-legacy', 'cliente-legacy');
  `);
  legacy.close();

  const repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const usuarios = await repo.listarUsuarios();
    const admin = usuarios.find((usuario) => usuario.id === 'admin-legacy');
    const usuario = usuarios.find((cuenta) => cuenta.id === 'user-legacy');
    assert.equal(admin?.limiteClientes, null);
    assert.equal(usuario?.limiteClientes, 5);
    assert.equal(usuario?.clientesAsignados, 1);
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});

test('agrega leases a una cola existente antes de crear su indice', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-migracion-jobs-'));
  const archivo = join(carpeta, 'legacy.db');
  const legacy = new DatabaseSync(archivo);
  legacy.exec(`
    CREATE TABLE arca_sync_jobs (
      id TEXT PRIMARY KEY,
      cliente_id TEXT NOT NULL,
      modulo TEXT NOT NULL,
      estado TEXT NOT NULL,
      intentos INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL,
      iniciado_en TEXT,
      finalizado_en TEXT,
      progreso_actual INTEGER NOT NULL DEFAULT 0,
      progreso_total INTEGER NOT NULL DEFAULT 1,
      paso_actual TEXT,
      error TEXT
    );
    INSERT INTO arca_sync_jobs
      (id, cliente_id, modulo, estado, creado_en)
      VALUES ('job-legacy', 'cliente-legacy', 'mis-comprobantes', 'PENDING', '2026-08-01T00:00:00.000Z');
  `);
  legacy.close();

  const repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const lease = new Date(Date.now() + 60_000).toISOString();
    const job = await repo.tomarProximoJob('worker-migracion', new Date().toISOString(), lease);
    assert.equal(job?.id, 'job-legacy');
    assert.equal(job?.estado, 'RUNNING');
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});

/**
 * Dos empresas de la misma cuenta pueden tener su job a la vez, y lo siguen
 * pudiendo despues de reabrir la base.
 *
 * El indice unico de la cola tiene que separar por empresa. El paso que lo
 * creaba asi se salteaba apenas `contribuyente_cuit` existia —o sea siempre en
 * una base nueva, donde `esquema.sql` ya la trae— y el paso anterior lo dejaba
 * sin la empresa: encolar la segunda moria con "UNIQUE constraint failed".
 *
 * Reabrir es la otra mitad. Las migraciones corren en cada arranque de la API y
 * de cada worker sobre la misma base, asi que un indice que solo sobrevive al
 * primero no sirve de nada — y una limpieza de duplicados que no mire la
 * empresa cancelaria en ese arranque el job de la otra.
 */
test('dos empresas de la misma cuenta tienen su job, tambien al reabrir', async () => {
  const carpeta = await mkdtemp(join(tmpdir(), 'arcapanel-jobs-empresa-'));
  const archivo = join(carpeta, 'cola.db');
  let repo = crearRepositorioSqlite({ archivo, sembrar: false });
  try {
    const usuario = await repo.crearUsuario({
      email: 'oficina@example.com',
      nombre: 'Oficina',
      passwordHash: 'no-importa',
      limiteClientes: 10,
    });
    const cuenta = await repo.crearCliente(
      { cuit: '30-70000000-0', razonSocial: 'Cuenta con dos representadas' },
      usuario.id,
    );

    const a = await repo.encolarSync(cuenta.id, 'sincronizacion-completa', '30-11111111-2');
    const b = await repo.encolarSync(cuenta.id, 'sincronizacion-completa', '30-22222222-3');
    assert.notEqual(a.id, b.id, 'cada empresa tiene que tener su propio job');

    repo.cerrar();
    repo = crearRepositorioSqlite({ archivo, sembrar: false });

    const pendientes = (await repo.jobsDe(cuenta.id)).filter((job) => job.estado === 'PENDING');
    assert.deepEqual(
      pendientes.map((job) => job.contribuyenteCuit).sort(),
      ['30111111112', '30222222223'],
      'reabrir la base no puede cancelar el job de la otra empresa',
    );

    // Y el indice tiene que seguir separando por empresa, no solo la primera vez.
    const c = await repo.encolarSync(cuenta.id, 'sincronizacion-completa', '30-33333333-4');
    assert.equal(c.contribuyenteCuit, '30333333334');
    assert.notEqual(c.id, a.id);
    assert.notEqual(c.id, b.id);
  } finally {
    repo.cerrar();
    await rm(carpeta, { recursive: true, force: true });
  }
});
