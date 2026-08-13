import cors from 'cors';
import express, { type Express } from 'express';
import type { Config } from '../config.js';
import type { Repositorio } from '../repo/tipos.js';
import { manejadorErrores } from './errores.js';
import { rutasClientes } from './rutas/clientes.js';
import { rutasSesion } from './rutas/sesion.js';
import { rutasUsuarios } from './rutas/usuarios.js';

export function crearApp(repo: Repositorio, config: Config): Express {
  const app = express();

  app.use(cors({ origin: config.origenPermitido }));

  app.get('/salud', (_req, res) => res.json({ ok: true }));
  app.use('/sesion', express.json({ limit: '64kb' }), rutasSesion(repo, config));
  app.use('/clientes', express.json({ limit: '64kb' }), rutasClientes(repo, config));
  app.use('/usuarios', express.json({ limit: '64kb' }), rutasUsuarios(repo, config));

  app.use((_req, res) => res.status(404).json({ error: 'Ruta inexistente.' }));
  app.use(manejadorErrores);

  return app;
}
