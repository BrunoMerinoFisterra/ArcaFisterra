import type { Page } from 'playwright';
import { listarContribuyentesDeComprobantes } from './comprobantes.js';

/**
 * Prueba que una clave fiscal pueda actuar por un contribuyente.
 *
 * Es el unico control que separa "dos oficinas comparten una empresa" de
 * "cualquiera lee la carpeta fiscal ajena escribiendo un CUIT". El CUIT de un
 * contribuyente es publico: sin esta prueba, escribirlo alcanzaria.
 *
 * La comparacion es por coincidencia EXACTA de CUIT, la misma regla que ya
 * respeta el resto del worker al elegir representado. Nunca por razon social
 * ni por posicion en la lista.
 *
 * Quien llama tiene que haber hecho login con una sesion NUEVA. Reusar la
 * sesion guardada del cliente aprobaria el pedido sin haber probado nada: esa
 * sesion es de la credencial que ya estaba cargada, no de la que se envio.
 */
export async function verificarAccesoAContribuyente(
  page: Page,
  usuarioCuit: string,
  cuitContribuyente: string,
): Promise<{ autorizado: boolean; detalle: string }> {
  const objetivo = cuitContribuyente.replace(/\D/g, '');
  const propio = usuarioCuit.replace(/\D/g, '');

  const representados = await listarContribuyentesDeComprobantes(page);

  // Lista vacia = el portal no ofrecio elegir, o sea que la clave actua por
  // una sola persona: la suya. Solo alcanza si es justamente la que se pide.
  if (representados.length === 0) {
    if (propio === objetivo) {
      return { autorizado: true, detalle: 'La clave fiscal es la del propio contribuyente.' };
    }
    return {
      autorizado: false,
      detalle:
        'Esa clave fiscal no representa a ningun otro contribuyente en ARCA, ' +
        'asi que no puede acceder a esta empresa.',
    };
  }

  if (representados.includes(objetivo)) {
    return {
      autorizado: true,
      detalle: `ARCA confirma que la clave puede actuar por ${cuitContribuyente}.`,
    };
  }

  // El detalle NO enumera los CUIT que si representa: son datos de la cartera
  // de quien pide, y el mensaje termina guardado en la solicitud.
  return {
    autorizado: false,
    detalle:
      `ARCA no incluye a ${cuitContribuyente} entre los contribuyentes que esa clave ` +
      'fiscal puede representar.',
  };
}
