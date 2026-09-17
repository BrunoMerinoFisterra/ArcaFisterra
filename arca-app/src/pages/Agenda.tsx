import { useEffect, useId, useMemo, useState } from 'react';
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

type Agrupacion = 'urgencia' | 'empresa' | 'cuenta' | 'tipo';
type TipoItem = ItemAgenda['tipo'];

const AGRUPACIONES: ReadonlyArray<[Agrupacion, string]> = [
  ['urgencia', 'Urgencia'],
  ['empresa', 'Empresa'],
  ['cuenta', 'Cuenta'],
  ['tipo', 'Tipo'],
];

const ETIQUETA_TIPO: Record<TipoItem, string> = {
  vencimiento: 'Vencimientos',
  ddjj: 'DDJJ pendientes',
  notificacion: 'Comunicaciones',
};

/** Los cortes que un contador usa igual cuando mira una lista de vencimientos. */
function bloqueDeUrgencia(item: ItemAgenda): string {
  if (item.dias === null) return 'Sin fecha informada';
  if (item.dias < 0) return 'Vencido';
  if (item.dias <= 1) return 'Hoy y mañana';
  if (item.dias <= 7) return 'Esta semana';
  return 'Más adelante';
}

const ORDEN_URGENCIA = [
  'Vencido',
  'Hoy y mañana',
  'Esta semana',
  'Más adelante',
  'Sin fecha informada',
];

function claveGrupo(item: ItemAgenda, agrupacion: Agrupacion): string {
  if (agrupacion === 'empresa') return item.empresa;
  if (agrupacion === 'cuenta') return item.cuenta;
  if (agrupacion === 'tipo') return ETIQUETA_TIPO[item.tipo];
  return bloqueDeUrgencia(item);
}

const idDe = (i: ItemAgenda) => `${i.clienteId}|${i.tipo}|${i.clave}`;

/**
 * Qué grupos quedaron plegados, entre visitas.
 *
 * En `localStorage` y no en el estado a secas porque si no se despliega todo
 * cada vez que se entra, y plegar "Más adelante" una vez por sesión es
 * exactamente el trabajo que esta función viene a ahorrar. Es una comodidad de
 * cada navegador: nada que deba viajar al servidor.
 */
const CLAVE_PLEGADOS = 'arcapanel.agenda.plegados';

function leerPlegados(): Set<string> {
  try {
    const guardado = localStorage.getItem(CLAVE_PLEGADOS);
    return new Set(guardado ? (JSON.parse(guardado) as string[]) : []);
  } catch {
    // Modo privado, almacenamiento bloqueado o un JSON viejo y roto: se arranca
    // con todo desplegado, que es el estado por defecto igual.
    return new Set();
  }
}

function guardarPlegados(plegados: Set<string>): void {
  try {
    localStorage.setItem(CLAVE_PLEGADOS, JSON.stringify([...plegados]));
  } catch {
    // No poder recordarlo no es motivo para romper la pantalla.
  }
}

export default function Agenda() {
  const [datos, setDatos] = useState<AgendaDatos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bloqueoCupo, setBloqueoCupo] = useState<string | null>(null);
  const [ventana, setVentana] = useState(15);
  const [verResueltos, setVerResueltos] = useState(false);
  const [enVuelo, setEnVuelo] = useState<string | null>(null);

  const [agrupacion, setAgrupacion] = useState<Agrupacion>('urgencia');
  const [tiposOcultos, setTiposOcultos] = useState<Set<TipoItem>>(new Set());
  const [busqueda, setBusqueda] = useState('');
  const [plegados, setPlegados] = useState<Set<string>>(leerPlegados);

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

  function alternarPlegado(nombre: string) {
    setPlegados((actuales) => {
      const siguiente = new Set(actuales);
      if (siguiente.has(nombre)) siguiente.delete(nombre);
      else siguiente.add(nombre);
      guardarPlegados(siguiente);
      return siguiente;
    });
  }

  function alternarTipo(tipo: TipoItem) {
    setTiposOcultos((actuales) => {
      const siguiente = new Set(actuales);
      if (siguiente.has(tipo)) siguiente.delete(tipo);
      else siguiente.add(tipo);
      return siguiente;
    });
  }

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

  const grupos = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    const visibles = (datos?.items ?? []).filter((i) => {
      if (!verResueltos && i.resueltoEn !== null) return false;
      if (tiposOcultos.has(i.tipo)) return false;
      if (!texto) return true;
      return [i.empresa, i.cuenta, i.titulo, i.detalle, i.contribuyenteCuit]
        .join(' ')
        .toLowerCase()
        .includes(texto);
    });

    const porNombre = new Map<string, ItemAgenda[]>();
    // `visibles` ya viene ordenado por fecha desde el servidor, así que cada
    // grupo hereda ese orden sin volver a ordenar nada adentro.
    for (const item of visibles) {
      const nombre = claveGrupo(item, agrupacion);
      porNombre.set(nombre, [...(porNombre.get(nombre) ?? []), item]);
    }

    const lista = [...porNombre.entries()].map(([nombre, items]) => ({ nombre, items }));
    if (agrupacion === 'urgencia') {
      return lista.sort(
        (a, b) => ORDEN_URGENCIA.indexOf(a.nombre) - ORDEN_URGENCIA.indexOf(b.nombre),
      );
    }
    // Agrupando por empresa, cuenta o tipo, los grupos se ordenan por lo más
    // urgente que tengan adentro y no alfabéticamente: la empresa con algo
    // vencido tiene que quedar arriba, que es para lo que se abre la pantalla.
    const urgenciaDe = (items: ItemAgenda[]) =>
      Math.min(...items.map((i) => (i.dias === null ? Number.MAX_SAFE_INTEGER : i.dias)));
    return lista.sort(
      (a, b) => urgenciaDe(a.items) - urgenciaDe(b.items) || a.nombre.localeCompare(b.nombre),
    );
  }, [datos, verResueltos, tiposOcultos, busqueda, agrupacion]);

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

  const todosPlegados = grupos.length > 0 && grupos.every((g) => plegados.has(g.nombre));
  const mostrados = grupos.reduce((total, g) => total + g.items.length, 0);
  const hayFiltro = busqueda.trim().length > 0 || tiposOcultos.size > 0;

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
          <span className="campo__ayuda">Lo ya vencido se muestra siempre.</span>
        </label>

        <label className="campo">
          <span className="campo__etiqueta">Agrupar por</span>
          <select
            value={agrupacion}
            onChange={(e) => setAgrupacion(e.target.value as Agrupacion)}
          >
            {AGRUPACIONES.map(([valor, etiqueta]) => (
              <option key={valor} value={valor}>
                {etiqueta}
              </option>
            ))}
          </select>
          <span className="campo__ayuda">Dentro de cada grupo, siempre por fecha.</span>
        </label>

        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Buscar</span>
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Empresa, cuenta, impuesto, CUIT…"
          />
        </label>
      </div>

      <div className="agenda-filtros">
        {(Object.keys(ETIQUETA_TIPO) as TipoItem[]).map((tipo) => {
          const activo = !tiposOcultos.has(tipo);
          return (
            <button
              key={tipo}
              type="button"
              className={activo ? 'chip chip--activo' : 'chip'}
              aria-pressed={activo}
              onClick={() => alternarTipo(tipo)}
            >
              {ETIQUETA_TIPO[tipo]}
            </button>
          );
        })}

        <label className="agenda-filtros__check">
          <input
            type="checkbox"
            checked={verResueltos}
            onChange={(e) => setVerResueltos(e.target.checked)}
          />
          Ver lo que ya di por hecho
        </label>

        {grupos.length > 0 && (
          <button
            type="button"
            className="enlace agenda-filtros__plegar"
            onClick={() =>
              setPlegados(() => {
                const siguiente = todosPlegados
                  ? new Set<string>()
                  : new Set(grupos.map((g) => g.nombre));
                guardarPlegados(siguiente);
                return siguiente;
              })
            }
          >
            {todosPlegados ? 'Desplegar todo' : 'Plegar todo'}
          </button>
        )}
      </div>

      {datos === null && !error && <p className="vacio">Cargando agenda…</p>}

      {datos !== null && grupos.length === 0 && (
        <p className="vacio">
          {hayFiltro
            ? 'Nada coincide con el filtro.'
            : `No hay nada pendiente en los próximos ${datos.ventanaDias} días.`}
          {datos.resueltos > 0 && !verResueltos && !hayFiltro && (
            <> Hay {plural(datos.resueltos, 'ítem dado por hecho', 'ítems dados por hechos')}.</>
          )}
        </p>
      )}

      {datos !== null && grupos.length > 0 && hayFiltro && (
        <p className="tenue agenda-conteo">
          {plural(mostrados, 'ítem', 'ítems')} en {plural(grupos.length, 'grupo', 'grupos')}.
        </p>
      )}

      {grupos.map((grupo) => (
        <Grupo
          key={grupo.nombre}
          nombre={grupo.nombre}
          items={grupo.items}
          plegado={plegados.has(grupo.nombre)}
          alPlegar={() => alternarPlegado(grupo.nombre)}
          enVuelo={enVuelo}
          alAlternar={alternar}
        />
      ))}
    </>
  );
}

/**
 * Un grupo plegable.
 *
 * Reusa las clases del plegable del detalle del cliente —`seccion__desplegar`,
 * el chevron y `seccion__animacion`— para no tener dos plegables distintos en
 * el mismo panel. Lo único propio es el contenedor, que acá es un bloque suelto
 * y no un panel.
 */
function Grupo({
  nombre,
  items,
  plegado,
  alPlegar,
  enVuelo,
  alAlternar,
}: {
  nombre: string;
  items: ItemAgenda[];
  plegado: boolean;
  alPlegar: () => void;
  enVuelo: string | null;
  alAlternar: (item: ItemAgenda) => void;
}) {
  const contenidoId = useId();
  const vencidos = items.filter((i) => i.dias !== null && i.dias < 0).length;

  return (
    <section className={`bloque bloque--plegable${plegado ? '' : ' bloque--abierto'}`}>
      <h2 className="bloque__titulo">
        <button
          type="button"
          className="seccion__desplegar"
          aria-expanded={!plegado}
          aria-controls={contenidoId}
          aria-label={`${plegado ? 'Desplegar' : 'Plegar'} ${nombre}`}
          onClick={alPlegar}
        >
          <span className="seccion__chevron" aria-hidden="true">
            ▸
          </span>
          <span>{nombre}</span>
          <span className="tenue">· {plural(items.length, 'ítem', 'ítems')}</span>
          {/* Plegado, el contador de vencidos es lo único que justifica volver
              a abrirlo: sin esto hay que desplegar para saber si importa. */}
          {plegado && vencidos > 0 && <Badge tono="error">{vencidos} vencido{vencidos > 1 ? 's' : ''}</Badge>}
        </button>
      </h2>
      <div
        id={contenidoId}
        className="seccion__animacion"
        aria-hidden={plegado}
        inert={plegado ? true : undefined}
      >
        <div className="seccion__contenido">
          <ul className="agenda">
            {items.map((item) => (
              <Fila
                key={idDe(item)}
                item={item}
                guardando={enVuelo === idDe(item)}
                alAlternar={() => void alAlternar(item)}
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
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
  // Filtrar por una empresa que el detalle no reconoce da 404 y la pantalla
  // dice "No existe ese cliente", que manda a buscar el problema donde no está.
  // Cuando no se puede filtrar se entra a la cuenta entera, que al menos tiene
  // la fila adentro.
  const destino = item.empresaNavegable
    ? `/cliente/${item.clienteId}?empresa=${item.contribuyenteCuit}`
    : `/cliente/${item.clienteId}`;

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
        <Link
          to={destino}
          title={
            item.empresaNavegable
              ? undefined
              : 'ARCA no ofrece esta empresa en ningún servicio todavía, así que abre la cuenta entera'
          }
        >
          {item.empresa}
        </Link>
        {/* El "vía" sólo cuando la empresa NO es la titular. Si son el mismo
            CUIT, repetir el nombre dos veces hacía parecer que la fila decía
            el representante y no la empresa. */}
        <div className="tenue">
          {item.esTitular ? 'titular de la cuenta' : `vía ${item.cuenta}`}
        </div>
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
