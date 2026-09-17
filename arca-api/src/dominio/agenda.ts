import type { Repositorio } from '../repo/tipos.js';
import { diasHasta } from './resumen.js';
import type {
  Agenda,
  Cliente,
  DeclaracionJuradaPendiente,
  ItemAgenda,
  Vencimiento,
} from './tipos.js';

/**
 * La agenda: qué vence y qué llegó, en TODA la cartera.
 *
 * El resto del panel se organiza por empresa, que es como está guardado. El
 * trabajo del día se organiza por fecha, que es otra cosa: la pregunta real no
 * es "¿cómo viene esta empresa?" sino "¿qué tengo que hacer hoy?". Contestarla
 * hoy obliga a entrar a cada empresa y sumar de memoria.
 *
 * Se arma sobre las mismas lecturas por cliente que ya usa el tablero, sin
 * métodos nuevos de repositorio. Son 3 consultas por cuenta sobre tablas
 * chicas e indexadas por `cliente_id`; con la cartera actual —14 cuentas— eso
 * es ruido. Si algún día molesta, el lugar para arreglarlo es el repositorio y
 * no esta función.
 */

/** Ventana por defecto, la misma que usa el tablero para "próximo". */
export const DIAS_AGENDA = 15;

/**
 * Identifica una obligación ENTRE sincronizaciones.
 *
 * No se puede usar el `id`: `reemplazarVencimientos` borra todo y reinserta con
 * `randomUUID()`, así que el id de hoy no es el de mañana. Esto es el mismo
 * tuple que declara el UNIQUE de la tabla, que es lo que de verdad identifica
 * la obligación.
 */
export function claveVencimiento(v: Vencimiento): string {
  return [
    v.contribuyenteCuit,
    v.impuesto,
    v.concepto,
    v.subconcepto,
    v.periodo,
    v.anticipoCuota,
    v.fecha,
    v.detalle,
  ].join('|');
}

/** Igual que `claveVencimiento`, con el UNIQUE de `arca_ddjj_pendientes`. */
export function claveDdjj(d: DeclaracionJuradaPendiente): string {
  return [
    d.contribuyenteCuit,
    d.establecimiento,
    d.impuesto,
    d.concepto,
    d.subconcepto,
    d.periodo,
    d.fecha ?? '',
  ].join('|');
}

/** Lo que se ve primero: lo vencido, después lo que vence antes, y al final lo sin fecha. */
function porFecha(a: ItemAgenda, b: ItemAgenda): number {
  if (a.dias === null && b.dias === null) return a.empresa.localeCompare(b.empresa);
  if (a.dias === null) return 1;
  if (b.dias === null) return -1;
  return a.dias - b.dias || a.empresa.localeCompare(b.empresa);
}

export async function armarAgenda(
  repo: Repositorio,
  usuarioId: string,
  clientes: readonly Cliente[],
  ventanaDias = DIAS_AGENDA,
): Promise<Agenda> {
  // `Map<string, string>` explicito: sin eso TS infiere la clave como un
  // template literal con `tipo` acotado a la union, y `marcaDe` no puede
  // consultarla con un string comun.
  const marcas = new Map<string, string>(
    (await repo.resueltosDe(usuarioId)).map(
      (m) => [`${m.clienteId}|${m.tipo}|${m.clave}`, m.resueltoEn] as const,
    ),
  );

  const porCliente = await Promise.all(
    clientes.map(async (cliente) => ({
      cliente,
      vencimientos: await repo.vencimientosDe(cliente.id),
      ddjj: await repo.ddjjPendientesDe(cliente.id),
      notificaciones: await repo.notificacionesDe(cliente.id),
    })),
  );

  // Los nombres de empresa se resuelven de una sola vez para todos los CUIT que
  // aparecen: pedirlos por fila serían cientos de consultas iguales.
  const cuits = porCliente.flatMap((c) => [
    ...c.vencimientos.map((v) => v.contribuyenteCuit),
    ...c.ddjj.map((d) => d.contribuyenteCuit),
    ...c.notificaciones.map((n) => n.contribuyenteCuit),
  ]);
  const nombres = await repo.nombresDeContribuyentes(cuits);
  const empresaDe = (cuit: string) => nombres[cuit.replace(/\D/g, '')] ?? cuit;

  const items: ItemAgenda[] = [];

  for (const { cliente, vencimientos, ddjj, notificaciones } of porCliente) {
    const marcaDe = (tipo: string, clave: string) =>
      marcas.get(`${cliente.id}|${tipo}|${clave}`) ?? null;

    for (const v of vencimientos) {
      const dias = diasHasta(v.fecha);
      // Lo ya vencido entra SIEMPRE, por lejos que quede: es lo que más urge y
      // esconderlo por estar fuera de la ventana sería justo al revés.
      if (dias > ventanaDias) continue;
      const clave = claveVencimiento(v);
      items.push({
        tipo: 'vencimiento',
        clave,
        clienteId: cliente.id,
        cuenta: cliente.razonSocial,
        contribuyenteCuit: v.contribuyenteCuit,
        empresa: empresaDe(v.contribuyenteCuit),
        titulo: v.impuesto,
        detalle: [v.concepto, v.subconcepto, v.periodo, v.anticipoCuota, v.detalle]
          .filter(Boolean)
          .join(' · '),
        fecha: v.fecha,
        dias,
        resueltoEn: marcaDe('vencimiento', clave),
      });
    }

    for (const d of ddjj) {
      const dias = d.fecha ? diasHasta(d.fecha) : null;
      if (dias !== null && dias > ventanaDias) continue;
      const clave = claveDdjj(d);
      items.push({
        tipo: 'ddjj',
        clave,
        clienteId: cliente.id,
        cuenta: cliente.razonSocial,
        contribuyenteCuit: d.contribuyenteCuit,
        empresa: empresaDe(d.contribuyenteCuit),
        titulo: d.impuesto,
        detalle: [d.establecimiento, d.concepto, d.subconcepto, d.periodo]
          .filter(Boolean)
          .join(' · '),
        fecha: d.fecha,
        dias,
        resueltoEn: marcaDe('ddjj', clave),
      });
    }

    // Las comunicaciones entran por estar SIN LEER, no por fecha: una intimación
    // de hace un mes que nadie abrió sigue siendo trabajo pendiente. Van de solo
    // lectura acá — ya tienen su propio estado en el detalle del cliente.
    for (const n of notificaciones) {
      if (n.leidoAppEn !== null) continue;
      items.push({
        tipo: 'notificacion',
        clave: n.id,
        clienteId: cliente.id,
        cuenta: cliente.razonSocial,
        contribuyenteCuit: n.contribuyenteCuit,
        empresa: empresaDe(n.contribuyenteCuit),
        titulo: n.asunto,
        detalle: n.organismo,
        fecha: n.fecha,
        dias: diasHasta(n.fecha),
        resueltoEn: null,
      });
    }
  }

  items.sort(porFecha);
  const pendientes = items.filter((i) => i.resueltoEn === null);
  return {
    ventanaDias,
    items,
    vencidos: pendientes.filter((i) => i.dias !== null && i.dias < 0).length,
    proximos: pendientes.filter((i) => i.dias !== null && i.dias >= 0).length,
    resueltos: items.length - pendientes.length,
  };
}
