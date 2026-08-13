# ArcaPanel local

Tablero local para administrar clientes y sincronizar **Mis Comprobantes**,
**Mis Facilidades** y el **Domicilio Fiscal Electrónico** desde el portal de
ARCA. La version actual usa SQLite y tres procesos:

```text
arca-app  ->  arca-api  ->  arca-dev.db  <-  arca-worker  ->  portal ARCA
  React        Express        SQLite            Playwright
```

El recorrido implementado es:

```text
alta de cliente -> usuario CUIT + clave cifrados -> job
-> login ARCA -> selección exacta de CUIT -> parser -> SQLite -> detalle del cliente
```

## Alcance actual

- Alta y baja de clientes reales.
- Clave fiscal cifrada con AES-256-GCM y una DEK por cliente.
- Login de usuarios con JWT, aislamiento por cuenta y pausa inmediata de sesiones.
- Roles: cada usuario administra sus clientes; el administrador gestiona cuentas,
  cupos, contraseñas y pausas, además de conservar su propio panel fiscal.
- Cola SQLite con recuperación de jobs abandonados y progreso persistido por módulo.
- Sincronización completa en una sola sesión ARCA: DFE, Cuentas Tributarias
  con vencimientos, Mis Facilidades y Mis Comprobantes.
- Descarga de comprobantes emitidos y recibidos del anio calendario actual.
- Grafico anual de barras con cantidades e importes de emitidos y recibidos por mes.
- Parser del ZIP/CSV real de ARCA, incluyendo notas de credito con signo negativo.
- Persistencia idempotente: repetir un sync no duplica comprobantes.
- Mis Facilidades: Presentaciones -> Detalle -> Ver Pagos, con todos los planes
  y filas de cuotas (incluidos vencimientos alternativos de una misma cuota).
- Domicilio Fiscal Electrónico: selección exacta del representado, lectura del
  cuerpo, descarga local de adjuntos y estados Leída/Vista/Sin leer.
- Lectura local reversible en notificaciones y planes desplegables: al abrir
  quedan Leídos y pueden volver a marcarse como No leídos sin modificar ARCA.
- Sistema de Cuentas Tributarias: saldos detallados y vencimientos reales.

Azure SQL, Key Vault y despliegue quedan deliberadamente fuera del MVP local.

## Requisitos

- Windows y Node.js 24+.
- Chromium de Playwright instalado por `arca-worker`.
- Los servicios **Mis Comprobantes**, **Mis Facilidades** y **Domicilio Fiscal
  Electrónico** adheridos en la cuenta de ARCA.

## Preparacion inicial

Instalar cada modulo:

```powershell
cd C:\Dev\ArcaPanel\arca-api
npm install

cd C:\Dev\ArcaPanel\arca-app
npm install

cd C:\Dev\ArcaPanel\arca-worker
npm install
```

Crear `arca-api\.env` a partir de `.env.example`. `JWT_SECRET` y `MASTER_KEY`
son obligatorios. Se pueden generar asi:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Configuracion local recomendada:

```dotenv
REPOSITORIO=sqlite
SQLITE_PATH=arca-dev.db
SEMBRAR_DEMO=1
```

Para una base nueva sin clientes ficticios, usar `SEMBRAR_DEMO=0` **antes del
primer arranque**. Cambiarlo despues no borra la semilla que ya exista.

El worker carga `MASTER_KEY` y `SQLITE_PATH` directamente desde
`arca-api\.env`; no hay que copiar la clave maestra a otro archivo.

## Levantar la aplicacion

Desde `C:\Dev\ArcaPanel`, abrir tres terminales:

```powershell
npm run dev:api
```

```powershell
npm run dev:app
```

```powershell
npm run dev:worker
```

- API: <http://localhost:3001>
- Front: <http://localhost:5173>

Usuarios sembrados, contraseña `demo`:

| Email | Rol |
|---|---|
| `bruno@fisterra.com` | admin |
| `ayudante@fisterra.com` | user |

## Cuentas y roles

- **Usuario:** puede dar de alta sus clientes, cargar accesos ARCA y usar
  todas las sincronizaciones y consultas. Su alta se detiene cuando alcanza el
  cupo configurado. Si el límite se reduce por debajo de sus clientes activos,
  conserva las asignaciones pero queda bloqueado todo el acceso fiscal: sólo
  puede abrir **Clientes** hasta que un administrador regularice su cartera.
- **Administrador:** tiene sus propios clientes y, además, la sección
  **Usuarios** para crear cuentas, cambiar nombre o contraseña, definir cupos y
  pausar o reactivar accesos. También es el único que puede quitar empresas de
  una cuenta, evitando que un usuario reutilice el cupo mediante rotación. Una
  pausa invalida también las sesiones abiertas.
- Si un cliente está compartido, el administrador puede quitarlo de una cuenta conservando la información
  para las demás. Sólo se elimina definitivamente al desaparecer la última asignación.

## Cliente ficticio para demostraciones

Para grabar videos o hacer capturas sin mostrar datos fiscales reales, se puede
crear una cuenta local aislada con información ficticia completa:

```powershell
npm run demo:crear
```

El comando es idempotente: vuelve a generar solamente `Estancias del Sur S.A. · DEMO`
y no toca los clientes reales. También habilita el acceso local
`demo@fisterra.com` / `demo`, que ve exclusivamente esa empresa. La cuenta no
tiene credencial ARCA, por lo que los botones de sincronización quedan
deshabilitados hasta que alguien cargue un acceso deliberadamente.

## Sincronizar un cliente real

1. Entrar con una cuenta activa y abrir **Clientes**.
2. Crear el cliente con CUIT y razon social.
3. Guardar el usuario ARCA (CUIT) y la clave fiscal. Ambos quedan cifrados y no vuelven a mostrarse.
4. Pulsar **Sincronizar todos los servicios** en Clientes o al inicio del detalle.
5. En el detalle del cliente, usar **Actualizar desde ARCA** dentro de
   **Mis Facilidades** para traer presentaciones y pagos.
6. Usar **Actualizar y abrir en ARCA** dentro de **Domicilio Fiscal
   Electrónico** para traer bandeja, cuerpos y adjuntos. Esta consulta abre las
   comunicaciones pendientes y ARCA pasa a considerarlas leídas. Por seguridad
   requiere además `DFE_ABRIR_NO_LEIDAS=1` en `arca-worker\.env`.
7. Dejar `npm run dev:worker` ejecutandose, o procesar exactamente un job con:

```powershell
npm run worker:once
```

Los botones individuales siguen disponibles para reintentos puntuales. La
sincronización completa procesa los cuatro módulos secuencialmente reutilizando
el mismo login y muestra su progreso en la app. Para Mis Facilidades solo
abre pantallas de consulta: selecciona el CUIT, entra a Detalle y Ver Pagos; no
crea ni modifica presentaciones. El worker usa Chromium oculto por defecto. Si
ARCA pide CAPTCHA o segundo factor, `WORKER_HEADED=1` permite reiniciarlo con el
navegador visible para intervencion humana.

Si el usuario ARCA representa a varias personas, el worker elige
automaticamente la opcion cuyo CUIT coincide con el cliente cargado en el
panel. Nunca selecciona por posicion ni por razon social.

Por defecto sincroniza desde el 1 de enero del anio actual hasta hoy, tomando
la fecha de `America/Buenos_Aires`. Para una recuperacion historica puntual,
configurar ambos
valores en `arca-worker\.env`:

```dotenv
SYNC_DESDE=2026-01-01
SYNC_HASTA=2026-08-04
```

ARCA admite hasta 365 dias inclusivos por exportacion. El worker divide
automaticamente el anio cuando sea necesario (por ejemplo, el ultimo dia de un
anio bisiesto) sin perder ni repetir fechas.

## Verificaciones

Chequeo completo de TypeScript, tests y build del front:

```powershell
npm run check
```

Validar que el worker encuentra la configuracion y la base, sin tomar jobs ni
contactar ARCA:

```powershell
npm run worker:check
```

Smoke test publico de selectores del login, sin credenciales:

```powershell
cd arca-worker
npm run probe
```

## Persistencia y migraciones

SQLite se migra automaticamente al abrir la API o el worker. No hace falta
borrar la base al cambiar el esquema. El acceso concurrente usa WAL y un
`busy_timeout` para que API y worker puedan compartir el archivo.

Antes de una migracion relevante conviene copiar el `.db`. Los backups con
extension `.db.bak` tambien estan ignorados por Git.

## Archivos sensibles

Nunca compartir ni versionar:

- `arca-api\.env`: contiene la clave maestra.
- `*.db`: contiene datos fiscales y credenciales cifradas.
- `arca-worker\.sessions\`: permite acceder a cuentas ARCA.
- `arca-worker\.artifacts\`: contiene HTML, capturas y comprobantes reales.

Los directorios ya estan cubiertos por `.gitignore`, pero siguen siendo datos
sensibles en el disco local.

## Reacciones ante errores de ARCA

| Codigo | Reaccion |
|---|---|
| `CLAVE_INCORRECTA` | Frenar; no reintentar para evitar bloqueo |
| `CLAVE_BLOQUEADA` | Marcar la credencial y pedir desbloqueo |
| `CLAVE_VENCIDA` | Requiere cambio manual |
| `CAPTCHA_PRESENTE` / `SEGUNDO_FACTOR` | Requiere intervencion humana |
| `SERVICIO_NO_ADHERIDO` | Adherir el servicio solicitado manualmente |
| `REPRESENTADO_NO_DISPONIBLE` | Revisar que el usuario pueda representar el CUIT del cliente |
| `PORTAL_NO_DISPONIBLE` / `TIMEOUT` | El job queda en error y puede reencolarse |
| `SELECTOR_NO_ENCONTRADO` | Revisar artifacts y `selectors.ts` |

El worker nunca adhiere servicios, evita CAPTCHA ni reintenta automaticamente
una clave incorrecta.

## Varios workers en local

La cola admite varios procesos worker sobre la misma base SQLite. Cada proceso
toma un job de forma atomica, mantiene un lease con heartbeat y reserva la
cuenta ARCA mediante un identificador HMAC que no revela el CUIT de acceso.

Esto permite sincronizar en paralelo cuentas ARCA distintas. Si dos clientes
usan la misma cuenta de acceso —por ejemplo, varias empresas delegadas a un
mismo contador— el segundo job vuelve a la cola hasta que el primero libera la
cuenta. El popup muestra ese estado.

Para probarlo sin Docker, abrir dos o mas terminales y ejecutar en cada una:

```powershell
npm run dev:worker
```

Variables disponibles en `arca-worker/.env`:

- `WORKER_LEASE_SECONDS`: vencimiento de propiedad del job, por defecto 120.
- `WORKER_HEARTBEAT_SECONDS`: renovacion del lease, por defecto 30.
- `WORKER_ACCOUNT_WAIT_SECONDS`: espera antes de reintentar una cuenta ocupada.

## Contenedores locales con configuracion de produccion

El compose conserva SQLite, sesiones, artifacts y certificados en volumenes
Docker separados. Sirve para validar el despliegue antes de contratar un VPS.

```powershell
Copy-Item .env.production.example .env.production
# Completar JWT_SECRET y MASTER_KEY antes de continuar.
docker compose --env-file .env.production -f compose.production.yml build
docker compose --env-file .env.production -f compose.production.yml up -d --scale worker=4
```

La app queda en `http://localhost`. Para revisar salud y actividad:

```powershell
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f api worker
```

Detener los contenedores no borra los volumenes:

```powershell
docker compose --env-file .env.production -f compose.production.yml down
```

No usar `down -v` con datos reales: elimina la base, sesiones, artifacts y
certificados almacenados en los volumenes.
