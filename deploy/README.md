# Despliegue

Dos caminos para el mismo resultado — API, N workers y Caddy en **un solo
host**. Los tres procesos comparten el archivo SQLite, asi que tienen que estar
en la misma maquina; repartirlos entre varios hosts requiere primero
`repo/mssql.ts`.

- **[Servidor nuevo con Docker Compose](#servidor-nuevo-desde-github)** — el
  camino habitual: clonar de GitHub y levantar. Sirve igual en Windows y Linux.
- **Unidades systemd** (el resto de este documento) — Node y Chromium
  instalados directo en el sistema, sin Docker. Para una VM Linux dedicada.

---

# Servidor nuevo desde GitHub

El procedimiento a repetir cada vez que se instala en un estudio.

## Lo que git NO se lleva

Todo esto esta en `.gitignore` a proposito. El clon no lo trae y hay que
resolverlo en el servidor:

| Que | Que hacer |
|---|---|
| `.env.production` | Crearlo desde `.env.production.example` |
| La base de datos | Arranca vacia (o se migra, ver abajo) |
| `deploy/certificados/` | Ese servidor genera **su propia** CA |
| `.sessions/`, `.artifacts/`, `respaldos/` | Se crean solos al correr |

## La decision que define todo: la clave maestra

Antes de crear el `.env.production` hay que elegir, y conviene hacerlo a
conciencia:

**Empezar de cero.** Generar `JWT_SECRET` y `MASTER_KEY` nuevos, y volver a
cargar los clientes con sus claves fiscales. Es el camino limpio.

**Migrar una instalacion existente.** Copiar el `.db` **y** la `MASTER_KEY` que
lo cifro — juntos, del mismo origen.

> **La base y la maestra son un par.** Una base con otra maestra da credenciales
> que no se pueden descifrar. Y el error **no aparece al arrancar**: aparece
> recien cuando el worker intenta loguear en ARCA y falla con "No se pudo
> descifrar la credencial". Es de los problemas que se descubren tarde y
> confunden, porque todo lo demas funciona.

## Pasos

```bash
git clone https://github.com/BrunoMerinoFisterra/ArcaFisterra.git
```

```bash
cp .env.production.example .env.production
```

Generar los dos secretos:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Y completar `.env.production` con los valores **de ese servidor**, que no se
copian de otra instalacion:

```dotenv
SITE_ADDRESS=nombre-de-ese-servidor.local
PUBLIC_ORIGIN=https://nombre-de-ese-servidor.local
CADDY_TLS=tls internal

JWT_SECRET=<el generado recien>
MASTER_KEY=<el generado recien>

# Sin esto la base nueva queda sin ningun usuario y no puede entrar nadie.
ADMIN_INICIAL_EMAIL=titular@estudio.com
ADMIN_INICIAL_PASSWORD=una-clave-larga

# La plantilla la trae apagada.
SYNC_NOCTURNA=1
```

Levantar:

```bash
docker compose --env-file .env.production -f compose.production.yml up --build -d
```

> **El `--env-file` no es opcional.** Sin el, Compose corta con un mensaje
> pidiendolo. Es deliberado: antes caia a un default que servia HTTP plano sin
> avisar — un problema de seguridad que fallaba abierto.

## Certificado en las maquinas del estudio

Cada servidor genera **su propia** CA. El certificado de otra instalacion no
sirve. Extraer el de este:

```bash
docker compose --env-file .env.production -f compose.production.yml exec -T web cat /data/caddy/pki/authorities/local/root.crt > arcapanel-ca.crt
```

Instalarlo una vez por PC: doble clic → Instalar certificado → **Equipo local**
→ Entidades de certificacion raiz de confianza. Sin eso el navegador rechaza el
sitio y no hay forma de entrar.

## Arranque automatico

Que el servidor este encendido 24/7 **no alcanza**: lo que decide es que
supervisa los contenedores despues de un reinicio.

**Linux con Docker Engine** — systemd los levanta al bootear, sin sesion
iniciada. No hay nada que hacer.

**Windows con Docker Desktop** — Docker Desktop arranca desde el `Run` del
usuario, no como servicio del sistema. Sin sesion iniciada no hay contenedores,
este la maquina prendida o no. Lo resuelve **inicio de sesion automatico de
Windows + bloqueo inmediato de pantalla**: la sesion queda activa (los
contenedores corren) pero la pantalla bloqueada.

Dos recaudos si se configura: usar una **cuenta local dedicada**, no la
personal, y que el bloqueo sea inmediato al iniciar sesion.

Un escritorio remoto para levantarlo a mano es un plan B razonable, pero no
reemplaza esto: si el servidor se reinicia a las 3 de la madrugada, la
sincronizacion nocturna de esa noche no corre y nadie se entera hasta la
manana.

## Actualizar

```bash
git pull
```

```bash
docker compose --env-file .env.production -f compose.production.yml up --build -d
```

La base **no se toca**: vive en un volumen aparte y sobrevive a la
reconstruccion. Las migraciones de esquema corren solas al abrirla.

Los contenedores se reinician, asi que si hay una sincronizacion en curso se
corta. El lease vencido la recupera sola, pero conviene mirar que no haya un
job activo antes de actualizar.

---

# Despliegue con systemd en una VM Linux

Unidades systemd para correr la API y **N workers** en un solo host, con Node y
Chromium instalados directo en el sistema.

## Cuantos workers conviene levantar

Dos techos, y el segundo sorprende:

**RAM.** Cada worker levanta su propio Chromium contra un portal JSF pesado:
600-800 MB en pico, con `MemoryMax=1500M` de tope duro. En 4 GB entran 2
comodos; en 8 GB, 4 o 5.

**Cuentas ARCA distintas.** `arca_sync_locks` serializa por cuenta de acceso, no
por cliente. Si todos los clientes del estudio estan delegados a un unico login
de ARCA, **N workers no dan ninguna ganancia**: uno trabaja y los demas toman
jobs, chocan con el candado y los devuelven a la cola. El paralelismo util es,
como maximo, la cantidad de cuentas ARCA distintas en cartera.

Antes de levantar el cuarto worker, contá cuántos usuarios ARCA distintos hay.

## Layout esperado

```text
/opt/arcapanel/
  arca-api/      .env (600), arca.db, node_modules/
  arca-app/      dist/  <- lo sirve Caddy, no systemd
  arca-worker/   .env, .sessions/, .artifacts/, node_modules/
  .playwright/   Chromium compartido por todos los workers
```

## Instalacion

```bash
sudo useradd --system --home /opt/arcapanel --shell /usr/sbin/nologin arcapanel
```

**Instalá con devDependencies.** `tsx` es el runtime de este proyecto, no una
herramienta de build: no hay paso de compilacion y los `.ts` se ejecutan
directo. Un `npm ci --omit=dev` deja las unidades sin `ExecStart`.

```bash
sudo -u arcapanel npm --prefix /opt/arcapanel/arca-api install --include=dev
```

```bash
sudo -u arcapanel npm --prefix /opt/arcapanel/arca-worker install --include=dev
```

El navegador va a una ruta compartida, porque `ProtectHome=true` deja
inaccesible el `~/.cache/ms-playwright` por defecto:

```bash
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/arcapanel/.playwright npx playwright install --with-deps chromium
```

```bash
sudo chown -R arcapanel:arcapanel /opt/arcapanel
```

La clave maestra queda solo para el servicio:

```bash
sudo chmod 600 /opt/arcapanel/arca-api/.env
```

## Unidades

```bash
sudo cp deploy/systemd/arca-*.service deploy/systemd/arca-workers.target /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload
```

Dos workers:

```bash
sudo systemctl enable --now arca-api arca-workers.target arca-worker@1 arca-worker@2
```

Agregar un tercero mas adelante es una linea, sin tocar archivos:

```bash
sudo systemctl enable --now arca-worker@3
```

## Front y Caddy

El front se buildea apuntando a `/api`, **no** a una URL completa:

```bash
sudo -u arcapanel VITE_API_URL=/api npm --prefix /opt/arcapanel/arca-app run build
```

Con eso las llamadas quedan relativas al origen actual: el bundle no lleva el
dominio hardcodeado y, al ser todo mismo origen, CORS deja de existir como
problema. Por eso el `Caddyfile` usa `handle_path` y no `handle`: le saca el
prefijo `/api` antes de reenviar, porque las rutas de Express son `/clientes` y
`/sesion`.

Ajustá el default de `panel.fisterra.com.ar` por tu dominio real dentro del
`Caddyfile` (primera linea del bloque, es `{$SITE_ADDRESS:tu-dominio}`) y
copialo:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
```

```bash
sudo systemctl reload caddy
```

**El DNS tiene que apuntar a la VM antes de arrancar Caddy**, porque la
validacion del certificado es por HTTP y necesita resolver el dominio. Si el
registro todavia no propago, Caddy reintenta pero el sitio no levanta.

El `Caddyfile` agrega ademas HSTS, `nosniff`, `X-Frame-Options` y una CSP:
cubre las cabeceras que la API no pone porque no usa helmet, sin tocar Express.
Revisá la consola del navegador despues del primer deploy — si no hay
violaciones de CSP, sacá `'unsafe-inline'` de `style-src`.

Los logs de acceso van a stdout, no a un archivo: `journalctl -u caddy -f`.

Al ser una herramienta interna, considerá dejarla sin exponer del todo:
Tailscale o un allowlist de IPs en Caddy suman una capa por encima del JWT.

### TLS en una red local (sin dominio público)

En la LAN de un estudio no hay dominio público, así que Let's Encrypt no puede
validar nada. Para eso está `CADDY_TLS`:

```dotenv
SITE_ADDRESS=nombre-del-equipo.local
PUBLIC_ORIGIN=https://nombre-del-equipo.local
CADDY_TLS=tls internal
```

Caddy levanta una CA local, firma el certificado él mismo y redirige HTTP a
HTTPS. Sin esto, el JWT y los datos fiscales viajan en texto plano por la red de
la oficina.

**Usá un NOMBRE, no la IP.** Con una IP el handshake TLS falla: el cliente no
puede enviar SNI para una dirección IP (no lo permite el RFC), así que Caddy no
sabe qué certificado presentar y corta la conexión. El nombre del equipo con
sufijo `.local` lo resuelven las máquinas Windows de la red sin configurar nada.

El certificado raíz hay que instalarlo **una vez en cada máquina** del estudio,
si no el navegador muestra la advertencia de sitio no confiable. Extraerlo:

```bash
docker compose --env-file .env.production -f compose.production.yml exec -T web cat /data/caddy/pki/authorities/local/root.crt > arcapanel-ca.crt
```

En Windows: doble clic sobre el `.crt` → Instalar certificado → Equipo local →
Colocar todos los certificados en **Entidades de certificación raíz de
confianza**. La CA persiste en el volumen `caddy_data`, así que sobrevive a los
reinicios y no hay que reinstalarla en cada actualización.

### El mismo `Caddyfile` sirve para Docker Compose

`compose.production.yml` construye Caddy con `deploy/web.Dockerfile`, que
copia este mismo archivo a la imagen. Ahi la API no esta en `localhost` sino
en otro contenedor, y el build del front queda en `/srv` en vez del disco de
la VM — por eso el `Caddyfile` resuelve esos dos valores por variable de
entorno (`API_HOST`, `WEB_ROOT`), y el servicio `web` del compose ya las
setea. `SITE_ADDRESS` se define en `.env.production` (copiado de
`.env.production.example`) para los dos despliegues por igual.

Sin ninguna de esas variables seteadas —el caso de systemd, arriba— el archivo
se comporta exactamente como antes.

## El primer ingreso

En produccion `SEMBRAR_DEMO=0`, asi que la base arranca **sin ningun usuario**.
Y `POST /usuarios` esta detras de `requiereAdmin`, con lo cual crear el primero
por HTTP es imposible: para crear un admin hay que ser admin.

Eso lo resuelven tres variables de `.env.production`:

```dotenv
ADMIN_INICIAL_EMAIL=titular@estudio.com
ADMIN_INICIAL_PASSWORD=una-clave-larga
ADMIN_INICIAL_NOMBRE=Titular
```

Al levantar la API, si —y solo si— la tabla de usuarios esta vacia, crea esa
cuenta con rol `admin` y sin limite de clientes. El log del arranque lo dice:

```bash
docker compose --env-file .env.production -f compose.production.yml logs api | grep "admin inicial"
```

**Cambia esa contrasena desde Mi Cuenta apenas entres.** Mientras no lo hagas,
la clave de la cuenta con mas privilegios del sistema esta en texto plano en un
archivo del servidor.

Las variables pueden quedarse puestas: con la base ya poblada el arranque no
hace nada. No recrean la cuenta, no le pisan la contrasena si la cambiaste, y
no sirven para agregarse un admin mas adelante — la condicion "no hay ningun
usuario" se evalua dentro de la misma transaccion que el alta.

Si perdiste el acceso a la unica cuenta admin, estas variables **no** son la
salida: hay que tocar la base. Es a proposito.

## Mantenimiento

Respaldo de la base y poda de artifacts, todas las noches:

> **En Docker Compose el mantenimiento ya viene incluido** como servicio: corre
> al arrancar y cada 24 h, y deja los respaldos en `./respaldos` del host —
> visibles desde el Explorador, para poder copiarlos afuera de la máquina. Lo
> que sigue es sólo para el despliegue con systemd.

```bash
sudo cp deploy/systemd/arca-mantenimiento.* /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now arca-mantenimiento.timer
```

Probalo sin esperar a la madrugada:

```bash
sudo systemctl start arca-mantenimiento.service && journalctl -u arca-mantenimiento -n 20
```

Dos cosas que importan mas que el resto:

**El respaldo usa `VACUUM INTO`, no `cp`.** La base esta en WAL con la API y los
workers escribiendo; una copia cruda se lleva el `.db` sin el `-wal` y puede
quedar inconsistente. `VACUUM INTO` toma un lock de lectura y produce un archivo
ya consolidado.

**El respaldo NUNCA incluye `arca-api/.env`.** Las credenciales de la base estan
cifradas con DEKs envueltas por `MASTER_KEY`. Si el respaldo automatico se
llevara tambien la maestra, los dos secretos terminarian en el mismo lugar y el
cifrado sobre dejaria de aportar nada. La maestra se guarda aparte y a mano.

Y un respaldo que vive en el mismo disco que la base no es un respaldo: no te
cubre si se pierde la VM. Definí un destino externo y descomentá el
`ExecStartPost` con rclone en `arca-mantenimiento.service`.

## Verificacion

```bash
journalctl -u 'arca-worker@*' -f
```

Cada worker anuncia su identidad al arrancar (`worker : worker-1`). Si ves dos
instancias con el mismo id, la plantilla se copio mal: **`WORKER_ID` unico por
proceso no es opcional**, porque la propiedad del lease se chequea por ese valor
y dos gemelos pueden cerrarse los jobs entre si.

```bash
systemd-analyze security arca-worker@1.service
```

Antes de encolar nada, que el worker valide config y base sin tocar ARCA:

```bash
sudo -u arcapanel WORKER_ID=probe /opt/arcapanel/arca-worker/node_modules/.bin/tsx src/index.ts --check
```

## Si Chromium no arranca

En Ubuntu 24.04 AppArmor restringe los user namespaces sin privilegios por
defecto, y eso rompe el sandbox de Chromium:

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
```

Si devuelve `1`, hace falta un perfil AppArmor para el binario de Chromium, o
bajar ese flag. **No lo arregles con `--no-sandbox`**: este proceso descifra
claves fiscales de terceros y renderiza HTML remoto en el mismo host.

Por la misma razon, las unidades del worker no llevan `RestrictNamespaces=true`
ni `PrivateUsers=true`, aunque `systemd-analyze security` los reclame.

## Detalles

- **Fin de linea LF.** Los archivos se editaron en Windows; si tu editor o Git
  los convierte a CRLF, systemd puede rechazarlos. `file` te lo confirma.
- **Parada lenta a proposito.** `TimeoutStopSec=20min` permite que el worker
  termine el job en curso: atiende SIGTERM cortando el loop, no el trabajo
  activo. Si preferis reinicios rapidos, bajalo — al vencer el lease,
  `recuperarJobsInterrumpidos` cierra el job y libera el candado.
- **`SEMBRAR_DEMO=0`** antes del primer arranque. Con `1` la base nueva queda
  con `bruno@fisterra.com` y `ayudante@fisterra.com`, password `demo`.
- **La API tambien migra el esquema** al abrir. Arrancala primero para que los
  workers encuentren la base ya preparada.
