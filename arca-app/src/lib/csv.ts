/**
 * Exportacion a CSV para abrir en Excel en español.
 *
 * Cuatro detalles que deciden si el archivo sirve o si el contador lo abre y
 * ve todo apelotonado en una columna:
 *
 *  1. **Separador `;`**, no coma. Excel usa el separador de listas del sistema,
 *     que en configuracion regional española es `;` — porque la coma es el
 *     separador DECIMAL. Con comas, cada fila entra entera en la celda A.
 *  2. **Decimales con coma.** `1500400.5` se escribe `1500400,5`, si no Excel
 *     lo lee como texto y no se puede sumar.
 *  3. **BOM UTF-8** al principio. Sin el, Excel asume la codificacion local y
 *     "Notificación" aparece como "NotificaciÃ³n".
 *  4. **Comillas** alrededor de cualquier valor con `;`, comillas o saltos de
 *     linea, duplicando las comillas internas. Una razon social como
 *     `TRANSPORTE "EL RAPIDO" S.A.` rompe el archivo sin esto.
 */

const SEPARADOR = ';';
/** BOM UTF-8. Como escape y no literal: un caracter invisible en el fuente se
 *  pierde en cualquier copiado o normalizacion sin que nadie lo note. */
const BOM = '\uFEFF';

export type ValorCsv = string | number | null | undefined;

function celda(valor: ValorCsv): string {
  if (valor === null || valor === undefined) return '';

  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return '';
    // Coma decimal, sin separador de miles: los miles confundirian al parser
    // de Excel, que ya sabe agrupar solo.
    return String(valor).replace('.', ',');
  }

  const texto = String(valor);
  if (texto.includes(SEPARADOR) || texto.includes('"') || /[\r\n]/.test(texto)) {
    return `"${texto.replaceAll('"', '""')}"`;
  }
  return texto;
}

/** Arma el contenido del CSV. Exportada aparte para poder testearla. */
export function armarCsv(encabezados: string[], filas: ValorCsv[][]): string {
  const lineas = [encabezados.map(celda).join(SEPARADOR)];
  for (const fila of filas) lineas.push(fila.map(celda).join(SEPARADOR));
  // CRLF: es lo que espera Excel en Windows.
  return BOM + lineas.join('\r\n') + '\r\n';
}

/** Nombre de archivo sin caracteres que Windows rechaza. */
function nombreSeguro(base: string): string {
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Genera el CSV y dispara la descarga.
 *
 * Todo pasa en el navegador: los datos ya estan en pantalla, asi que pedirlos
 * de nuevo al servidor solo agregaria una ruta mas para mantener y proteger.
 */
export function descargarCsv(
  nombreBase: string,
  encabezados: string[],
  filas: ValorCsv[][],
): void {
  const contenido = armarCsv(encabezados, filas);
  const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = `${nombreSeguro(nombreBase)}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();

  // Sin esto el blob queda retenido en memoria mientras viva la pestaña.
  URL.revokeObjectURL(url);
}
