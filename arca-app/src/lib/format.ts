/** Formateo en convenciones argentinas: pesos, punto de miles, coma decimal. */

const MONEDA = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

const MONEDA_EXACTA = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
});

export function pesos(n: number, exacto = false): string {
  return (exacto ? MONEDA_EXACTA : MONEDA).format(n);
}

/** YYYY-MM-DD -> DD/MM/YYYY */
export function fecha(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/** "hace 3 h", "hace 4 d", "nunca" — mas util que un timestamp exacto. */
export function desde(iso: string | null): string {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 60) return `hace ${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.round(horas / 24)} d`;
}

/** "en 4 días", "vencido hace 5 días", "hoy". */
export function plazo(dias: number): string {
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'mañana';
  if (dias > 0) return `en ${dias} días`;
  const v = Math.abs(dias);
  return `vencido hace ${v} ${v === 1 ? 'día' : 'días'}`;
}
