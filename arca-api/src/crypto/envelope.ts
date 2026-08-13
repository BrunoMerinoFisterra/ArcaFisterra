import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cifrado sobre (envelope encryption) para las claves fiscales.
 *
 * Cada credencial se cifra con una DEK (data encryption key) propia y aleatoria.
 * Esa DEK se guarda cifrada con la clave maestra. Dos motivos:
 *
 *  - Rotar la maestra es re-envolver N DEKs cortas, no re-cifrar N credenciales.
 *  - Una DEK filtrada expone UNA credencial, no todas.
 *
 * AES-256-GCM es autenticado: si alguien toca el ciphertext en la base, el
 * descifrado falla en vez de devolver basura silenciosamente.
 *
 * En produccion la clave maestra vive en Azure Key Vault. `cargarClaveMaestra`
 * es la unica puerta por donde entra, asi que migrar a Key Vault toca este
 * archivo y ningun otro.
 */

const ALGORITMO = 'aes-256-gcm';
const BYTES_CLAVE = 32;
const BYTES_IV = 12; // 96 bits, el recomendado para GCM

export interface CredencialCifrada {
  ciphertext: string;
  iv: string;
  authTag: string;
  dekEnvuelta: string;
  dekIv: string;
  dekAuthTag: string;
}

/** Datos que el worker necesita para iniciar sesion en una cuenta de ARCA. */
export interface AccesoArca {
  usuarioCuit: string;
  clave: string;
}

interface AccesoArcaSerializado extends AccesoArca {
  version: 2;
}

export function cargarClaveMaestra(base64: string): Buffer {
  let clave: Buffer;
  try {
    clave = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('MASTER_KEY no es base64 valido.');
  }
  if (clave.length !== BYTES_CLAVE) {
    throw new Error(
      `MASTER_KEY debe ser de ${BYTES_CLAVE} bytes en base64 (son ${clave.length}). ` +
        'Generala con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return clave;
}

function cifrar(clave: Buffer, texto: Buffer): { ct: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(BYTES_IV);
  const cipher = createCipheriv(ALGORITMO, clave, iv);
  const ct = Buffer.concat([cipher.update(texto), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag() };
}

function descifrar(clave: Buffer, ct: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITMO, clave, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function cifrarCredencial(claveMaestra: Buffer, claveFiscal: string): CredencialCifrada {
  const dek = randomBytes(BYTES_CLAVE);
  const datos = cifrar(dek, Buffer.from(claveFiscal, 'utf8'));
  const envuelta = cifrar(claveMaestra, dek);

  // La DEK en claro no tiene por que seguir en memoria despues de envolverla.
  dek.fill(0);

  return {
    ciphertext: datos.ct.toString('base64'),
    iv: datos.iv.toString('base64'),
    authTag: datos.tag.toString('base64'),
    dekEnvuelta: envuelta.ct.toString('base64'),
    dekIv: envuelta.iv.toString('base64'),
    dekAuthTag: envuelta.tag.toString('base64'),
  };
}

/**
 * Descifra una credencial. SOLO la debe llamar el worker al momento de loguear.
 * Ningun endpoint HTTP tiene que exponer esto, ni siquiera para un admin.
 */
export function descifrarCredencial(claveMaestra: Buffer, c: CredencialCifrada): string {
  const dek = descifrar(
    claveMaestra,
    Buffer.from(c.dekEnvuelta, 'base64'),
    Buffer.from(c.dekIv, 'base64'),
    Buffer.from(c.dekAuthTag, 'base64'),
  );
  try {
    return descifrar(
      dek,
      Buffer.from(c.ciphertext, 'base64'),
      Buffer.from(c.iv, 'base64'),
      Buffer.from(c.authTag, 'base64'),
    ).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Cifra usuario y clave como una sola credencial autenticada. El JSON queda
 * siempre dentro del sobre cifrado: la base no expone tampoco el CUIT usado
 * para iniciar sesion, que puede ser distinto del CUIT fiscal del cliente.
 */
export function cifrarAccesoArca(
  claveMaestra: Buffer,
  acceso: AccesoArca,
): CredencialCifrada {
  const contenido: AccesoArcaSerializado = { version: 2, ...acceso };
  return cifrarCredencial(claveMaestra, JSON.stringify(contenido));
}

/**
 * Lee el formato actual y conserva compatibilidad con las credenciales
 * anteriores, que guardaban solo la clave y usaban el CUIT del cliente.
 */
export function descifrarAccesoArca(
  claveMaestra: Buffer,
  c: CredencialCifrada,
  usuarioCuitAnterior: string,
): AccesoArca {
  const contenido = descifrarCredencial(claveMaestra, c);
  try {
    const acceso = JSON.parse(contenido) as Partial<AccesoArcaSerializado>;
    if (
      acceso.version === 2 &&
      typeof acceso.usuarioCuit === 'string' &&
      acceso.usuarioCuit.length > 0 &&
      typeof acceso.clave === 'string' &&
      acceso.clave.length > 0
    ) {
      return { usuarioCuit: acceso.usuarioCuit, clave: acceso.clave };
    }
  } catch {
    // Formato anterior: el texto descifrado es directamente la clave.
  }

  return {
    usuarioCuit: usuarioCuitAnterior.replace(/\D/g, ''),
    clave: contenido,
  };
}

/**
 * Identificador opaco y estable de una cuenta de acceso ARCA.
 *
 * Se usa exclusivamente como clave de concurrencia: dos clientes delegados
 * que ingresan con el mismo CUIT obtienen el mismo identificador y no pueden
 * abrir sesiones simultaneas. Al ser un HMAC con la clave maestra, la base no
 * revela el CUIT de acceso ni permite probar CUITs candidatos sin el secreto.
 */
export function identificadorAccesoArca(claveMaestra: Buffer, usuarioCuit: string): string {
  const normalizado = usuarioCuit.replace(/\D/g, '');
  if (!normalizado) throw new Error('El CUIT de acceso ARCA esta vacio.');
  return createHmac('sha256', claveMaestra)
    .update('arca-panel:cuenta-acceso:v1\0', 'utf8')
    .update(normalizado, 'utf8')
    .digest('base64url');
}

/** Comparacion en tiempo constante, para no filtrar informacion por timing. */
export function igualesSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
