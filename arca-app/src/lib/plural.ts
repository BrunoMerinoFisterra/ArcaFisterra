/**
 * Pluralizacion en castellano.
 *
 * No alcanza con agregar "es": "notificación" pierde la tilde al pluralizar
 * ("notificaciones"), y concatenar sufijos daba "notificaciónes". Por eso las
 * dos formas se escriben completas.
 */
export function plural(n: number, singular: string, pluralForma: string): string {
  return `${n} ${n === 1 ? singular : pluralForma}`;
}

/**
 * "Ferretería Belgrano" -> "ferreteria-belgrano".
 *
 * Descompone los acentos y los descarta ANTES de filtrar. Reemplazar todo lo
 * que no sea [a-z0-9] de una convierte la "í" en separador y da
 * "ferreter-a-belgrano".
 */
export function aSlug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
