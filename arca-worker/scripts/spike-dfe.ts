/** Descubrimiento de solo lectura del Domicilio Fiscal Electrónico. */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { crearRepositorioSqlite } from '../../arca-api/src/repo/sqlite.js';
import { descifrarAccesoArca } from '../../arca-api/src/crypto/envelope.js';
import { login } from '../src/arca/login.js';
import { PORTAL, URLS } from '../src/arca/selectors.js';
import { abrirSesion, primerSelectorVisible, volcarEstado } from '../src/browser/session.js';
import { cargarConfigWorker } from '../src/config.js';

const clienteId = process.argv[2];
if (!clienteId) throw new Error('Uso: npm run spike:dfe -- <cliente-id>');

const config = cargarConfigWorker();
const repo = crearRepositorioSqlite({ archivo: config.sqlitePath, sembrar: false });
try {
  const cliente = await repo.clienteParaSync(clienteId);
  const cifrada = cliente ? await repo.leerCredencialCifrada(cliente.id) : null;
  if (!cliente || !cifrada) throw new Error('Cliente o credencial inexistente.');
  const acceso = descifrarAccesoArca(config.claveMaestra, cifrada, cliente.cuit);
  const carpetaSesiones = join(process.cwd(), '.sessions');
  await mkdir(carpetaSesiones, { recursive: true });
  const sesionPath = join(carpetaSesiones, `cliente-${cliente.id}.json`);
  const teniaSesion = existsSync(sesionPath);
  let sesion;
  try {
    try {
      sesion = await abrirSesion({ headed: false, storageState: teniaSesion ? sesionPath : undefined });
    } catch (error) {
      if (!teniaSesion) throw error;
      await rm(sesionPath, { force: true });
      sesion = await abrirSesion({ headed: false });
    }
    await sesion.page.goto(URLS.portal, { waitUntil: 'domcontentloaded' });
    const autenticada = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar, 8_000)
      .then(() => true)
      .catch(() => false);
    if (!autenticada) await login(sesion.page, acceso.usuarioCuit, acceso.clave);
    await sesion.context.storageState({ path: sesionPath });

    const buscador = await primerSelectorVisible(sesion.page, PORTAL.inputBuscar);
    await sesion.page.fill(buscador.selector, 'Domicilio Fiscal');
    await sesion.page.waitForTimeout(1_500);
    const candidatos = await sesion.page.locator('a').evaluateAll((links) =>
      links
        .map((link) => ({ texto: (link.textContent ?? '').replace(/\s+/g, ' ').trim(), href: link.getAttribute('href') ?? '' }))
        .filter((link) => /domicilio\s+fiscal/i.test(link.texto)),
    );
    console.log('servicios:', candidatos);
    const servicio = sesion.page.locator(
      'li[role="option"][aria-label="Domicilio Fiscal Electrónico"] a.dropdown-item',
    );
    if ((await servicio.count()) !== 1) {
      const artifact = await volcarEstado(sesion.page, `spike-dfe-portal-${cliente.id}`);
      console.log(`artifacts: ${artifact}.{html,png,url.txt}`);
      throw new Error('No se encontró un único servicio Domicilio Fiscal Electrónico.');
    }
    const [popup] = await Promise.all([
      sesion.context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
      servicio.click(),
    ]);
    const vista = popup ?? sesion.page;
    await vista.waitForLoadState('domcontentloaded');
    await vista.waitForTimeout(1_000);
    const recordarMasTarde = vista.getByRole('button', { name: 'Recordar más tarde' });
    if (await recordarMasTarde.isVisible().catch(() => false)) await recordarMasTarde.click();

    const targetCuit = cliente.cuit.replace(/\D/g, '');
    await vista.locator('#representados-comunicaciones-tab___BV_tab_button__').click();
    const selectorRepresentado = vista.locator('#select-representados');
    const opcionExacta = selectorRepresentado.locator(`option[value="${targetCuit}"]`);
    if ((await opcionExacta.count()) !== 1) {
      throw new Error(`El CUIT objetivo ${cliente.cuit} no está entre los representados del DFE.`);
    }
    await selectorRepresentado.locator('xpath=following-sibling::*[contains(@class,"input-group")]').click();
    await vista.locator(`button.dropdown-item[id="${targetCuit}"]`).click();
    await vista.waitForTimeout(2_000);

    const filas = await vista.locator('#representados-comunicaciones-tab table tbody tr').evaluateAll((rows) =>
      rows.map((row) => ({
        texto: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
        html: row.innerHTML,
      })),
    );
    const artifact = await volcarEstado(vista, `spike-dfe-${cliente.id}`);
    console.log(`cliente  : ${cliente.razonSocial} (${cliente.cuit})`);
    console.log(`URL      : ${vista.url()}`);
    console.log(`titulo   : ${await vista.title()}`);
    console.log(`filas    : ${filas.length}`);
    console.log(JSON.stringify(filas.map(({ texto }) => texto), null, 2));
    console.log(`artifacts: ${artifact}.{html,png,url.txt}`);
  } finally {
    acceso.clave = '';
    await sesion?.cerrar();
  }
} finally {
  repo.cerrar();
  config.claveMaestra.fill(0);
}
