import { cargarConfig } from './config.js';
import { crearApp } from './http/app.js';
import { crearRepositorioMemoria } from './repo/memoria.js';
import { crearRepositorioSqlite } from './repo/sqlite.js';
import type { Repositorio } from './repo/tipos.js';

const config = cargarConfig();

const repo: Repositorio =
  config.repositorio === 'sqlite'
    ? crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: config.sembrarDemo })
    : await crearRepositorioMemoria();

crearApp(repo, config).listen(config.puerto, () => {
  console.log(`arca-api escuchando en http://localhost:${config.puerto}`);
  console.log(
    `  repositorio : ${config.repositorio}` +
      (config.repositorio === 'sqlite' ? ` (${config.sqlitePath})` : ' (no persiste)'),
  );
  console.log(`  CORS        : ${config.origenPermitido}`);
});
