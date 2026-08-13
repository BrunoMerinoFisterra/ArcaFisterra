import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { ArcaError } from './errors.js';
import {
  formatearCuitArca,
  seleccionarContribuyenteSiHaceFalta,
} from './comprobantes.js';

test('formatea el CUIT como lo muestra Mis Comprobantes', () => {
  assert.equal(formatearCuitArca('30712011196'), '30-71201119-6');
  assert.equal(formatearCuitArca('30-71201119-6'), '30-71201119-6');
});

test('elige al representado por CUIT y no por posicion', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <form name="seleccionaEmpresaForm">
      <input type="hidden" id="idcontribuyente" value="">
      <div class="panels-row">
        <a class="panel" href="#" onclick="idcontribuyente.value='otro';return false">
          OTRA S.A. <small>30-70968172-5</small>
        </a>
      </div>
      <div class="panels-row">
        <a class="panel" href="#" onclick="idcontribuyente.value='fisterra';return false">
          FISTERRA S.R.L. <small>30-71201119-6</small>
        </a>
      </div>
    </form>
  `);

  assert.equal(await seleccionarContribuyenteSiHaceFalta(page, '30-71201119-6'), true);
  assert.equal(await page.locator('#idcontribuyente').inputValue(), 'fisterra');
});

test('falla de forma explicita si el CUIT no esta entre los representados', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <form name="seleccionaEmpresaForm">
      <input type="hidden" id="idcontribuyente">
      <div class="panels-row">
        <a class="panel" href="#">OTRA S.A. <small>30-70968172-5</small></a>
      </div>
    </form>
  `);

  await assert.rejects(
    seleccionarContribuyenteSiHaceFalta(page, '30-71201119-6'),
    (error: unknown) =>
      error instanceof ArcaError && error.code === 'REPRESENTADO_NO_DISPONIBLE',
  );
});
