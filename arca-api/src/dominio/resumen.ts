import type { Repositorio } from '../repo/tipos.js';
import type {
  Cliente,
  EmpresaRepresentada,
  ResumenCliente,
  ResumenEmpresa,
} from './tipos.js';

/** Un vencimiento cuenta como "proximo" si cae dentro de esta ventana. */
const DIAS_VENCIMIENTO_PROXIMO = 15;

export function diasHasta(fechaIso: string): number {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const objetivo = new Date(`${fechaIso}T00:00:00`);
  return Math.round((objetivo.getTime() - hoy.getTime()) / 86_400_000);
}

/**
 * El mismo resumen, pero de UNA empresa representada.
 *
 * Reusa las mismas lecturas: desde que aceptan un CUIT, la unica diferencia
 * entre "toda la cuenta" y "esta empresa" es ese argumento. Duplicar el calculo
 * seria la forma segura de que un dia el tablero y el detalle no coincidan.
 *
 * Lleva ademas el estado de la cuenta que la representa: si esa clave fiscal
 * esta invalida, la empresa no se puede sincronizar aunque no tenga nada raro
 * en sus propios datos, y el contador tiene que poder verlo sin entrar.
 */
export async function armarResumenEmpresa(
  repo: Repositorio,
  empresa: EmpresaRepresentada,
  cuenta: Cliente,
): Promise<ResumenEmpresa> {
  const [notificaciones, planes, vencimientos, saldos] = await Promise.all([
    repo.notificacionesDe(empresa.clienteId, empresa.cuit),
    repo.planesDe(empresa.clienteId, empresa.cuit),
    repo.vencimientosDe(empresa.clienteId, empresa.cuit),
    repo.saldosDe(empresa.clienteId, empresa.cuit),
  ]);

  return {
    empresa,
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
    estadoCredencial: cuenta.estadoCredencial,
    estadoSync: cuenta.estadoSync,
  };
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
/**
 * El mismo criterio, aplicado a empresas.
 *
 * El estado que pesa es el de la CUENTA, porque es lo que impide sincronizar:
 * una empresa impecable cuya clave fiscal esta invalida tiene que aparecer
 * arriba, ya que sus numeros se estan quedando viejos en silencio.
 */
export function porUrgenciaEmpresa(a: ResumenEmpresa, b: ResumenEmpresa): number {
  const puntaje = (r: ResumenEmpresa) =>
    (r.estadoSync === 'ERROR' ? 1000 : 0) +
    (r.estadoSync === 'NECESITA_HUMANO' ? 800 : 0) +
    (r.estadoSync === 'NUNCA' ? 600 : 0) +
    (r.estadoCredencial !== 'OK' ? 400 : 0) +
    r.cuotasImpagas * 50 +
    r.notificacionesSinLeer * 20 +
    r.vencimientosProximos * 5;
  return puntaje(b) - puntaje(a);
}

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
