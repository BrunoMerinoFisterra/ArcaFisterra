import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export type TipoComprobantePersistido = 'EMITIDO' | 'RECIBIDO';

export interface ComprobanteParseado {
  tipo: TipoComprobantePersistido;
  fecha: string;
  codigoComprobante: number;
  tipoComprobante: string;
  puntoVenta: number;
  numero: number;
  contraparte: string;
  cuitContraparte: string;
  neto: number;
  iva: number;
  total: number;
}

const NOMBRES_COMPROBANTE: Readonly<Record<number, string>> = {
  1: 'Factura A',
  2: 'Nota de Débito A',
  3: 'Nota de Crédito A',
  4: 'Recibo A',
  5: 'Nota de Venta al Contado A',
  6: 'Factura B',
  7: 'Nota de Débito B',
  8: 'Nota de Crédito B',
  9: 'Recibo B',
  10: 'Nota de Venta al Contado B',
  11: 'Factura C',
  12: 'Nota de Débito C',
  13: 'Nota de Crédito C',
  15: 'Recibo C',
  19: 'Factura E',
  20: 'Nota de Débito E',
  21: 'Nota de Crédito E',
  51: 'Factura M',
  52: 'Nota de Débito M',
  53: 'Nota de Crédito M',
  201: 'Factura de Crédito Electrónica MiPyMEs A',
  202: 'Nota de Débito FCE MiPyMEs A',
  203: 'Nota de Crédito FCE MiPyMEs A',
  206: 'Factura de Crédito Electrónica MiPyMEs B',
  207: 'Nota de Débito FCE MiPyMEs B',
  208: 'Nota de Crédito FCE MiPyMEs B',
  211: 'Factura de Crédito Electrónica MiPyMEs C',
  212: 'Nota de Débito FCE MiPyMEs C',
  213: 'Nota de Crédito FCE MiPyMEs C',
};

const CODIGOS_NOTA_CREDITO = new Set([3, 8, 13, 21, 53, 203, 208, 213]);

export async function leerComprobantesDesdeArchivo(
  archivo: string,
  tipo: TipoComprobantePersistido,
): Promise<ComprobanteParseado[]> {
  return parsearComprobantesCsv(extraerTextoCsv(await readFile(archivo)), tipo);
}

/** ARCA entrega un ZIP aunque el archivo exterior se llame `.csv`. */
export function extraerTextoCsv(archivo: Buffer): string {
  const datos = esZip(archivo) ? extraerPrimerArchivoZip(archivo) : archivo;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(datos).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(datos).replace(/^\uFEFF/, '');
  }
}

export function parsearComprobantesCsv(
  contenido: string,
  tipo: TipoComprobantePersistido,
): ComprobanteParseado[] {
  const filas = parsearCsv(contenido).filter((fila) => fila.some((campo) => campo.trim() !== ''));
  const cabecera = filas.shift();
  if (!cabecera) return [];

  const indices = new Map(cabecera.map((nombre, indice) => [normalizar(nombre), indice]));
  const campo = (fila: string[], nombre: string): string => {
    const indice = indices.get(normalizar(nombre));
    if (indice === undefined) throw new Error(`El CSV de ARCA no contiene la columna "${nombre}".`);
    return fila[indice]?.trim() ?? '';
  };

  return filas.map((fila, indiceFila) => {
    try {
      const codigo = entero(campo(fila, 'Tipo de Comprobante'), 'Tipo de Comprobante');
      const esCredito = CODIGOS_NOTA_CREDITO.has(codigo);
      const nombre =
        tipo === 'RECIBIDO'
          ? campo(fila, 'Denominación Emisor')
          : campo(fila, 'Denominación Receptor');
      const documento =
        tipo === 'RECIBIDO' ? campo(fila, 'Nro. Doc. Emisor') : campo(fila, 'Nro. Doc. Receptor');

      return {
        tipo,
        fecha: fechaIso(campo(fila, 'Fecha de Emisión')),
        codigoComprobante: codigo,
        tipoComprobante: NOMBRES_COMPROBANTE[codigo] ?? `Comprobante ${codigo}`,
        puntoVenta: entero(campo(fila, 'Punto de Venta'), 'Punto de Venta'),
        numero: entero(campo(fila, 'Número Desde'), 'Número Desde'),
        contraparte: nombre || 'Sin denominación',
        cuitContraparte: formatearDocumento(documento),
        neto: conSigno(numero(campo(fila, 'Imp. Neto Gravado Total')), esCredito),
        iva: conSigno(numero(campo(fila, 'Total IVA')), esCredito),
        total: conSigno(numero(campo(fila, 'Imp. Total')), esCredito),
      };
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      throw new Error(`Fila ${indiceFila + 2} del CSV invalida: ${detalle}`);
    }
  });
}

function normalizar(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function numero(valor: string): number {
  const limpio = valor.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (limpio === '') return 0;
  const resultado = Number(limpio);
  if (!Number.isFinite(resultado)) throw new Error(`importe invalido: "${valor}"`);
  return resultado;
}

function entero(valor: string, nombre: string): number {
  const resultado = Number(valor.replace(/\D/g, ''));
  if (!Number.isSafeInteger(resultado)) throw new Error(`${nombre} invalido: "${valor}"`);
  return resultado;
}

function conSigno(valor: number, negativo: boolean): number {
  return negativo ? -Math.abs(valor) : valor;
}

function fechaIso(valor: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(valor);
  if (!partes) throw new Error(`fecha invalida: "${valor}"`);
  return `${partes[3]}-${partes[2]}-${partes[1]}`;
}

function formatearDocumento(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length !== 11) return valor || '—';
  return `${digitos.slice(0, 2)}-${digitos.slice(2, 10)}-${digitos.slice(10)}`;
}

/** Parser CSV pequeño pero completo para separador `;`, comillas y saltos internos. */
function parsearCsv(contenido: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let valor = '';
  let entreComillas = false;

  for (let i = 0; i < contenido.length; i += 1) {
    const caracter = contenido[i]!;
    if (entreComillas) {
      if (caracter === '"') {
        if (contenido[i + 1] === '"') {
          valor += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        valor += caracter;
      }
      continue;
    }

    if (caracter === '"' && valor.length === 0) entreComillas = true;
    else if (caracter === ';') {
      fila.push(valor);
      valor = '';
    } else if (caracter === '\n') {
      fila.push(valor.replace(/\r$/, ''));
      filas.push(fila);
      fila = [];
      valor = '';
    } else valor += caracter;
  }

  if (entreComillas) throw new Error('CSV invalido: comillas sin cerrar.');
  if (valor.length > 0 || fila.length > 0) {
    fila.push(valor.replace(/\r$/, ''));
    filas.push(fila);
  }
  return filas;
}

function esZip(datos: Buffer): boolean {
  return datos.length >= 4 && datos.readUInt32LE(0) === 0x04034b50;
}

/** Extrae la primera entrada usando el directorio central del ZIP. */
function extraerPrimerArchivoZip(zip: Buffer): Buffer {
  const minimo = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minimo; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP invalido: no se encontro el directorio central.');
  if (zip.readUInt16LE(eocd + 10) < 1) throw new Error('El ZIP de ARCA esta vacio.');

  const central = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(central) !== 0x02014b50) {
    throw new Error('ZIP invalido: entrada central ausente.');
  }
  const flags = zip.readUInt16LE(central + 8);
  if ((flags & 1) !== 0) throw new Error('El ZIP de ARCA esta cifrado y no se puede leer.');
  const metodo = zip.readUInt16LE(central + 10);
  const comprimido = zip.readUInt32LE(central + 20);
  const esperado = zip.readUInt32LE(central + 24);
  const local = zip.readUInt32LE(central + 42);
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP invalido: entrada local ausente.');
  const nombre = zip.readUInt16LE(local + 26);
  const extra = zip.readUInt16LE(local + 28);
  const inicio = local + 30 + nombre + extra;
  const fin = inicio + comprimido;
  if (fin > zip.length) throw new Error('ZIP invalido: datos truncados.');

  const datos = zip.subarray(inicio, fin);
  const resultado = metodo === 0 ? Buffer.from(datos) : metodo === 8 ? inflateRawSync(datos) : null;
  if (!resultado) throw new Error(`ZIP con metodo de compresion no soportado: ${metodo}.`);
  if (resultado.length !== esperado) throw new Error('ZIP invalido: tamaño descomprimido incorrecto.');
  return resultado;
}
