import { useEffect, useId, useMemo, useState } from 'react';

const TAMANOS = [10, 50, 100] as const;

export interface ResultadoPaginacion<T> {
  elementosPagina: T[];
  total: number;
  desde: number;
  hasta: number;
  pagina: number;
  totalPaginas: number;
  porPagina: number;
  cambiarPorPagina: (cantidad: number) => void;
  irAPagina: (pagina: number) => void;
}

/**
 * Pagina una coleccion y vuelve a la primera pagina cuando cambia el conjunto
 * de identidades. Actualizar otros campos de una fila no mueve al usuario de
 * la pagina en la que estaba.
 */
export function usePaginacion<T>(
  elementos: readonly T[],
  obtenerClave: (elemento: T) => string | number,
  claveReinicio = '',
): ResultadoPaginacion<T> {
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<number>(TAMANOS[0]);
  const claveDatos = `${claveReinicio}\u0000${elementos
    .map((elemento) => String(obtenerClave(elemento)))
    .map((clave) => `${clave.length}:${clave}`)
    .join('|')}`;
  const total = elementos.length;
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaSegura = Math.min(Math.max(1, pagina), totalPaginas);
  const indiceInicial = (paginaSegura - 1) * porPagina;

  useEffect(() => {
    setPagina(1);
  }, [claveDatos]);

  useEffect(() => {
    setPagina((actual) => Math.min(Math.max(1, actual), totalPaginas));
  }, [totalPaginas]);

  const elementosPagina = useMemo(
    () => elementos.slice(indiceInicial, indiceInicial + porPagina),
    [elementos, indiceInicial, porPagina],
  );

  function cambiarPorPagina(cantidad: number) {
    if (!TAMANOS.includes(cantidad as (typeof TAMANOS)[number])) return;
    setPorPagina(cantidad);
    setPagina(1);
  }

  function irAPagina(destino: number) {
    setPagina(Math.min(Math.max(1, destino), totalPaginas));
  }

  return {
    elementosPagina,
    total,
    desde: total === 0 ? 0 : indiceInicial + 1,
    hasta: Math.min(indiceInicial + porPagina, total),
    pagina: paginaSegura,
    totalPaginas,
    porPagina,
    cambiarPorPagina,
    irAPagina,
  };
}

export function Paginacion({
  etiqueta,
  total,
  desde,
  hasta,
  pagina,
  totalPaginas,
  porPagina,
  cambiarPorPagina,
  irAPagina,
}: Omit<ResultadoPaginacion<never>, 'elementosPagina'> & { etiqueta: string }) {
  const selectorId = useId();
  const primera = pagina <= 1;
  const ultima = pagina >= totalPaginas;

  return (
    <div className="paginacion">
      <label className="paginacion__tamano" htmlFor={selectorId}>
        <span>Mostrar</span>
        <select
          id={selectorId}
          value={porPagina}
          onChange={(evento) => cambiarPorPagina(Number(evento.target.value))}
          aria-label={`Cantidad de ${etiqueta} por página`}
        >
          {TAMANOS.map((tamano) => <option key={tamano} value={tamano}>{tamano}</option>)}
        </select>
        <span>por página</span>
      </label>

      <span className="paginacion__resumen" aria-live="polite" aria-atomic="true">
        {total === 0
          ? `No hay ${etiqueta}`
          : `${desde}–${hasta} de ${total} ${etiqueta}`}
      </span>

      <nav className="paginacion__navegacion" aria-label={`Paginación de ${etiqueta}`}>
        <button
          type="button"
          className="paginacion__boton"
          onClick={() => irAPagina(1)}
          disabled={primera}
          aria-label={`Primera página de ${etiqueta}`}
        >
          Primera
        </button>
        <button
          type="button"
          className="paginacion__boton"
          onClick={() => irAPagina(pagina - 1)}
          disabled={primera}
          aria-label={`Página anterior de ${etiqueta}`}
        >
          Anterior
        </button>
        <label className="paginacion__pagina">
          <span>Página</span>
          <select
            value={pagina}
            onChange={(evento) => irAPagina(Number(evento.target.value))}
            disabled={total === 0}
            aria-label={`Ir directamente a una página de ${etiqueta}`}
          >
            {Array.from({ length: totalPaginas }, (_, indice) => indice + 1).map((numero) => (
              <option key={numero} value={numero}>{numero}</option>
            ))}
          </select>
          <span>de {totalPaginas}</span>
        </label>
        <button
          type="button"
          className="paginacion__boton"
          onClick={() => irAPagina(pagina + 1)}
          disabled={ultima}
          aria-label={`Página siguiente de ${etiqueta}`}
        >
          Siguiente
        </button>
        <button
          type="button"
          className="paginacion__boton"
          onClick={() => irAPagina(totalPaginas)}
          disabled={ultima}
          aria-label={`Última página de ${etiqueta}`}
        >
          Última
        </button>
      </nav>
    </div>
  );
}
