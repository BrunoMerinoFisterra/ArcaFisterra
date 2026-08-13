import type { Repositorio } from '../repo/tipos.js';
import type { Cliente, ResumenCliente } from './tipos.js';

/** Un vencimiento cuenta como "proximo" si cae dentro de esta ventana. */
const DIAS_VENCIMIENTO_PROXIMO = 15;

export function diasHasta(fechaIso: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const objetivo = new Date(`${fechaIso}T00:00:00`);
  return Math.round((objetivo.getTime() - hoy.getTime()) / 86_400_000);
}

export async function armarResumen(repo: Repositorio, cliente: Cliente): Promise<ResumenCliente> {
  const [notificaciones, planes, vencimientos, saldos] = await Promise.all([
    repo.notificacionesDe(cliente.id),
    repo.planesDe(cliente.id),
    repo.vencimientosDe(cliente.id),
    repo.saldosDe(cliente.id),
  ]);

  return {
    cliente,
    // El contador del tablero sigue el estado reversible de la app. La lectura
    // legal observada en ARCA permanece disponible en `notificacion.leida`.
    notificacionesSinLeer: notificaciones.filter((n) => n.leidoAppEn === null).length,
    cuotasImpagas: planes.reduce((acc, p) => acc + p.cuotasImpagas, 0),
    vencimientosProximos: vencimientos.filter((v) => {
      const d = diasHasta(v.fecha);
      return d >= 0 && d <= DIAS_VENCIMIENTO_PROXIMO;
    }).length,
    saldoTotal: saldos.reduce(
      (acc, s) => acc + s.saldo + s.interesResarcitorio + s.interesPunitorio,
      0,
    ),
    tieneSaldos: saldos.length > 0,
  };
}

/**
 * Ordena por lo que necesita atencion primero.
 *
 * Un tablero con 40 clientes es inutil si hay que escanearlos todos: lo urgente
 * tiene que quedar arriba sin que nadie filtre nada. El orden se calcula en el
 * servidor para que no dependa de que cada cliente HTTP lo reimplemente igual.
 */
export function porUrgencia(a: ResumenCliente, b: ResumenCliente): number {
  const puntaje = (r: ResumenCliente) =>
    (r.cliente.estadoSync === 'ERROR' ? 1000 : 0) +
    (r.cliente.estadoSync === 'NECESITA_HUMANO' ? 800 : 0) +
    (r.cliente.estadoSync === 'NUNCA' ? 600 : 0) +
    r.cuotasImpagas * 50 +
    r.notificacionesSinLeer * 20 +
    r.vencimientosProximos * 5;
  return puntaje(b) - puntaje(a);
}
