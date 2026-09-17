import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcaError, cortaLaCorrida, detectarError } from './errors.js';

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

/**
 * Copiado del artifact del 2026-09-14: ARCA dejo entrar —la pagina muestra el
 * CUIT y "Clave Fiscal Nivel: 3"— y redirigio a la pantalla de cambio forzado.
 */
const CARTEL_CAMBIO_FORZADO =
  'Cambiar Clave Fiscal Por medidas de seguridad tenés que cambiar tu contraseña';

test('reconoce el cambio de clave forzado, que vosea y dice "contraseña"', () => {
  const error = detectarError(CARTEL_CAMBIO_FORZADO);

  assert.equal(error?.code, 'CLAVE_VENCIDA');
  // Lo que importa: que pida intervencion humana en vez de caer en DESCONOCIDO.
  // Cuando caia ahi, la credencial quedaba en OK y el panel dejaba reintentar
  // contra una clave que ARCA ya estaba rechazando.
  assert.equal(error?.reaccion, 'NECESITA_HUMANO');
});

test('el titulo del menu "Cambiar Clave Fiscal" solo no alcanza', () => {
  // Es una opcion del portal y aparece en pantallas sanas: matchearla seria el
  // mismo falso positivo que dio "administrador de relaciones" en su momento.
  assert.equal(detectarError('Cambiar Clave Fiscal'), null);
});

test('una falla de un servicio no corta los modulos que faltan', () => {
  // El caso real: la clave tiene delegado Cuentas Tributarias pero no Mis
  // Facilidades. Antes eso dejaba sin sincronizar tambien a Mis Comprobantes,
  // que es el modulo siguiente y no tenia nada que ver.
  for (const code of [
    'REPRESENTADO_NO_DISPONIBLE',
    'SERVICIO_NO_ADHERIDO',
    'SELECTOR_NO_ENCONTRADO',
    'TIMEOUT',
    'PORTAL_NO_DISPONIBLE',
    'DESCONOCIDO',
  ] as const) {
    assert.equal(cortaLaCorrida(new ArcaError(code)), false, code);
  }
});

test('una falla de credencial o de sesion si corta', () => {
  // Seguir con una clave incorrecta es lo que termina bloqueando la cuenta del
  // contribuyente; con CAPTCHA o segundo factor, los modulos que faltan chocan
  // igual contra la misma pantalla.
  for (const code of [
    'CLAVE_INCORRECTA',
    'CLAVE_BLOQUEADA',
    'CLAVE_VENCIDA',
    'CAPTCHA_PRESENTE',
    'SEGUNDO_FACTOR',
    // Si no pudimos entrar, los modulos que faltan chocan contra el mismo login.
    'LOGIN_NO_RECONOCIDO',
  ] as const) {
    assert.equal(cortaLaCorrida(new ArcaError(code)), true, code);
  }
});

test('un cartel desconocido EN EL LOGIN frena, no manda a revisar selectores', () => {
  // La diferencia con DESCONOCIDO es el lugar, y cambia la conclusion. En el
  // login todavia no llegamos a ningun servicio: no puede ser un selector de
  // Cuentas Tributarias, es la credencial o la sesion. REVISAR_SELECTORES deja
  // la credencial en OK y el panel invita a reintentar — cuatro veces en dos
  // minutos, la primera vez que paso.
  assert.equal(new ArcaError('LOGIN_NO_RECONOCIDO').reaccion, 'NECESITA_HUMANO');
  assert.equal(new ArcaError('DESCONOCIDO').reaccion, 'REVISAR_SELECTORES');
});

test('un error que no es de ARCA no corta por si solo', () => {
  assert.equal(cortaLaCorrida(new Error('cualquier cosa')), false);
});
