#!/usr/bin/env node
/**
 * Mantenimiento nocturno: respaldo de la base y poda de artifacts.
 *
 * Corre con Node 24, sin dependencias: usa `node:sqlite`, el mismo builtin que
 * usa la aplicacion. No hace falta instalar el CLI de sqlite3 en la VM.
 *
 * ORDEN DELIBERADO: primero el respaldo, despues la limpieza. Si la poda falla,
 * el respaldo de esta noche ya esta hecho.
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTE SCRIPT NO HACE, Y NO DEBE HACER: copiar `arca-api/.env`.
 *
 * Las credenciales de la base estan cifradas con DEKs envueltas por MASTER_KEY.
 * Si el respaldo automatico se llevara tambien el .env, los dos secretos
 * terminarian en el mismo lugar y el cifrado sobre dejaria de aportar nada:
 * quien acceda al respaldo tendria la base Y la llave para abrirla.
 *
 * La clave maestra se guarda aparte y a mano (gestor de contrasenas del
 * estudio). Sin ella el respaldo es un archivo inutil para un tercero — que es
 * exactamente la propiedad que se quiere conservar.
 * ---------------------------------------------------------------------------
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env['ARCA_DB'] ?? '/opt/arcapanel/arca-api/arca.db';
const DESTINO = process.env['ARCA_RESPALDOS'] ?? '/opt/arcapanel/respaldos';
const ARTIFACTS = process.env['ARCA_ARTIFACTS'] ?? '/opt/arcapanel/arca-worker/.artifacts';
const RETENCION_DIAS = Number(process.env['RETENCION_DIAS'] ?? 14);
const RETENCION_ARTIFACTS_DIAS = Number(process.env['RETENCION_ARTIFACTS_DIAS'] ?? 7);

const DIA_MS = 86_400_000;

function respaldar() {
  mkdirSync(DESTINO, { recursive: true });
  const sello = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const salida = join(DESTINO, `arca-${sello}.db`);

  // VACUUM INTO y no `cp`: la base esta en WAL con la API y los workers
  // escribiendo. Una copia cruda del archivo puede quedar inconsistente porque
  // se lleva el .db sin el -wal. VACUUM INTO toma un lock de lectura y produce
  // un archivo unico ya consolidado.
  const db = new DatabaseSync(BASE);
  try {
    db.exec(`VACUUM INTO '${salida.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  const mb = (statSync(salida).size / 1024 / 1024).toFixed(1);
  console.log(`respaldo: ${salida} (${mb} MB)`);
}

/** Borra archivos mas viejos que `dias` dentro de `carpeta`. */
function podar(carpeta, dias, etiqueta) {
  let entradas;
  try {
    entradas = readdirSync(carpeta, { withFileTypes: true });
  } catch {
    console.log(`${etiqueta}: ${carpeta} no existe todavia, nada que podar`);
    return;
  }

  const corte = Date.now() - dias * DIA_MS;
  let borrados = 0;
  let liberados = 0;
  for (const entrada of entradas) {
    const ruta = join(carpeta, entrada.name);
    const info = statSync(ruta);
    if (info.mtimeMs >= corte) continue;
    liberados += info.size;
    rmSync(ruta, { recursive: true, force: true });
    borrados += 1;
  }
  console.log(
    `${etiqueta}: ${borrados} borrados, ${(liberados / 1024 / 1024).toFixed(1)} MB liberados ` +
      `(retencion ${dias} dias)`,
  );
}

respaldar();
podar(DESTINO, RETENCION_DIAS, 'respaldos');

// .artifacts/ guarda captura + HTML + el HTML de cada iframe en CADA fallo, y
// nunca se limpia solo. Un portal que cambia y falla en loop llena el disco.
// Ojo: son datos fiscales reales, asi que esto tambien es higiene, no solo
// espacio.
podar(ARTIFACTS, RETENCION_ARTIFACTS_DIAS, 'artifacts');
