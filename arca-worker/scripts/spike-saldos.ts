/**
 * Descubrimiento read-only de Sistema de Cuentas Tributarias.
 *
 * Abre el servicio para un cliente ya configurado y guarda HTML/captura. No
 * presenta declaraciones, no compensa saldos y no inicia pagos.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crearRepositorioSqlite } from '../../arca-api/src/repo/sqlite.js';
import { descifrarAccesoArca } from '../../arca-api/src/crypto/envelope.js';
import { login } from '../src/arca/login.js';
import { PORTAL, linkServicio } from '../src/arca/selectors.js';
import { abrirSesion, primerSelectorVisible, volcarEstado } from '../src/browser/session.js';
import { cargarConfigWorker } from '../src/config.js';

const SERVICIO = 'Sistema de Cuentas Tributarias';
const clienteId = process.argv[2];
if (!clienteId) throw new Error('Uso: npm run spike:saldos -- <cliente-id>');

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
    let vista = popup ?? sesion.page;
    await vista.waitForLoadState('domcontentloaded');
    await vista.waitForTimeout(2_000);

    // El portal puede conservar su propia sesión mientras la autenticación
    // central requerida por este servicio ya venció. Renovamos una vez;
    // login() nunca reintenta una clave fallida.
    if (/auth\.afip\.gob\.ar\/contribuyente_\/login\.xhtml/i.test(vista.url())) {
      await login(vista, acceso.usuarioCuit, acceso.clave, [
        /ctacte\.cloud\.afip\.gob\.ar\/contribuyente\//i,
      ]);
      await vista.waitForLoadState('domcontentloaded');
      await vista.waitForTimeout(2_000);
      await sesion.context.storageState({ path: sesionPath });
    }

    const cuitObjetivo = cliente.cuit.replace(/\D/g, '');
    const selectorCuit = vista.locator('#cuitForm select[name="$PropertySelection"]');
    if ((await selectorCuit.count()) !== 1) {
      throw new Error('Sistema de Cuentas Tributarias no informó el selector de CUIT.');
    }
    if ((await selectorCuit.locator(`option:text-is("${cuitObjetivo}")`).count()) !== 1) {
      throw new Error(`Sistema de Cuentas Tributarias no ofrece el CUIT ${cliente.cuit}.`);
    }
    if ((await selectorCuit.inputValue()) !== await selectorCuit.locator(`option:text-is("${cuitObjetivo}")`).getAttribute('value')) {
      await Promise.all([
        vista.waitForLoadState('domcontentloaded'),
        selectorCuit.selectOption({ label: cuitObjetivo }),
      ]);
      await vista.waitForTimeout(2_000);
    }

    const cuitActivo = await vista.locator('#cuitForm select option:checked').textContent();
    if (cuitActivo?.replace(/\D/g, '') !== cuitObjetivo) {
      throw new Error(`Sistema de Cuentas Tributarias no activó el CUIT ${cliente.cuit}.`);
    }

    const marco = vista.frames().find((frame) => /homeContribuyente/i.test(frame.url()));
    if (!marco) throw new Error('No se encontró el panel de saldos de Cuentas Tributarias.');
    const tabDeudas = marco.getByRole('tab', { name: /Deudas/i });
    await tabDeudas.waitFor();
    if ((await tabDeudas.count()) !== 1) throw new Error('No se encontró la pestaña Deudas.');
    await tabDeudas.click();
    await marco.locator('a[role="tab"][aria-selected="true"]:has-text("Deudas")').waitFor();
    await marco.waitForFunction(() => !document.body.classList.contains('loader-open'));
    const panelDeudas = marco.locator('[role="tabpanel"][aria-hidden="false"]');
    await panelDeudas.locator('table tbody tr').first().waitFor();
    const selectorCantidad = panelDeudas.locator('select:has(option[value="-1"])');
    if ((await selectorCantidad.count()) === 1) {
      await selectorCantidad.selectOption('-1');
      await vista.waitForTimeout(500);
    }
    await vista.waitForTimeout(1_000);

    const artifact = await volcarEstado(vista, `spike-saldos-${cliente.id}`);
    await writeFile(`${artifact}.iframe.html`, await marco.content(), 'utf8');
    console.log(`cliente  : ${cliente.razonSocial} (${cliente.cuit})`);
    console.log(`activo   : ${cuitActivo?.trim()}`);
    console.log(`URL      : ${vista.url()}`);
    console.log(`iframe   : ${marco?.url() ?? '(no encontrado)'}`);
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
