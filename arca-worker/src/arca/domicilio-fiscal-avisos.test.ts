import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cerrarAvisosDfe } from './domicilio-fiscal.js';

/**
 * Los dos avisos del DFE abiertos a la vez, como los manda ARCA cuando hay
 * comunicaciones de oficio sin leer. Reproduce lo que importa del artifact: el
 * de oficio va DESPUES en el DOM y su backdrop tapa al introductorio.
 *
 * Con el orden viejo —introductorio primero— el click sobre RECORDAR MAS TARDE
 * queda interceptado por ese backdrop y Playwright espera hasta agotar su
 * timeout. O sea que este test falla, por plantado, si se vuelve a ese orden.
 */
const AVISOS_APILADOS = `
  <style>
    .modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; }
    .backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; }
  </style>

  <div id="intro" class="modal show" style="z-index: 10">
    <h5>Domicilio Fiscal Electronico</h5>
    <p>Notificaciones: pueden contener vencimientos y, aunque no las leas, serán
       consideradas "notificadas de oficio" el lunes posterior a su recepción.</p>
    <button onclick="document.getElementById('intro').remove()">Recordar más tarde</button>
    <button onclick="window.__entendido = true">Entendido</button>
  </div>

  <div id="backdrop-oficio" class="backdrop" style="z-index: 20"></div>

  <div id="oficio" class="modal show" style="z-index: 30">
    <h5>Notificaciones de oficio</h5>
    <p>Entre el 04/07/2026 y el 02/09/2026 tenés 1 comunicaciones sin leer.</p>
    <button onclick="document.getElementById('oficio').remove();
                     document.getElementById('backdrop-oficio').remove()">Cerrar</button>
    <button onclick="window.__visualizado = true">Visualizar</button>
  </div>
`;

test('cierra los dos avisos aunque ARCA los abra apilados', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(AVISOS_APILADOS);

  assert.equal(await cerrarAvisosDfe(page), true);
  assert.equal(await page.locator('#oficio').count(), 0);
  assert.equal(await page.locator('#intro').count(), 0);
});

test('nunca aprieta VISUALIZAR, que perfeccionaria la notificacion', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(AVISOS_APILADOS);

  await cerrarAvisosDfe(page);

  // Ni VISUALIZAR en el de oficio ni ENTENDIDO en el introductorio: las dos son
  // acciones con efecto en ARCA, y el worker sale solo por las pasivas.
  assert.equal(await page.evaluate(() => (window as any).__visualizado), undefined);
  assert.equal(await page.evaluate(() => (window as any).__entendido), undefined);
});

test('no toca nada si no hay avisos abiertos', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div class="modal">oculto</div>');

  assert.equal(await cerrarAvisosDfe(page), false);
});
