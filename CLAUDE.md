# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Tablero local para estudios contables: administra clientes y sincroniza **Mis
Comprobantes**, **Mis Facilidades**, **Domicilio Fiscal Electrónico** y el
**Sistema de Cuentas Tributarias** desde el portal de ARCA (ex AFIP) mediante
scraping con Playwright.

El código, los comentarios y los identificadores están **en español**. Mantener
esa convención al escribir código nuevo.

## Comandos

Todo se corre desde la raíz `C:\Dev\ArcaPanel` (Windows, PowerShell, Node 24+).

```powershell
npm run check
```

`check` = `typecheck` (los tres módulos) + `test` (api y worker) + `build` (front).
Es el chequeo que hay que pasar antes de dar algo por terminado.

Otros scripts de raíz: `dev:api`, `dev:app`, `dev:worker`, `worker:once`
(procesa exactamente un job y sale), `worker:check` (valida config y base sin
tocar ARCA), `demo:crear` (cliente ficticio idempotente para demos).

Un solo archivo de test — `--test` de Node vía tsx, no hay Jest/Vitest:

```powershell
cd arca-api; npx tsx --test src/repo/planes.test.ts
```

Filtrar por nombre de test: agregar `--test-name-pattern "..."`.

Herramientas del worker contra el portal real (requieren `arca-worker\.env` con
credenciales propias): `npm run probe` (smoke test de selectores de login, sin
credenciales) y `npm run spike:*` (`login`, `facilidades`, `dfe`, `saldos`).

No hay linter configurado. El typecheck es estricto en los tres módulos
(`strict`, `noUncheckedIndexedAccess`, y `noUnusedLocals`/`noUnusedParameters`
en api y app).

## Arquitectura

```text
arca-app  ->  arca-api  ->  arca-dev.db  <-  arca-worker  ->  portal ARCA
  React        Express        SQLite            Playwright
```

**El archivo SQLite es la única interfaz entre la API y el worker.** No hay HTTP
entre ellos: la API encola jobs escribiendo en `arca_sync_jobs` y el worker los
toma de la misma base. Sólo el front habla HTTP.

### Acoplamiento worker → api

`arca-worker` importa **código fuente** de `arca-api` cruzando el límite de
módulo (`../../arca-api/src/repo/sqlite.js`, `.../repo/tipos.js`,
`.../crypto/envelope.js`). No es un paquete npm ni hay build: `tsx` ejecuta el TS
directo. Consecuencias:

- Cambiar `Repositorio`, `esquema.sql` o `envelope.ts` impacta en los dos
  procesos; hay que correr el typecheck de ambos.
- El worker lee `MASTER_KEY`, `REPOSITORIO` y `SQLITE_PATH` desde
  `arca-api\.env`, no del suyo (`ARCA_API_DIR` apunta ahí). El secreto no se
  duplica. `arca-worker\.env` sólo tiene lo específico del scraping.
- El worker abre el repositorio con `sembrar: false`: los datos demo los crea
  únicamente la API.

### `Repositorio` como frontera multi-tenant

`arca-api/src/repo/tipos.ts` es el contrato central y codifica el aislamiento:
**todo método de lectura de clientes recibe `usuarioId`**; no existe un
`obtenerCliente(id)` suelto. En SQLite eso se expresa como JOIN obligatorio con
`arca_user_clientes`.

Tres métodos son la excepción deliberada y **no deben ser alcanzables desde
ninguna ruta HTTP**: `tomarProximoJob`, `recuperarJobsInterrumpidos`,
`clienteParaSync` (más `leerCredencialCifrada`). Son del worker, que no actúa en
nombre de un usuario.

Hay dos implementaciones — `memoria.ts` y `sqlite.ts` — y el test
`src/http/aislamiento.test.ts` corre **contra las dos** vía la tabla `MOTORES`.
Al agregar un motor (p. ej. el `mssql.ts` pendiente) se suma ahí y queda cubierto.

En las rutas, `clienteVisible()` en `rutas/clientes.ts` es la barrera: toda ruta
con `:id` pasa por ella y devuelve 404 (no 403) para no confirmar que el id
existe.

### Credenciales

Envelope encryption en `crypto/envelope.ts`: cada clave fiscal se cifra con una
DEK propia (AES-256-GCM) y la DEK se guarda envuelta con `MASTER_KEY`. El sobre
contiene un JSON `{version: 2, usuarioCuit, clave}` — el CUIT con que se loguea
puede diferir del CUIT fiscal del cliente, y tampoco queda expuesto en la base.
Hay compatibilidad hacia atrás con el formato v1 (texto = sólo la clave).

`cargarClaveMaestra` es la única puerta de entrada de la maestra: migrar a Key
Vault toca ese archivo y ninguno más. El tipo `Cliente` no tiene ningún campo de
credencial —esa es la primera línea de defensa contra un `res.json(cliente)`
descuidado— y no existe endpoint que devuelva una credencial.

### Cola de jobs

- `tomarProximoJob` hace SELECT+UPDATE dentro de `BEGIN IMMEDIATE`. La
  atomicidad no es opcional: dos workers tomando el mismo job son dos logins
  simultáneos con la misma clave, que es justo lo que dispara el bloqueo de la
  cuenta en ARCA.
- Cada job RUNNING tiene `worker_id`, `heartbeat_en` y `lease_hasta`. Un worker
  sin propiedad no puede renovarlo ni cerrarlo; los leases vencidos se
  recuperan sin tocar trabajos vivos de otros procesos.
- `arca_sync_locks` serializa por **cuenta de acceso**, no por cliente. La clave
  es un HMAC de `usuarioCuit` con `MASTER_KEY`, de modo que empresas delegadas a
  una misma cuenta nunca abren dos sesiones ARCA simultaneas y el CUIT de login
  sigue sin aparecer en la base.
- Si el candado esta ocupado, `reencolarJob` posterga el job y el front muestra
  que esta esperando a otra sincronizacion de esa cuenta.
- Índice único parcial `ux_jobs_cliente_modulo_activo` sobre
  `(cliente_id, modulo) WHERE estado IN ('PENDING','RUNNING')`: un solo job
  activo por cliente y módulo.
- `finalizarJob` cierra el job **y** actualiza el cliente en la misma
  transacción, para que el tablero nunca muestre estados contradictorios.
- El módulo `sincronizacion-completa` corre los cuatro módulos secuencialmente
  reutilizando un único login, publicando progreso con `actualizarProgresoJob`.
  El front lo sigue con `esperarJob`, que hace polling de `/clientes/:id/jobs`.
- `recuperarJobsInterrumpidos` cierra los RUNNING cuyo lease vencio. Para jobs
  anteriores a esta migracion conserva el timeout historico por fecha de inicio.

### Idempotencia y migraciones

La unicidad de comprobantes es un `UNIQUE (cliente_id, tipo,
codigo_comprobante, punto_venta, numero)` **en la base**, no un chequeo en
código. Usa el código numérico de ARCA y no el nombre legible a propósito:
retocar una etiqueta de la tabla de códigos convertiría cada comprobante ya
guardado en uno "nuevo" y el sync siguiente los duplicaría todos.

`prepararEsquemaSqlite` (`repo/migraciones.ts`) corre al abrir la base, tanto en
la API como en el worker: nunca hace falta borrar el `.db` al cambiar el
esquema. Las migraciones incompatibles se hacen por reconstrucción de tabla, y
por eso `esquema.sql` se ejecuta dos veces (la reconstrucción se lleva los
índices). Concurrencia API/worker sobre el mismo archivo: WAL + `busy_timeout`.

Persistencia con `node:sqlite` (builtin de Node 24) — no hay `better-sqlite3`.
ESM en todos lados: los imports TS llevan extensión `.js` (`NodeNext`).

### Capa ARCA del worker

- **Todos** los selectores del portal viven en `src/arca/selectors.ts`. Cada
  campo es una lista de candidatos ordenada de específica a genérica que
  `primerSelectorVisible` prueba en orden. Cuando ARCA cambie el HTML se arregla
  ahí y en ningún otro lado.
- `src/arca/errors.ts` es la taxonomía de fallas: cada `ArcaErrorCode` tiene una
  `Reaccion` (`FRENAR_MARCAR_CREDENCIAL`, `NECESITA_HUMANO`, `REINTENTAR`,
  `REVISAR_SELECTORES`) y un mensaje para el contador. `resultadoDeError` en
  `index.ts` la traduce al estado del job y al `EstadoCredencial`. Un error
  genérico es lo que hace que un scraper reintente contra una clave incorrecta y
  bloquee la cuenta del cliente.
- `detectarError` matchea frases del portal normalizadas (minúsculas, sin
  acentos). Cuidado con frases genéricas: "administrador de relaciones" daba
  falso positivo en todo login exitoso.
- Ante una falla, `volcarEstado` guarda screenshot + HTML + URL en
  `.artifacts/`, incluidos los iframes (Cuentas Tributarias renderiza sus tablas
  dentro de uno).
- Las sesiones de Playwright se persisten por cliente en `.sessions/` y se
  reutilizan; si el storage state está corrupto, se borra y se reintenta limpio.

**Reglas que el worker no debe violar** (están implementadas, no las aflojes):
nunca resuelve CAPTCHA ni segundo factor, nunca adhiere un servicio, nunca
reintenta automáticamente una clave incorrecta, y elige al representado por
coincidencia **exacta de CUIT** — nunca por posición ni por razón social; si no
hay exactamente una opción, corta con `REPRESENTADO_NO_DISPONIBLE`.

Consultar el detalle de una comunicación del DFE la abre en ARCA y la
perfecciona legalmente. Por eso está detrás del opt-in `DFE_ABRIR_NO_LEIDAS=1`.

Rango de fechas: por defecto del 1 de enero al día de hoy en
`America/Buenos_Aires`. ARCA admite 365 días inclusivos por exportación, así que
`partirRangoParaArca` corta la ventana cuando hace falta (un año bisiesto tiene
366).

### Front

`src/api/client.ts` es la **única** parte del front que sabe de dónde vienen los
datos; las pantallas nunca hacen `fetch`. El token JWT vive en `localStorage` y
cualquier 401 dispara `onSesionExpirada` y vuelve al login.

`Protegida` en `App.tsx` y el escondido de secciones por rol son **cosméticos**:
la autorización real está en `requiereAuth`/`requiereAdmin` y en el middleware de
cupo de `rutas/clientes.ts`, que bloquea todo el acceso fiscal cuando un usuario
excede su límite de clientes.

Estilos: CSS plano en `styles.css` sobre tokens de marca en
`fisterra.tokens.css`. No hay librería de componentes ni CSS-in-JS.

### Tipos espejados

`arca-api/src/dominio/tipos.ts`, `arca-app/src/types.ts` y los códigos de
`arca-worker/src/arca/errors.ts` describen el mismo negocio en tres lugares a
propósito. Al cambiar un estado o un campo, actualizarlos juntos.

## Datos sensibles en disco

`arca-api\.env` (clave maestra), `*.db` (datos fiscales y credenciales
cifradas), `arca-worker\.sessions\` (acceso a cuentas ARCA) y
`arca-worker\.artifacts\` (HTML, capturas y comprobantes reales). Están en
`.gitignore`, pero no deben leerse ni volcarse a la conversación sin necesidad,
ni copiarse fuera del proyecto.

Antes de una migración de esquema relevante conviene copiar el `.db` (los
`.db.bak` también están ignorados).

## Despliegue

Pensado para una **sola VM Linux** (todo en `deploy/`): API, N workers y Caddy
en el mismo host. No es una limitación arbitraria — los tres procesos
comparten el archivo SQLite, y eso no tolera filesystems de red ni hosts
separados sin migrar antes a `mssql.ts`.

- `deploy/systemd/arca-api.service`, `arca-worker@.service` (plantilla:
  `Environment=WORKER_ID=worker-%i` resuelve un id único por instancia solo)
  y `arca-workers.target` para arrancar/parar todos los workers juntos.
  Todas las instancias comparten `WorkingDirectory` a propósito, para
  reutilizar `.sessions/` entre workers y no multiplicar logins contra ARCA.
- `deploy/Caddyfile`: TLS automático vía Let's Encrypt, sirve `arca-app/dist`,
  y hace reverse proxy de `/api/*` a `localhost:3001` (`handle_path` saca el
  prefijo, porque las rutas de Express son `/clientes`, no `/api/clientes`).
  El front se buildea con `VITE_API_URL=/api` — mismo origen, sin CORS. Agrega
  también las cabeceras de seguridad que la API no pone (no usa helmet).
- `deploy/scripts/mantenimiento.mjs` + `arca-mantenimiento.timer` (03:30):
  respalda la base con `VACUUM INTO` — nunca `cp`, la base está en WAL con
  API y workers escribiendo — y poda `.artifacts/` viejos. **Nunca** copia
  `arca-api\.env` junto al respaldo: si la maestra y la base cifrada con ella
  terminan en el mismo lugar, el envelope encryption deja de aportar nada.
- Detalle de instalación, permisos y troubleshooting (AppArmor/user
  namespaces con Chromium, por qué el worker no lleva
  `RestrictNamespaces=true`) en `deploy/README.md`.

**El techo de paralelismo real no es la RAM, es la cantidad de cuentas ARCA
distintas en cartera.** `arca_sync_locks` serializa por cuenta de acceso, no
por cliente: si todo está delegado a un único usuario ARCA, sumar workers no
acelera nada, compiten por el mismo candado y se reencolan. La exclusión mutua
entre varios workers sobre el mismo archivo está cubierta por
`src/repo/cola-concurrencia.test.ts` en `arca-api`.

## Fuera de alcance del MVP

Azure SQL (`REPOSITORIO=mssql` lanza error a propósito) y Key Vault. El código
está escrito para que esas piezas entren después sin rediseño —
`tomarProximoJob` en `sqlite.ts` ya trae en un comentario el `UPDATE TOP(1)
... WITH (READPAST, UPDLOCK)` equivalente en T-SQL—; no introducir
dependencias que lo compliquen.

## Modo orquestador (autorizado por defecto)

En este repositorio Claude trabaja **delegando por defecto**: no hace falta
pedírselo turno a turno. El hilo principal decide, delega y sintetiza; el
trabajo pesado de lectura y escritura va en subagentes con contexto propio.

Umbrales (los generales viven en el `CLAUDE.md` global; acá van los de este
repo):

- Decidir o verificar sobre 1–3 archivos: inline.
- Entender algo que abarca 4+ archivos: un subagente de exploración, que
  devuelve un resumen corto y no el volcado de los archivos.
- Escribir 2+ archivos no triviales: **un solo** subagente escritor.
- Cambios mecánicos ya entendidos en un archivo: inline. Delegarlos cuesta
  más de lo que ahorran.

Delegar **grueso, no seguido**: cada subagente arranca en frío y no hereda el
contexto del padre. Diez delegaciones de un archivo son diez arranques en
frío; una de diez archivos es uno.

### Por qué acá no van escritores en paralelo

`arca-worker` importa código fuente de `arca-api` cruzando el límite de
módulo. Eso hace que estos cambios sean intrínsecamente cross-module y que
partirlos entre agentes concurrentes rompa el typecheck de ambos lados:

- `repo/tipos.ts`, `repo/sqlite.ts`, `esquema.sql`, `crypto/envelope.ts`.
- Los tipos espejados en `arca-api/src/dominio/tipos.ts`,
  `arca-app/src/types.ts` y `arca-worker/src/arca/errors.ts`.

Todo eso va en un único escritor, que cierra corriendo `npm run check` (que
ya cubre el typecheck de los tres módulos). Worktrees aislados solo con
aprobación explícita, y nunca para trabajo que toque esos archivos.
