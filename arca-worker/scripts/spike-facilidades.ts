/**
 * Descubrimiento read-only de Mis Facilidades para un cliente ya configurado.
 * Abre el servicio y guarda HTML/captura; no presenta ni modifica planes.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { crearRepositorioSqlite } from '../../arca-api/src/repo/sqlite.js';
import { descifrarAccesoArca } from '../../arca-api/src/crypto/envelope.js';
import { login } from '../src/arca/login.js';
import { PORTAL, linkServicio } from '../src/arca/selectors.js';
import { abrirSesion, primerSelectorVisible, volcarEstado } from '../src/browser/session.js';
import { cargarConfigWorker } from '../src/config.js';

const SERVICIO = 'Mis Facilidades';
const clienteId = process.argv[2];
if (!clienteId) throw new Error('Uso: npm run spike:facilidades -- <cliente-id>');

const config = cargarConfigWorker();
const repo = crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: false });

try {
  const cliente = await repo.clienteParaSync(clienteId);
  if (!cliente) throw new Error('Cliente inexistente.');
  const cifrada = await repo.leerCredencialCifrada(cliente.id);
  if (!cifrada) throw new Error('El cliente no tiene acceso ARCA guardado.');
  const acceso = descifrarAccesoArca(config.claveMaestra, cifrada, cliente.cuit);

  const carpetaSesiones = join(process.cwd(), '.sessions');
  await mkdir(carpetaSesiones, { recursive: true });
  const sesionPath = join(carpetaSesiones, `cliente-${cliente.id}.json`);
  const teniaSesion = existsSync(sesionPath);
  let sesion;
  try {
    try {
      sesion = await abrirSesion({
        headed: false,
        storageState: teniaSesion ? sesionPath : undefined,
      });
    } catch (error) {
      if (!teniaSesion) throw error;
      await rm(sesionPath, { force: true });
      sesion = await abrirSesion({ headed: false });
    }

    await sesion.page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', {
      waitUntil: 'domcontentloaded',
    });
    const autenticada = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar, 8_000)
      .then(() => true)
      .catch(() => false);
    if (!autenticada) await login(sesion.page, acceso.usuarioCuit, acceso.clave);
    await sesion.context.storageState({ path: sesionPath });

    const buscador = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar);
    await sesion.page.fill(buscador.selector, SERVICIO);
    await sesion.page.waitForTimeout(1_500);
    const [popup] = await Promise.all([
      sesion.page.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
      sesion.page.click(linkServicio(SERVICIO)),
    ]);
    const vista = popup ?? sesion.page;
    await vista.waitForLoadState('domcontentloaded');
    await vista.waitForTimeout(1_000);

    const selectorCuit = vista.locator('#ContentPlaceHolder1_ddlCUIT');
    if ((await selectorCuit.count()) === 1) {
      const cuitObjetivo = cliente.cuit.replace(/\D/g, '');
      if ((await selectorCuit.locator(`option[value="${cuitObjetivo}"]`).count()) !== 1) {
        throw new Error(`Mis Facilidades no ofrece el CUIT ${cliente.cuit}.`);
      }
      await selectorCuit.selectOption(cuitObjetivo);
      await vista.click('#ContentPlaceHolder1_btnAceptar');
      await vista.waitForLoadState('domcontentloaded');
      await vista.waitForTimeout(1_500);
    }

    const detalles = vista.locator('input[id^="ContentPlaceHolder1_rpt_detallePlan_"]');
    const cantidadDetalles = await detalles.count();
    if (cantidadDetalles > 0) {
      await detalles.first().click();
      await vista.waitForLoadState('domcontentloaded');
      await vista.waitForTimeout(1_000);

      const verPagos = vista.locator('#ContentPlaceHolder1_btnVerPagos');
      if ((await verPagos.count()) === 1) {
        await verPagos.click();
        await vista.waitForLoadState('domcontentloaded');
        await vista.waitForTimeout(1_000);
      }
    }

    const artifact = await volcarEstado(vista, `spike-mis-facilidades-${cliente.id}`);
    console.log(`cliente  : ${cliente.razonSocial} (${cliente.cuit})`);
    console.log(`URL      : ${vista.url()}`);
    console.log(`titulo   : ${await vista.title()}`);
    console.log(`artifacts: ${artifact}.{html,png,url.txt}`);
  } finally {
    acceso.clave = '';
    await sesion?.cerrar();
  }
} finally {
  repo.cerrar();
  config.claveMaestra.fill(0);
}
