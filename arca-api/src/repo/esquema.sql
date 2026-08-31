-- Esquema de ArcaPanel (dialecto SQLite).
--
-- Diseñado para mapear 1:1 a Azure SQL: mismas tablas, mismas columnas, mismos
-- constraints. Al portar a T-SQL sólo cambian los tipos:
--
--   TEXT (id, uuid)      -> UNIQUEIDENTIFIER  o NVARCHAR(36)
--   TEXT (texto libre)   -> NVARCHAR(n)
--   TEXT (fecha ISO)     -> DATETIME2  /  DATE
--   INTEGER (booleano)   -> BIT
--   REAL (importes)      -> DECIMAL(18,2)   <-- IMPORTANTE, ver abajo
--
-- Sobre los importes: acá van en REAL porque SQLite no tiene decimal. En Azure
-- SQL tienen que ser DECIMAL(18,2). Guardar plata en punto flotante acumula
-- error de redondeo, y estos números son saldos fiscales.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS arca_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('admin', 'user')),
  password_hash TEXT NOT NULL,
  activo        INTEGER NOT NULL DEFAULT 1,
  limite_clientes INTEGER CHECK (limite_clientes IS NULL OR limite_clientes >= 0)
);

CREATE TABLE IF NOT EXISTS arca_clientes (
  id                    TEXT PRIMARY KEY,
  cuit                  TEXT NOT NULL UNIQUE,
  razon_social          TEXT NOT NULL,
  estado_credencial     TEXT NOT NULL,
  estado_sync           TEXT NOT NULL,
  ultimo_sync           TEXT,
  detalle_sync          TEXT,
  credencial_cargada_en TEXT
);

-- Qué usuario ve qué cliente. Es la tabla que hace posible el aislamiento
-- multi-tenant: sin una fila acá, el cliente no existe para ese usuario.
CREATE TABLE IF NOT EXISTS arca_user_clientes (
  usuario_id TEXT NOT NULL REFERENCES arca_users(id)    ON DELETE CASCADE,
  cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, cliente_id)
);

-- Las claves fiscales, cifradas con envelope encryption (ver crypto/envelope.ts).
-- Nunca se guarda nada en claro. El ON DELETE CASCADE es deliberado: dar de
-- baja un cliente tiene que llevarse su credencial, no dejarla huérfana.
CREATE TABLE IF NOT EXISTS arca_credenciales (
  cliente_id     TEXT PRIMARY KEY REFERENCES arca_clientes(id) ON DELETE CASCADE,
  ciphertext     TEXT NOT NULL,
  iv             TEXT NOT NULL,
  auth_tag       TEXT NOT NULL,
  dek_envuelta   TEXT NOT NULL,
  dek_iv         TEXT NOT NULL,
  dek_auth_tag   TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arca_notificaciones (
  id              TEXT PRIMARY KEY,
  cliente_id      TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  id_comunicacion TEXT NOT NULL,
  fecha           TEXT NOT NULL,
  organismo       TEXT NOT NULL,
  asunto          TEXT NOT NULL,
  leida           INTEGER NOT NULL DEFAULT 0,
  vista_app_en    TEXT,
  leido_app_en    TEXT,
  cuerpo          TEXT,
  -- Clave natural de ARCA: hace idempotente el sync de notificaciones.
  UNIQUE (cliente_id, id_comunicacion)
);

CREATE TABLE IF NOT EXISTS arca_notificacion_adjuntos (
  id              TEXT PRIMARY KEY,
  notificacion_id TEXT NOT NULL REFERENCES arca_notificaciones(id) ON DELETE CASCADE,
  id_archivo      TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  tamano          INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  contenido       BLOB NOT NULL,
  UNIQUE (notificacion_id, id_archivo)
);

CREATE TABLE IF NOT EXISTS arca_saldos (
  cliente_id          TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  contribuyente_cuit  TEXT NOT NULL,
  establecimiento     TEXT NOT NULL DEFAULT '',
  impuesto            TEXT NOT NULL,
  concepto            TEXT NOT NULL DEFAULT '',
  subconcepto         TEXT NOT NULL DEFAULT '',
  periodo             TEXT NOT NULL,
  anticipo_cuota      TEXT NOT NULL DEFAULT '',
  fecha_vencimiento   TEXT NOT NULL DEFAULT '',
  saldo               REAL NOT NULL,
  interes_resarcitorio REAL NOT NULL DEFAULT 0,
  interes_punitorio    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (
    cliente_id, contribuyente_cuit, establecimiento, impuesto, concepto, subconcepto,
    periodo, anticipo_cuota, fecha_vencimiento
  )
);

CREATE TABLE IF NOT EXISTS arca_planes (
  id                  TEXT PRIMARY KEY,
  cliente_id          TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
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
  UNIQUE (cliente_id, numero)
);

CREATE TABLE IF NOT EXISTS arca_plan_cuotas (
  id                    TEXT PRIMARY KEY,
  plan_id               TEXT NOT NULL REFERENCES arca_planes(id) ON DELETE CASCADE,
  numero                INTEGER NOT NULL,
  variante              INTEGER NOT NULL,
  capital               REAL NOT NULL,
  interes_financiero    REAL NOT NULL,
  interes_resarcitorio  REAL NOT NULL,
  total                 REAL NOT NULL,
  fecha_vencimiento     TEXT,
  pago                  TEXT NOT NULL DEFAULT '',
  estado                TEXT NOT NULL DEFAULT '',
  UNIQUE (plan_id, numero, variante)
);

CREATE TABLE IF NOT EXISTS arca_vencimientos (
  id              TEXT PRIMARY KEY,
  cliente_id      TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  contribuyente_cuit TEXT NOT NULL,
  impuesto        TEXT NOT NULL,
  concepto        TEXT NOT NULL DEFAULT '',
  subconcepto     TEXT NOT NULL DEFAULT '',
  periodo         TEXT NOT NULL,
  anticipo_cuota  TEXT NOT NULL DEFAULT '',
  fecha           TEXT NOT NULL,
  detalle         TEXT NOT NULL DEFAULT '',
  UNIQUE (
    cliente_id, contribuyente_cuit, impuesto, concepto, subconcepto,
    periodo, anticipo_cuota, fecha, detalle
  )
);

CREATE TABLE IF NOT EXISTS arca_ddjj_pendientes (
  id                  TEXT PRIMARY KEY,
  cliente_id          TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  contribuyente_cuit  TEXT NOT NULL,
  establecimiento     TEXT NOT NULL DEFAULT '',
  impuesto            TEXT NOT NULL,
  concepto            TEXT NOT NULL DEFAULT '',
  subconcepto         TEXT NOT NULL DEFAULT '',
  periodo             TEXT NOT NULL,
  fecha               TEXT NOT NULL DEFAULT '',
  UNIQUE (
    cliente_id, contribuyente_cuit, establecimiento, impuesto,
    concepto, subconcepto, periodo, fecha
  )
);

CREATE TABLE IF NOT EXISTS arca_comprobantes (
  id                TEXT PRIMARY KEY,
  cliente_id        TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  -- CUIT del contribuyente al que pertenece el comprobante. Una misma clave
  -- fiscal puede actuar por varios, igual que en Cuentas Tributarias, y cada
  -- uno tiene su propia numeracion de comprobantes.
  contribuyente_cuit TEXT NOT NULL,
  tipo              TEXT NOT NULL CHECK (tipo IN ('EMITIDO', 'RECIBIDO')),
  fecha             TEXT NOT NULL,
  -- Código numérico de ARCA (1 = Factura A, 6 = Factura B, 11 = Factura C...).
  codigo_comprobante INTEGER NOT NULL,
  -- Nombre legible, DERIVADO del código. Sólo para mostrar.
  tipo_comprobante  TEXT NOT NULL,
  punto_venta       INTEGER NOT NULL,
  numero            INTEGER NOT NULL,
  contraparte       TEXT NOT NULL,
  cuit_contraparte  TEXT NOT NULL,
  -- Importes SIGNADOS: las notas de crédito van en negativo (ARCA las exporta
  -- en positivo y el parser les invierte el signo). Así un SUM da el neto real.
  neto              REAL NOT NULL,
  iva               REAL NOT NULL,
  total             REAL NOT NULL,
  -- Lo que hace idempotente el sync. Va como CONSTRAINT y no como chequeo en
  -- código: dos jobs corriendo a la vez se pisarían igual.
  --
  -- Usa el CÓDIGO y no el nombre a propósito. Con el nombre adentro, corregir
  -- una etiqueta de la tabla de códigos convertía a cada comprobante ya
  -- guardado en uno "nuevo", y el sync siguiente los duplicaba todos.
  --
  -- `contribuyente_cuit` va adentro porque cada contribuyente numera sus
  -- comprobantes por su cuenta: sin él, la Factura A 0001-00000001 de dos
  -- contribuyentes distintos colisiona y una pisa a la otra en silencio.
  UNIQUE (cliente_id, contribuyente_cuit, tipo, codigo_comprobante, punto_venta, numero)
);

CREATE TABLE IF NOT EXISTS arca_sync_jobs (
  id         TEXT PRIMARY KEY,
  cliente_id TEXT NOT NULL REFERENCES arca_clientes(id) ON DELETE CASCADE,
  modulo     TEXT NOT NULL,
  estado     TEXT NOT NULL,
  intentos   INTEGER NOT NULL DEFAULT 0,
  creado_en  TEXT NOT NULL,
  iniciado_en TEXT,
  finalizado_en TEXT,
  progreso_actual INTEGER NOT NULL DEFAULT 0,
  progreso_total INTEGER NOT NULL DEFAULT 1,
  paso_actual TEXT,
  error      TEXT,
  worker_id  TEXT,
  heartbeat_en TEXT,
  lease_hasta TEXT,
  disponible_desde TEXT
);

-- Razon social de los contribuyentes que aparecen agrupados en Cuentas
-- Tributarias. ARCA NO la informa: su desplegable de CUIT trae solo el numero,
-- verificado contra los artifacts guardados. Por eso se cargan a mano.
--
-- La clave son los 11 digitos sin guiones, para que la busqueda no dependa del
-- formato con que quedo guardado el CUIT en cada tabla.
--
-- No lleva cliente_id a proposito: un CUIT tiene UNA razon social, sin importar
-- desde que cliente se lo mire. Cargarlo una vez lo muestra en todo el panel.
CREATE TABLE IF NOT EXISTS arca_contribuyentes (
  cuit           TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Candados anonimos por CUIT de acceso ARCA. `clave` es un HMAC; nunca se
-- persiste el CUIT usado para iniciar sesion.
CREATE TABLE IF NOT EXISTS arca_sync_locks (
  clave       TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL UNIQUE REFERENCES arca_sync_jobs(id) ON DELETE CASCADE,
  worker_id   TEXT NOT NULL,
  lease_hasta TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_comprobantes_cliente_fecha
  ON arca_comprobantes (cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS ix_notificaciones_cliente_fecha
  ON arca_notificaciones (cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS ix_notificacion_adjuntos_notificacion
  ON arca_notificacion_adjuntos (notificacion_id);
CREATE INDEX IF NOT EXISTS ix_plan_cuotas_plan_numero
  ON arca_plan_cuotas (plan_id, numero, variante);
CREATE INDEX IF NOT EXISTS ix_jobs_estado
  ON arca_sync_jobs (estado, creado_en);
CREATE INDEX IF NOT EXISTS ix_sync_locks_lease
  ON arca_sync_locks (lease_hasta);
