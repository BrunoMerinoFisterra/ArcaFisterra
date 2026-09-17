import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorApi, marcarResuelto, obtenerAgenda } from '../api/client';
import type { Agenda as AgendaDatos, ItemAgenda, TipoPendiente } from '../types';
import { fecha, plazo } from '../lib/format';
import { plural } from '../lib/plural';
import { Badge } from '../components/Badge';

/**
 * La agenda de la cartera. EN PRUEBA.
 *
 * El resto del panel se organiza por empresa, que es como están guardados los
 * datos. Ésta se organiza por fecha, que es como se trabaja: la pregunta de la
 * mañana no es "¿cómo viene esta empresa?" sino "¿qué tengo que hacer hoy?", y
 * contestarla hasta ahora obligaba a entrar a cada empresa y sumar de memoria.
 *
 * Vive en su propia URL y no reemplaza al tablero a propósito: la idea es que
 * se use unos días y recién después se decida si pasa a ser la entrada.
 */

const VENTANAS = [7, 15, 30, 60];

/** Los cortes que un contador usa igual cuando mira una lista de vencimientos. */
function bloqueDe(item: ItemAgenda): string {
  if (item.dias === null) return 'Sin fecha informada';
  if (item.dias < 0) return 'Vencido';
  if (item.dias <= 1) return 'Hoy y mañana';
  if (item.dias <= 7) return 'Esta semana';
  return 'Más adelante';
}

const ORDEN_BLOQUES = ['Vencido', 'Hoy y mañana', 'Esta semana', 'Más adelante', 'Sin fecha informada'];

const idDe = (i: ItemAgenda) => `${i.clienteId}|${i.tipo}|${i.clave}`;

export default function Agenda() {
  const [datos, setDatos] = useState<AgendaDatos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bloqueoCupo, setBloqueoCupo] = useState<string | null>(null);
  const [ventana, setVentana] = useState(15);
  const [verResueltos, setVerResueltos] = useState(false);
  const [enVuelo, setEnVuelo] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setDatos(null);
    setError(null);
    obtenerAgenda(ventana)
      .then((a) => {
        if (vigente) setDatos(a);
      })
      .catch((e: unknown) => {
        if (!vigente) return;
        if (e instanceof ErrorApi && e.status === 409) setBloqueoCupo(e.message);
        else setError(e instanceof Error ? e.message : 'No se pudo cargar la agenda.');
      });
    return () => {
      vigente = false;
    };
  }, [ventana]);

  /**
   * Marca y refleja el cambio sin recargar la agenda entera.
   *
   * Recargar sería más simple, pero la lista se reordena y el ítem que acabás
   * de tildar salta de lugar bajo el cursor. Tocar sólo esa fila deja la lista
   * quieta, que es lo que permite ir tildando varias seguidas.
   */
  async function alternar(item: ItemAgenda) {
    if (item.tipo === 'notificacion') return;
    const id = idDe(item);
    const resuelto = item.resueltoEn === null;
    setEnVuelo(id);
    setError(null);
    try {
      await marcarResuelto(item.clienteId, item.tipo as TipoPendiente, item.clave, resuelto);
      setDatos((actual) => {
        if (!actual) return actual;
        const items = actual.items.map((i) =>
          idDe(i) === id ? { ...i, resueltoEn: resuelto ? new Date().toISOString() : null } : i,
        );
        const pendientes = items.filter((i) => i.resueltoEn === null);
        return {
          ...actual,
          items,
          vencidos: pendientes.filter((i) => i.dias !== null && i.dias < 0).length,
          proximos: pendientes.filter((i) => i.dias !== null && i.dias >= 0).length,
          resueltos: items.length - pendientes.length,
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la marca.');
    } finally {
      setEnVuelo(null);
    }
  }

  if (bloqueoCupo) {
    return (
      <div className="aviso aviso--bloqueo" role="alert">
        <strong>Tu cuenta está fuera de cupo.</strong>
        <span>{bloqueoCupo}</span>
        <Link className="btn btn--primario" to="/clientes">
          Regularizar clientes
        </Link>
      </div>
    );
  }

  const visibles = (datos?.items ?? []).filter((i) => verResueltos || i.resueltoEn === null);
  const bloques = ORDEN_BLOQUES.map((nombre) => ({
    nombre,
    items: visibles.filter((i) => bloqueDe(i) === nombre),
  })).filter((b) => b.items.length > 0);

  return (
    <>
      <header className="encabezado-pagina">
        <h1 className="titulo-pareado">
          <strong>AGENDA</strong>
          <span>de toda la cartera</span>
        </h1>
        <p>Qué vence y qué llegó, sin entrar empresa por empresa.</p>
      </header>

      <div className="aviso" role="status">
        <strong>Pantalla en prueba.</strong> Convive con el tablero y no reemplaza nada. Si te
        resulta más útil que entrar cliente por cliente, decilo — y si no, también.
      </div>

      {error && <div className="aviso aviso--error">{error}</div>}

      <div className="tira-kpi">
        <Kpi valor={datos?.vencidos ?? '—'} etiqueta="Vencidos" tono={datos?.vencidos ? 'error' : 'ok'} />
        <Kpi
          valor={datos?.proximos ?? '—'}
          etiqueta={`Próximos ${datos?.ventanaDias ?? ventana} días`}
          tono={datos?.proximos ? 'alerta' : 'ok'}
        />
        <Kpi valor={datos?.resueltos ?? '—'} etiqueta="Dados por hechos" />
      </div>

      <div className="agenda-controles">
        <label className="campo">
          <span className="campo__etiqueta">Ventana</span>
          <select value={ventana} onChange={(e) => setVentana(Number(e.target.value))}>
            {VENTANAS.map((d) => (
              <option key={d} value={d}>
                Próximos {d} días
              </option>
            ))}
          </select>
          <span className="campo__ayuda">Lo ya vencido se muestra siempre, esté donde esté.</span>
        </label>
        <label className="agenda-controles__check">
          <input
            type="checkbox"
            checked={verResueltos}
            onChange={(e) => setVerResueltos(e.target.checked)}
          />
          Ver lo que ya di por hecho
        </label>
      </div>

      {datos === null && !error && <p className="vacio">Cargando agenda…</p>}

      {datos !== null && bloques.length === 0 && (
        <p className="vacio">
          No hay nada pendiente en los próximos {datos.ventanaDias} días.
          {datos.resueltos > 0 && !verResueltos && (
            <>
              {' '}
              Hay {plural(datos.resueltos, 'ítem dado por hecho', 'ítems dados por hechos')}.
            </>
          )}
        </p>
      )}

      {bloques.map((bloque) => (
        <section className="bloque" key={bloque.nombre}>
          <h2 className="bloque__titulo">
            {bloque.nombre} · {plural(bloque.items.length, 'ítem', 'ítems')}
          </h2>
          <ul className="agenda">
            {bloque.items.map((item) => (
              <Fila
                key={idDe(item)}
                item={item}
                guardando={enVuelo === idDe(item)}
                alAlternar={() => void alternar(item)}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Fila({
  item,
  guardando,
  alAlternar,
}: {
  item: ItemAgenda;
  guardando: boolean;
  alAlternar: () => void;
}) {
  const hecho = item.resueltoEn !== null;
  const esNotificacion = item.tipo === 'notificacion';
  const destino = `/cliente/${item.clienteId}?empresa=${item.contribuyenteCuit}`;

  return (
    <li className={hecho ? 'agenda__fila agenda__fila--hecha' : 'agenda__fila'}>
      {/* Las comunicaciones no se tildan acá: ya tienen su propio estado de
          lectura en el detalle, y dos marcas para lo mismo se contradicen. */}
      {esNotificacion ? (
        <span className="agenda__marca agenda__marca--vacia" aria-hidden="true" />
      ) : (
        <input
          type="checkbox"
          className="agenda__marca"
          checked={hecho}
          disabled={guardando}
          onChange={alAlternar}
          aria-label={`Dar por hecho ${item.titulo} de ${item.empresa}`}
        />
      )}

      <div className="agenda__que">
        <div className="agenda__titulo">
          {item.titulo}
          {esNotificacion && <Badge tono="alerta">comunicación</Badge>}
        </div>
        {item.detalle && <div className="tenue">{item.detalle}</div>}
      </div>

      <div className="agenda__empresa">
        <Link to={destino}>{item.empresa}</Link>
        <div className="tenue">vía {item.cuenta}</div>
      </div>

      <div className="agenda__cuando">
        {item.fecha ? (
          <>
            <div className={item.dias !== null && item.dias < 0 ? 'monto--negativo' : undefined}>
              {item.dias === null ? '' : plazo(item.dias)}
            </div>
            <div className="tenue">{fecha(item.fecha)}</div>
          </>
        ) : (
          <span className="tenue">sin fecha</span>
        )}
      </div>
    </li>
  );
}

function Kpi({
  valor,
  etiqueta,
  tono = 'neutro',
}: {
  valor: number | string;
  etiqueta: string;
  tono?: 'ok' | 'alerta' | 'error' | 'neutro';
}) {
  return (
    <div className="kpi">
      <div className={`kpi__valor kpi__valor--${tono}`}>{valor}</div>
      <div className="kpi__etiqueta">{etiqueta}</div>
    </div>
  );
}
