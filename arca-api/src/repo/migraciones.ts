import type { DatabaseSync } from 'node:sqlite';

/**
 * Prepara y migra una base SQLite existente sin exigir borrarla.
 *
 * `CREATE TABLE IF NOT EXISTS` sirve para una base nueva, pero no agrega
 * columnas ni cambia constraints. Las migraciones incompatibles se resuelven
 * aca de forma explicita antes de que el repositorio empiece a operar.
 */
export function prepararEsquemaSqlite(db: DatabaseSync, esquema: string): void {
  db.exec(esquema);
  asegurarColumnasUsuarios(db);
  migrarComprobantesConCodigo(db);
  migrarComprobantesConContribuyente(db);
  migrarSaldosDetallados(db);
  migrarVencimientosDetallados(db);
  migrarSaldosConContribuyente(db);
  migrarVencimientosConContribuyente(db);
  asegurarColumnasPlanes(db);
  asegurarColumnasNotificaciones(db);
  migrarNotificacionesConContribuyente(db);
  migrarPlanesConContribuyente(db);
  // Una reconstruccion elimina los indices de la tabla anterior.
  db.exec(esquema);
  asegurarColumnasJobs(db);
  asegurarUnSoloJobActivo(db);
  asegurarJobPorEmpresa(db);
  limpiarDetalleAutorizacionAnterior(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS arca_schema_migrations (
      version      INTEGER PRIMARY KEY,
      aplicada_en  TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (2, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (3, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (4, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (5, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (6, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (7, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (8, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (9, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (10, ?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO arca_schema_migrations (version, aplicada_en)
     VALUES (11, ?)`,
  ).run(new Date().toISOString());
}

/**
 * Agrega `contribuyente_cuit` a los comprobantes y lo mete en la unicidad.
 *
 * Hasta esta migracion Mis Comprobantes traia solo el CUIT del cliente, asi que
 * todas las filas existentes son de ese contribuyente: el backfill sale del
 * JOIN con arca_clientes, igual que en saldos y vencimientos.
 *
 * Va por reconstruccion porque cambia el UNIQUE, no solo agrega una columna.
 */
function migrarComprobantesConContribuyente(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_comprobantes)').all() as Array<{
    name: string;
  }>;
  if (columnas.length === 0) return;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_comprobantes RENAME TO arca_comprobantes_sin_contribuyente;

      CREATE TABLE arca_comprobantes (
        id                TEXT PRIMARY KEY,
        cliente_id        TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        contribuyente_cuit TEXT NOT NULL,
        tipo              TEXT NOT NULL CHECK (tipo IN ('EMITIDO', 'RECIBIDO')),
        fecha             TEXT NOT NULL,
        codigo_comprobante INTEGER NOT NULL,
        tipo_comprobante  TEXT NOT NULL,
        punto_venta       INTEGER NOT NULL,
        numero            INTEGER NOT NULL,
        contraparte       TEXT NOT NULL,
        cuit_contraparte  TEXT NOT NULL,
        neto              REAL NOT NULL,
        iva               REAL NOT NULL,
        total             REAL NOT NULL,
        UNIQUE (cliente_id, contribuyente_cuit, tipo, codigo_comprobante, punto_venta, numero)
      );

      INSERT INTO arca_comprobantes
        (id, cliente_id, contribuyente_cuit, tipo, fecha, codigo_comprobante,
         tipo_comprobante, punto_venta, numero, contraparte, cuit_contraparte,
         neto, iva, total)
      SELECT v.id, v.cliente_id, c.cuit, v.tipo, v.fecha, v.codigo_comprobante,
             v.tipo_comprobante, v.punto_venta, v.numero, v.contraparte,
             v.cuit_contraparte, v.neto, v.iva, v.total
        FROM arca_comprobantes_sin_contribuyente v
        JOIN arca_clientes c ON c.id = v.cliente_id;

      DROP TABLE arca_comprobantes_sin_contribuyente;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Agrega el contribuyente a las notificaciones del DFE.
 *
 * El backfill toma el CUIT del cliente y es EXACTO, no una aproximacion: hasta
 * esta version el worker leia unicamente el buzon del titular —nunca el de un
 * representado—, asi que toda fila existente es suya. Cuando el worker empiece
 * a recorrer representados, las nuevas ya vienen con su CUIT propio.
 */
function migrarNotificacionesConContribuyente(db: DatabaseSync): void {
  const columnas = db
    .prepare('PRAGMA table_info(arca_notificaciones)')
    .all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  // Sin esto, el RENAME reescribe la referencia en arca_notificacion_adjuntos
  // para que apunte a la tabla renombrada, y al dropearla queda colgada: la
  // base pasa `integrity_check` pero `foreign_key_check` acusa una violacion
  // por cada adjunto. Las migraciones anteriores no lo necesitaron porque
  // reconstruian tablas sin hijas.
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_notificaciones RENAME TO arca_notificaciones_sin_contribuyente;

      CREATE TABLE arca_notificaciones (
        id                 TEXT PRIMARY KEY,
        cliente_id         TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        contribuyente_cuit TEXT NOT NULL,
        id_comunicacion    TEXT NOT NULL,
        fecha              TEXT NOT NULL,
        organismo          TEXT NOT NULL,
        asunto             TEXT NOT NULL,
        leida              INTEGER NOT NULL DEFAULT 0,
        vista_app_en       TEXT,
        leido_app_en       TEXT,
        cuerpo             TEXT,
        UNIQUE (cliente_id, contribuyente_cuit, id_comunicacion)
      );

      INSERT INTO arca_notificaciones
        (id, cliente_id, contribuyente_cuit, id_comunicacion, fecha, organismo,
         asunto, leida, vista_app_en, leido_app_en, cuerpo)
      SELECT n.id, n.cliente_id, c.cuit, n.id_comunicacion, n.fecha, n.organismo,
             n.asunto, n.leida, n.vista_app_en, n.leido_app_en, n.cuerpo
        FROM arca_notificaciones_sin_contribuyente n
        JOIN arca_clientes c ON c.id = n.cliente_id;

      DROP TABLE arca_notificaciones_sin_contribuyente;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    // El pragma es de la CONEXION, y el repositorio la conserva mientras vive
    // el proceso: dejarlo encendido cambiaria el comportamiento de cualquier
    // ALTER posterior.
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Lo mismo para los planes de Mis Facilidades. Ver el comentario de arriba. */
function migrarPlanesConContribuyente(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_planes)').all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  // Igual que en notificaciones: sin esto arca_plan_cuotas queda apuntando a la
  // tabla renombrada y se rompen las 1891 cuotas.
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_planes RENAME TO arca_planes_sin_contribuyente;

      CREATE TABLE arca_planes (
        id                  TEXT PRIMARY KEY,
        cliente_id          TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        contribuyente_cuit  TEXT NOT NULL,
        numero              TEXT NOT NULL,
        concepto            TEXT NOT NULL,
        fecha_presentacion  TEXT,
        fecha_consolidacion TEXT,
        tipo_plan           TEXT NOT NULL DEFAULT '',
        monto_consolidado   REAL NOT NULL DEFAULT 0,
        estado              TEXT NOT NULL DEFAULT '',
        situacion           TEXT NOT NULL DEFAULT '',
        cuotas_totales      INTEGER NOT NULL,
        cuotas_pagas        INTEGER NOT NULL,
        cuotas_impagas      INTEGER NOT NULL,
        monto_cuota         REAL NOT NULL,
        proximo_vencimiento TEXT,
        total_pagado        REAL NOT NULL DEFAULT 0,
        leido_app_en        TEXT,
        UNIQUE (cliente_id, contribuyente_cuit, numero)
      );

      INSERT INTO arca_planes
        (id, cliente_id, contribuyente_cuit, numero, concepto, fecha_presentacion,
         fecha_consolidacion, tipo_plan, monto_consolidado, estado, situacion,
         cuotas_totales, cuotas_pagas, cuotas_impagas, monto_cuota,
         proximo_vencimiento, total_pagado, leido_app_en)
      SELECT p.id, p.cliente_id, c.cuit, p.numero, p.concepto, p.fecha_presentacion,
             p.fecha_consolidacion, p.tipo_plan, p.monto_consolidado, p.estado, p.situacion,
             p.cuotas_totales, p.cuotas_pagas, p.cuotas_impagas, p.monto_cuota,
             p.proximo_vencimiento, p.total_pagado, p.leido_app_en
        FROM arca_planes_sin_contribuyente p
        JOIN arca_clientes c ON c.id = p.cliente_id;

      DROP TABLE arca_planes_sin_contribuyente;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrarSaldosConContribuyente(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_saldos)').all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_saldos RENAME TO arca_saldos_sin_contribuyente;

      CREATE TABLE arca_saldos (
        cliente_id           TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        contribuyente_cuit   TEXT NOT NULL,
        establecimiento      TEXT NOT NULL DEFAULT '',
        impuesto             TEXT NOT NULL,
        concepto             TEXT NOT NULL DEFAULT '',
        subconcepto          TEXT NOT NULL DEFAULT '',
        periodo              TEXT NOT NULL,
        anticipo_cuota       TEXT NOT NULL DEFAULT '',
        fecha_vencimiento    TEXT NOT NULL DEFAULT '',
        saldo                REAL NOT NULL,
        interes_resarcitorio REAL NOT NULL DEFAULT 0,
        interes_punitorio    REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (
          cliente_id, contribuyente_cuit, establecimiento, impuesto, concepto,
          subconcepto, periodo, anticipo_cuota, fecha_vencimiento
        )
      );

      INSERT INTO arca_saldos
        (cliente_id, contribuyente_cuit, establecimiento, impuesto, concepto,
         subconcepto, periodo, anticipo_cuota, fecha_vencimiento, saldo,
         interes_resarcitorio, interes_punitorio)
      SELECT s.cliente_id, c.cuit, s.establecimiento, s.impuesto, s.concepto,
             s.subconcepto, s.periodo, s.anticipo_cuota, s.fecha_vencimiento,
             s.saldo, s.interes_resarcitorio, s.interes_punitorio
        FROM arca_saldos_sin_contribuyente s
        JOIN arca_clientes c ON c.id = s.cliente_id;

      DROP TABLE arca_saldos_sin_contribuyente;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrarVencimientosConContribuyente(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_vencimientos)').all() as Array<{
    name: string;
  }>;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_vencimientos RENAME TO arca_vencimientos_sin_contribuyente;

      CREATE TABLE arca_vencimientos (
        id                  TEXT PRIMARY KEY,
        cliente_id          TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        contribuyente_cuit  TEXT NOT NULL,
        impuesto            TEXT NOT NULL,
        concepto            TEXT NOT NULL DEFAULT '',
        subconcepto         TEXT NOT NULL DEFAULT '',
        periodo             TEXT NOT NULL,
        anticipo_cuota      TEXT NOT NULL DEFAULT '',
        fecha               TEXT NOT NULL,
        detalle             TEXT NOT NULL DEFAULT '',
        UNIQUE (
          cliente_id, contribuyente_cuit, impuesto, concepto, subconcepto,
          periodo, anticipo_cuota, fecha, detalle
        )
      );

      INSERT INTO arca_vencimientos
        (id, cliente_id, contribuyente_cuit, impuesto, concepto, subconcepto,
         periodo, anticipo_cuota, fecha, detalle)
      SELECT v.id, v.cliente_id, c.cuit, v.impuesto, v.concepto, v.subconcepto,
             v.periodo, v.anticipo_cuota, v.fecha, v.detalle
        FROM arca_vencimientos_sin_contribuyente v
        JOIN arca_clientes c ON c.id = v.cliente_id;

      DROP TABLE arca_vencimientos_sin_contribuyente;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function asegurarColumnasUsuarios(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_users)').all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'limite_clientes')) return;

  db.exec(
    'ALTER TABLE arca_users ADD COLUMN limite_clientes INTEGER CHECK (limite_clientes IS NULL OR limite_clientes >= 0)',
  );
  // Las cuentas comunes existentes conservan margen sobre sus clientes actuales.
  // Los administradores quedan sin límite para su panel propio.
  db.exec(`
    UPDATE arca_users
       SET limite_clientes = CASE
         WHEN rol = 'admin' THEN NULL
         ELSE MAX(5, (
           SELECT COUNT(*) FROM arca_user_clientes uc WHERE uc.usuario_id = arca_users.id
         ))
       END;
  `);
}

function asegurarColumnasNotificaciones(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_notificaciones)').all() as Array<{
    name: string;
  }>;
  const nombres = new Set(columnas.map((columna) => columna.name));
  if (!nombres.has('vista_app_en')) {
    db.exec('ALTER TABLE arca_notificaciones ADD COLUMN vista_app_en TEXT');
  }
  if (!nombres.has('leido_app_en')) {
    // Columna nueva y deliberadamente sin backfill: todos los registros que
    // ya existian empiezan como "No leido" en el sistema local.
    db.exec('ALTER TABLE arca_notificaciones ADD COLUMN leido_app_en TEXT');
  }
  if (!nombres.has('cuerpo')) {
    db.exec('ALTER TABLE arca_notificaciones ADD COLUMN cuerpo TEXT');
  }
}

function migrarVencimientosDetallados(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_vencimientos)').all() as Array<{
    name: string;
  }>;
  if (columnas.some((columna) => columna.name === 'concepto')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_vencimientos RENAME TO arca_vencimientos_legacy;

      CREATE TABLE arca_vencimientos (
        id             TEXT PRIMARY KEY,
        cliente_id     TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        impuesto       TEXT NOT NULL,
        concepto       TEXT NOT NULL DEFAULT '',
        subconcepto    TEXT NOT NULL DEFAULT '',
        periodo        TEXT NOT NULL,
        anticipo_cuota TEXT NOT NULL DEFAULT '',
        fecha          TEXT NOT NULL,
        detalle        TEXT NOT NULL DEFAULT '',
        UNIQUE (
          cliente_id, impuesto, concepto, subconcepto,
          periodo, anticipo_cuota, fecha, detalle
        )
      );

      INSERT INTO arca_vencimientos
        (id, cliente_id, impuesto, concepto, subconcepto,
         periodo, anticipo_cuota, fecha, detalle)
      SELECT id, cliente_id, impuesto, '', '', periodo, '', fecha, ''
        FROM arca_vencimientos_legacy;

      DROP TABLE arca_vencimientos_legacy;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrarSaldosDetallados(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_saldos)').all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'concepto')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_saldos RENAME TO arca_saldos_legacy;

      CREATE TABLE arca_saldos (
        cliente_id           TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        establecimiento      TEXT NOT NULL DEFAULT '',
        impuesto             TEXT NOT NULL,
        concepto             TEXT NOT NULL DEFAULT '',
        subconcepto          TEXT NOT NULL DEFAULT '',
        periodo              TEXT NOT NULL,
        anticipo_cuota       TEXT NOT NULL DEFAULT '',
        fecha_vencimiento    TEXT NOT NULL DEFAULT '',
        saldo                REAL NOT NULL,
        interes_resarcitorio REAL NOT NULL DEFAULT 0,
        interes_punitorio    REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (
          cliente_id, establecimiento, impuesto, concepto, subconcepto,
          periodo, anticipo_cuota, fecha_vencimiento
        )
      );

      INSERT INTO arca_saldos
        (cliente_id, establecimiento, impuesto, concepto, subconcepto,
         periodo, anticipo_cuota, fecha_vencimiento, saldo,
         interes_resarcitorio, interes_punitorio)
      SELECT cliente_id, '', impuesto, '', '', periodo, '', '', saldo, 0, 0
        FROM arca_saldos_legacy;

      DROP TABLE arca_saldos_legacy;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function asegurarColumnasPlanes(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_planes)').all() as Array<{ name: string }>;
  const nombres = new Set(columnas.map((c) => c.name));
  const faltantes: Array<[string, string]> = [
    ['fecha_presentacion', 'TEXT'],
    ['fecha_consolidacion', 'TEXT'],
    ['tipo_plan', "TEXT NOT NULL DEFAULT ''"],
    ['monto_consolidado', 'REAL NOT NULL DEFAULT 0'],
    ['estado', "TEXT NOT NULL DEFAULT ''"],
    ['situacion', "TEXT NOT NULL DEFAULT ''"],
    ['total_pagado', 'REAL NOT NULL DEFAULT 0'],
    ['leido_app_en', 'TEXT'],
  ];
  for (const [nombre, definicion] of faltantes) {
    if (!nombres.has(nombre)) db.exec(`ALTER TABLE arca_planes ADD COLUMN ${nombre} ${definicion}`);
  }
}

/** Retira de bases ya sembradas el ultimo texto visible del flujo de PDF. */
function limpiarDetalleAutorizacionAnterior(db: DatabaseSync): void {
  db.prepare(
    `UPDATE arca_clientes
        SET detalle_sync = 'Falta cargar el acceso ARCA del cliente.'
      WHERE detalle_sync LIKE '%autorizaci%n%'`,
  ).run();
}

function asegurarColumnasJobs(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_sync_jobs)').all() as Array<{ name: string }>;
  const nombres = new Set(columnas.map((c) => c.name));
  if (!nombres.has('iniciado_en')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN iniciado_en TEXT');
  }
  if (!nombres.has('finalizado_en')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN finalizado_en TEXT');
  }
  if (!nombres.has('progreso_actual')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN progreso_actual INTEGER NOT NULL DEFAULT 0');
  }
  if (!nombres.has('progreso_total')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN progreso_total INTEGER NOT NULL DEFAULT 1');
  }
  if (!nombres.has('paso_actual')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN paso_actual TEXT');
  }
  if (!nombres.has('worker_id')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN worker_id TEXT');
  }
  if (!nombres.has('heartbeat_en')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN heartbeat_en TEXT');
  }
  if (!nombres.has('lease_hasta')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN lease_hasta TEXT');
  }
  if (!nombres.has('disponible_desde')) {
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN disponible_desde TEXT');
  }
  if (!nombres.has('solicitud_id')) {
    // Sin REFERENCES: ALTER TABLE ADD COLUMN no admite una clave foranea con
    // filas ya existentes. El borrado en cascada de las bases nuevas lo cubre
    // el esquema; acá alcanza con que la columna exista y quede en NULL, que
    // es lo que hace que el job siga siendo una sincronización comun.
    db.exec('ALTER TABLE arca_sync_jobs ADD COLUMN solicitud_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_jobs_disponibles
      ON arca_sync_jobs (estado, disponible_desde, creado_en)
  `);
}

function migrarComprobantesConCodigo(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_comprobantes)').all() as Array<{
    name: string;
  }>;
  if (columnas.some((c) => c.name === 'codigo_comprobante')) return;

  // SQLite no permite reemplazar el UNIQUE de una tabla. Se reconstruye y se
  // copian los datos, derivando el codigo para los tipos que usaba la demo.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_comprobantes RENAME TO arca_comprobantes_legacy;

      CREATE TABLE arca_comprobantes (
        id                 TEXT PRIMARY KEY,
        cliente_id         TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
        tipo               TEXT NOT NULL CHECK (tipo IN ('EMITIDO', 'RECIBIDO')),
        fecha              TEXT NOT NULL,
        codigo_comprobante INTEGER NOT NULL,
        tipo_comprobante   TEXT NOT NULL,
        punto_venta        INTEGER NOT NULL,
        numero             INTEGER NOT NULL,
        contraparte        TEXT NOT NULL,
        cuit_contraparte   TEXT NOT NULL,
        neto               REAL NOT NULL,
        iva                REAL NOT NULL,
        total              REAL NOT NULL,
        UNIQUE (cliente_id, tipo, codigo_comprobante, punto_venta, numero)
      );

      INSERT INTO arca_comprobantes
        (id, cliente_id, tipo, fecha, codigo_comprobante, tipo_comprobante,
         punto_venta, numero, contraparte, cuit_contraparte, neto, iva, total)
      SELECT id, cliente_id, tipo, fecha,
        CASE tipo_comprobante
          WHEN 'Factura A' THEN 1
          WHEN 'Nota de Debito A' THEN 2
          WHEN 'Nota de Débito A' THEN 2
          WHEN 'Nota de Credito A' THEN 3
          WHEN 'Nota de Crédito A' THEN 3
          WHEN 'Factura B' THEN 6
          WHEN 'Nota de Debito B' THEN 7
          WHEN 'Nota de Débito B' THEN 7
          WHEN 'Nota de Credito B' THEN 8
          WHEN 'Nota de Crédito B' THEN 8
          WHEN 'Factura C' THEN 11
          WHEN 'Nota de Debito C' THEN 12
          WHEN 'Nota de Débito C' THEN 12
          WHEN 'Nota de Credito C' THEN 13
          WHEN 'Nota de Crédito C' THEN 13
          ELSE 0
        END,
        tipo_comprobante, punto_venta, numero, contraparte, cuit_contraparte,
        neto, iva, total
      FROM arca_comprobantes_legacy;

      DROP TABLE arca_comprobantes_legacy;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function asegurarUnSoloJobActivo(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Si una base anterior ya tenia duplicados, conserva el mas antiguo y
    // cierra los demas antes de crear el indice parcial.
    db.exec(`
      UPDATE arca_sync_jobs
         SET estado = 'ERROR',
             error = 'Job duplicado cancelado durante la migracion local.'
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY cliente_id, modulo, COALESCE(solicitud_id, '')
                    ORDER BY creado_en, id
                  ) AS orden
             FROM arca_sync_jobs
            WHERE estado IN ('PENDING', 'RUNNING')
         ) duplicados
         WHERE orden > 1
       );

      -- El indice viejo era (cliente_id, modulo) a secas. Eso alcanzaba
      -- mientras todos los jobs eran sincronizaciones, pero dos oficinas
      -- distintas pidiendo acceso a la misma empresa generan dos jobs
      -- 'verificar-acceso' del mismo cliente_id y chocaban entre si: la
      -- segunda solicitud moria con un error de constraint. Agregar el
      -- solicitud_id los separa sin aflojar la regla para el sync, donde la
      -- columna es NULL y COALESCE la vuelve la cadena vacia para todos.
      DROP INDEX IF EXISTS ux_jobs_cliente_modulo_activo;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_cliente_modulo_activo
        ON arca_sync_jobs (cliente_id, modulo, COALESCE(solicitud_id, ''))
        WHERE estado IN ('PENDING', 'RUNNING');
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Permite encolar un job apuntado a UNA empresa representada.
 *
 * La columna es nullable y NULL significa "toda la cuenta", que es el
 * comportamiento de siempre: por eso alcanza un ALTER y no hace falta
 * reconstruir la tabla.
 *
 * El indice tiene que incluirla o sincronizar la empresa A bloquearia encolar
 * la B de la misma cuenta, que no tienen nada que ver entre si. Que despues
 * corran de a una la garantiza `arca_sync_locks`, que serializa por cuenta
 * ARCA — esa es la proteccion real contra dos logins simultaneos, no el indice.
 */
function asegurarJobPorEmpresa(db: DatabaseSync): void {
  const columnas = db.prepare('PRAGMA table_info(arca_sync_jobs)').all() as Array<{ name: string }>;
  if (columnas.some((columna) => columna.name === 'contribuyente_cuit')) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE arca_sync_jobs ADD COLUMN contribuyente_cuit TEXT;

      DROP INDEX IF EXISTS ux_jobs_cliente_modulo_activo;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_cliente_modulo_activo
        ON arca_sync_jobs (
          cliente_id, modulo, COALESCE(solicitud_id, ''), COALESCE(contribuyente_cuit, '')
        )
        WHERE estado IN ('PENDING', 'RUNNING');
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
