import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { ArcaError } from './errors.js';
import { seleccionarCuit } from './saldos.js';

/**
 * Pantalla de Cuentas Tributarias cuando la clave representa a UNO solo: ARCA
 * entra ya posicionado y no dibuja `#cuitForm`. Copiada de un artifact real.
 */
const SIN_COMBO = (cuit: string) => `
  <div class="datos-contribuyente">
    <span class="razon">GEOLOG ARGENTINA S.A.</span>
    <span class="cuit">${cuit}</span>
  </div>
`;

/** Pantalla con combo, que es el caso de una clave con varios representados. */
const CON_COMBO = `
  <form id="cuitForm">
    <select name="$PropertySelection">
      <option value="0">OTRA S.A. (30-70968172-5)</option>
      <option value="1" selected>GEOLOG ARGENTINA S.A. (30-71543210-4)</option>
    </select>
  </form>
`;

test('sin combo, sigue si el CUIT activo es el del cliente', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SIN_COMBO('30-71543210-4'));

  await assert.doesNotReject(() => seleccionarCuit(page, '30715432104', 250));
});

test('sin combo, corta si el activo es otro contribuyente', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // El riesgo concreto: sin esta verificacion se scrapeaba la deuda del
  // contribuyente equivocado y quedaba guardada bajo nuestro cliente.
  await page.setContent(SIN_COMBO('30-70968172-5'));

  await assert.rejects(
    () => seleccionarCuit(page, '30715432104', 250),
    (error: unknown) =>
      error instanceof ArcaError && error.code === 'REPRESENTADO_NO_DISPONIBLE',
  );
});

test('sin combo y sin cartel de CUIT, corta en vez de asumir', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div class="datos-contribuyente"></div>');

  await assert.rejects(
    () => seleccionarCuit(page, '30715432104', 250),
    (error: unknown) =>
      error instanceof ArcaError && error.code === 'REPRESENTADO_NO_DISPONIBLE',
  );
});

test('con combo sigue eligiendo por CUIT exacto', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(CON_COMBO);

  await assert.doesNotReject(() => seleccionarCuit(page, '30715432104', 250));
  assert.equal(await page.locator('#cuitForm select').inputValue(), '1');
});
