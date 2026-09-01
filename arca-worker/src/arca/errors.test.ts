import assert from 'node:assert/strict';
import test from 'node:test';
import { detectarError } from './errors.js';

/**
 * El cartel que devuelve ARCA cuando el usuario de login no es una clave
 * fiscal valida. Copiado tal cual del `<span id="F1:msg">` de un artifact:
 * rotula el campo "CUIL/CUIT", no "CUIT" a secas.
 */
const CARTEL_CUIT_INCORRECTO = 'Número de CUIL/CUIT incorrecto';

test('reconoce el cartel de CUIT invalido con el rotulo CUIL/CUIT del portal', () => {
  const error = detectarError(CARTEL_CUIT_INCORRECTO);

  assert.equal(error?.code, 'CLAVE_INCORRECTA');
  // Lo que importa de veras: que frene y marque la credencial. Si esto cae en
  // DESCONOCIDO la reaccion pasa a REVISAR_SELECTORES, el cliente queda con la
  // credencial en OK y cada reintento es otro login fallido contra ARCA.
  assert.equal(error?.reaccion, 'FRENAR_MARCAR_CREDENCIAL');
});

test('sigue reconociendo la redaccion sin el rotulo CUIL', () => {
  assert.equal(detectarError('Numero de CUIT incorrecto')?.code, 'CLAVE_INCORRECTA');
});

test('no confunde una pantalla normal que apenas menciona el CUIT', () => {
  assert.equal(detectarError('Ingrese su CUIL/CUIT para continuar'), null);
  assert.equal(detectarError('Administrador de Relaciones'), null);
});
