import { useState } from 'react';

/**
 * Un nombre que se edita en el lugar.
 *
 * El identificador NO se tipea: siempre sale del dato que ya está en pantalla.
 * Eso evita el error más probable de un formulario suelto — guardar un nombre
 * contra un CUIT mal escrito, que después no matchea con nada y nadie nota,
 * porque el grupo sigue mostrándose sin nombre.
 *
 * Nombra dos cosas que NO son lo mismo y por eso `etiqueta` viene de afuera en
 * vez de armarse acá: la razón social de un CUIT del padrón, que es global y
 * puede faltar, y el nombre de una cuenta de acceso, que siempre existe porque
 * se carga en el alta.
 */
export function NombreEditable({
  id,
  etiqueta,
  nombre,
  alGuardar,
}: {
  /** Lo que identifica a lo que se nombra: un CUIT, el id de una cuenta. */
  id: string;
  /** Para el lector de pantalla, p. ej. "Razón social de 30-71201119-6". */
  etiqueta: string;
  /** `undefined` cuando todavía no hay nombre cargado. */
  nombre: string | undefined;
  alGuardar: (id: string, nombre: string) => Promise<void>;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nombre ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await alGuardar(id, valor.trim());
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
        aria-label={etiqueta}
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
