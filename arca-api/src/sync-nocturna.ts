import type { ConfigSyncNocturna } from './config.js';
import type { Repositorio } from './repo/tipos.js';

/**
 * Sincronización automática nocturna.
 *
 * Vive en la API y no en el worker porque la API es el único componente que
 * CREA jobs: esto es exactamente lo que hace el botón "Sincronizar", pero
 * disparado por reloj en vez de por una persona. El worker sigue haciendo lo
 * único que hace — tomar de la cola y ejecutar.
 *
 * Se apoya en tres invariantes que ya existen, en vez de agregar estado nuevo:
 *
 *  1. `encolarSync` es idempotente por (cliente, módulo): si ya hay un job
 *     activo devuelve ese mismo. Pasar dos veces por la ventana no duplica.
 *  2. `finalizarJob` actualiza `ultimo_sync` AUNQUE el job falle. Por eso
 *     filtrar por "sin intento reciente" evita el reintento en loop sin
 *     necesidad de registrar en ninguna tabla que la noche ya corrió.
 *  3. Si la credencial resulta mala, `finalizarJob` marca `estado_credencial`,
 *     y `clientesParaSyncAutomatica` deja ese cliente afuera de ahí en más.
 *
 * Juntas, esas tres hacen que reiniciar la API a mitad de la ventana sea
 * inofensivo: la pasada se repite y no encola nada de más.
 */

const ZONA_HORARIA = 'America/Buenos_Aires';
const MODULO = 'sincronizacion-completa';

/** Hora del día (0-23) en Buenos Aires, sin importar el huso del contenedor. */
export function horaEnBuenosAires(instante = new Date()): number {
  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONA_HORARIA,
    hour: '2-digit',
    hour12: false,
  }).format(instante);
  return Number(hora);
}

export function estaEnVentana(config: ConfigSyncNocturna, instante = new Date()): boolean {
  const hora = horaEnBuenosAires(instante);
  return hora >= config.horaDesde && hora < config.horaHasta;
}

/**
 * Una pasada: encola a todos los que corresponde y devuelve cuántos.
 *
 * Exportada aparte del temporizador para poder probarla sin esperar de noche.
 */
export async function pasadaNocturna(
  repo: Repositorio,
  config: ConfigSyncNocturna,
  instante = new Date(),
): Promise<{ encolados: number; yaEnCola: number; total: number }> {
  const corte = new Date(
    instante.getTime() - config.minimoHorasEntreIntentos * 3_600_000,
  ).toISOString();
  const candidatos = await repo.clientesParaSyncAutomatica(corte);

  let encolados = 0;
  let yaEnCola = 0;
  for (const cliente of candidatos) {
    try {
      // Se pregunta ANTES de encolar. `encolarSync` es idempotente y devuelve
      // el job que ya existía, pero ese job viene igual de PENDING con cero
      // intentos: por la respuesta sola no se distingue de uno nuevo, y el log
      // terminaría diciendo que encoló cosas que no encoló.
      const activos = (await repo.jobsDe(cliente.id)).filter((job) =>
        ['PENDING', 'RUNNING'].includes(job.estado),
      );
      if (activos.length > 0) {
        yaEnCola += 1;
        continue;
      }
      await repo.encolarSync(cliente.id, MODULO);
      encolados += 1;
    } catch (error) {
      // Un cliente que falla no puede frenar a los demás.
      console.error(
        `  sync nocturna: no se pudo encolar ${cliente.razonSocial}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { encolados, yaEnCola, total: candidatos.length };
}

/**
 * Arranca el temporizador. Devuelve una función para detenerlo (los tests la
 * usan; en producción el proceso muere con el contenedor).
 */
export function iniciarSyncNocturna(repo: Repositorio, config: ConfigSyncNocturna): () => void {
  if (!config.activa) {
    console.log('  sync nocturna: desactivada');
    return () => {};
  }

  console.log(
    `  sync nocturna: activa entre las ${config.horaDesde} y las ${config.horaHasta} ` +
      `(hora de Buenos Aires), revisando cada ${config.intervaloMinutos} min`,
  );

  let corriendo = false;
  const revisar = () => {
    // Una pasada lenta no puede solaparse con la siguiente.
    if (corriendo || !estaEnVentana(config)) return;
    corriendo = true;
    void pasadaNocturna(repo, config)
      .then(({ encolados, yaEnCola, total }) => {
        if (total > 0) {
          console.log(
            `  sync nocturna: ${encolados} encolados, ${yaEnCola} ya en cola, ` +
              `de ${total} clientes pendientes`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error('  sync nocturna: la pasada falló:', error);
      })
      .finally(() => {
        corriendo = false;
      });
  };

  const temporizador = setInterval(revisar, config.intervaloMinutos * 60_000);
  // No mantiene vivo el proceso por sí solo: si la API se cierra, no lo demora.
  temporizador.unref();
  revisar();
  return () => clearInterval(temporizador);
}
