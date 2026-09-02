import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { controlHabilitado } from './saldos.js';

/**
 * Pestañas de Cuentas Tributarias tal como las manda ARCA cuando el
 * contribuyente no tiene vencimientos: la de Vencimientos queda deshabilitada,
 * con su panel en `display:none` y la tabla adentro, que por eso nunca se
 * vuelve visible. Copiado de un artifact real.
 */
const PESTANAS = `
  <a role="tab" aria-selected="true" class="nav-link active" id="tab-saldos">Saldos</a>
  <a role="tab" aria-selected="false" aria-disabled="true" class="nav-link disabled disabled"
     id="tab-vencimientos">Vencimientos</a>
  <a role="tab" aria-selected="false" class="nav-link" id="tab-ddjj">DDJJ pendientes</a>
`;

test('reconoce deshabilitada la pestaña que ARCA apaga sin datos', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(PESTANAS);

  // El caso que colgaba el modulo entero 30 s: la tabla existe en el DOM pero
  // su panel esta oculto, asi que esperarla visible no termina nunca.
  assert.equal(await controlHabilitado(page.locator('#tab-vencimientos')), false);
});

test('una pestaña normal cuenta como habilitada', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(PESTANAS);

  assert.equal(await controlHabilitado(page.locator('#tab-ddjj')), true);
  assert.equal(await controlHabilitado(page.locator('#tab-saldos')), true);
});

test('alcanza con la clase disabled, sin aria-disabled', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // ARCA no siempre pone los dos marcadores; con uno solo ya no hay que entrar.
  await page.setContent('<a role="tab" class="nav-link disabled" id="t">Vencimientos</a>');

  assert.equal(await controlHabilitado(page.locator('#t')), false);
});
