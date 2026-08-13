import type { EstadoNotificacion } from './tipos.js';

/** La lectura en ARCA prevalece sobre la vista local. */
export function estadoNotificacion(
  leidaEnArca: boolean,
  vistaAppEn: string | null,
): EstadoNotificacion {
  if (leidaEnArca) return 'LEIDA';
  if (vistaAppEn) return 'VISTA';
  return 'SIN_LEER';
}
