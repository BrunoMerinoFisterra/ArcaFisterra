import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  cargarClaveMaestra,
  cifrarAccesoArca,
  cifrarCredencial,
  descifrarAccesoArca,
  descifrarCredencial,
  identificadorAccesoArca,
} from './envelope.js';

const maestra = randomBytes(32);
const CLAVE = 'Cl4ve-Fiscal-Ñandú';

test('el ida y vuelta devuelve la clave original', () => {
  const cifrada = cifrarCredencial(maestra, CLAVE);
  assert.equal(descifrarCredencial(maestra, cifrada), CLAVE);
});

test('el acceso ARCA conserva usuario CUIT y clave', () => {
  const acceso = { usuarioCuit: '30712345671', clave: CLAVE };
  const cifrada = cifrarAccesoArca(maestra, acceso);
  assert.deepEqual(descifrarAccesoArca(maestra, cifrada, '20-00000000-0'), acceso);
  assert.ok(!JSON.stringify(cifrada).includes(acceso.usuarioCuit));
});

test('una credencial anterior usa el CUIT del cliente como usuario', () => {
  const cifradaAnterior = cifrarCredencial(maestra, CLAVE);
  assert.deepEqual(descifrarAccesoArca(maestra, cifradaAnterior, '30-71234567-1'), {
    usuarioCuit: '30712345671',
    clave: CLAVE,
  });
});

test('el candado de cuenta es estable, normaliza el CUIT y no lo expone', () => {
  const cuit = '30-71234567-1';
  const identificador = identificadorAccesoArca(maestra, cuit);
  assert.equal(identificador, identificadorAccesoArca(maestra, '30712345671'));
  assert.notEqual(identificador, identificadorAccesoArca(maestra, '20-00000000-1'));
  assert.ok(!identificador.includes('30712345671'));
  assert.equal(identificador.length, 43);
});

test('la clave en claro no aparece en ningún campo cifrado', () => {
  const cifrada = cifrarCredencial(maestra, CLAVE);
  const serializado = JSON.stringify(cifrada);
  assert.ok(!serializado.includes(CLAVE));
  // Tampoco en base64: si la "cifra" fuera un encode, esto lo agarra.
  assert.ok(!serializado.includes(Buffer.from(CLAVE, 'utf8').toString('base64')));
});

test('cifrar dos veces lo mismo da resultados distintos', () => {
  // Cada credencial usa DEK e IV nuevos. Si dos iguales dieran el mismo
  // ciphertext, la base filtraría qué clientes comparten clave.
  const a = cifrarCredencial(maestra, CLAVE);
  const b = cifrarCredencial(maestra, CLAVE);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.dekEnvuelta, b.dekEnvuelta);
});

test('con otra clave maestra no se puede descifrar', () => {
  const cifrada = cifrarCredencial(maestra, CLAVE);
  assert.throws(() => descifrarCredencial(randomBytes(32), cifrada));
});

test('un ciphertext manoseado falla en vez de devolver basura', () => {
  // Es la razón de usar GCM: detecta la alteración en vez de descifrar mal.
  const cifrada = cifrarCredencial(maestra, CLAVE);
  const bytes = Buffer.from(cifrada.ciphertext, 'base64');
  bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
  assert.throws(() =>
    descifrarCredencial(maestra, { ...cifrada, ciphertext: bytes.toString('base64') }),
  );
});

test('rechaza una clave maestra de largo incorrecto', () => {
  assert.throws(() => cargarClaveMaestra(randomBytes(16).toString('base64')), /32 bytes/);
});
