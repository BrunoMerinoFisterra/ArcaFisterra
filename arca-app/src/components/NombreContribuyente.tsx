import { useState } from 'react';

/**
 * Razón social de un contribuyente, con carga inline.
 *
 * El CUIT NO se tipea: siempre sale del dato que ya está en pantalla. Eso evita
 * el error más probable de un formulario suelto — cargar un nombre contra un
 * CUIT mal escrito, que después no matchea con nada y nadie nota, porque el
 * grupo sigue mostrándose sin nombre.
 *
 * Vive acá y no en una pantalla porque se usa desde dos lugares que llegan al
 * mismo CUIT por caminos distintos: los grupos del detalle, que sólo existen
 * cuando esa empresa tiene datos en ese módulo, y la lista de empresas de la
 * cuenta, que las muestra todas — tengan movimientos o no.
 */
export function NombreContribuyente({
  cuit,
  nombre,
  alGuardar,
}: {
  cuit: string;
  /** `undefined` cuando todavía no hay razón social cargada. */
  nombre: string | undefined;
  alGuardar: (cuit: string, nombre: string) => Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nombre ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await alGuardar(cuit, valor.trim());
      setEditando(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el nombre.');
    } finally {
      setGuardando(false);
    }
  }

  if (!editando) {
    return (
      <span className="grupo-cuit__nombre">
        {nombre ? <strong>{nombre}</strong> : <span className="tenue">Sin nombre cargado</span>}{' '}
        <button
          type="button"
          className="enlace"
          onClick={() => {
            setValor(nombre ?? '');
            setError(null);
            setEditando(true);
          }}
        >
          {nombre ? 'Editar nombre' : 'Poner nombre'}
        </button>
      </span>
    );
  }

  return (
    <span className="grupo-cuit__nombre">
      <input
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        placeholder="Razón social"
        aria-label={`Razón social de ${cuit}`}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valor.trim().length >= 2) void guardar();
          if (e.key === 'Escape') setEditando(false);
        }}
      />
      <button
        type="button"
        className="btn btn--chico btn--primario"
        disabled={valor.trim().length < 2 || guardando}
        onClick={() => void guardar()}
      >
        {guardando ? 'Guardando…' : 'Guardar'}
      </button>
      <button type="button" className="btn btn--chico" onClick={() => setEditando(false)}>
        Cancelar
      </button>
      {error && <span className="campo__error">{error}</span>}
    </span>
  );
}
