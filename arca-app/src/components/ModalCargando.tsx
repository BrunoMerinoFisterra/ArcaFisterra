import type { SyncJob } from '../types';

const MODULOS_COMPLETOS = [
  'Domicilio Fiscal Electrónico',
  'Sistema de Cuentas Tributarias y vencimientos',
  'Mis Facilidades',
  'Mis Comprobantes',
];

export function ModalCargando({
  cliente,
  tarea,
  job,
}: {
  cliente: string;
  tarea: string;
  job?: SyncJob | null;
}) {
  const esCompleta = job?.modulo === 'sincronizacion-completa';
  const actual = job?.progresoActual ?? 0;
  const total = job?.progresoTotal ?? 4;
  const paso =
    job?.pasoActual ??
    (job?.estado === 'PENDING' ? 'Esperando un worker disponible…' : 'Preparando…');

  return (
    <div className="modal-carga__fondo">
      <div
        className="modal-carga"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-carga-titulo"
        aria-describedby="modal-carga-detalle"
      >
        <div className="modal-carga__spinner" aria-hidden="true" />
        <h2 id="modal-carga-titulo">Consultando ARCA</h2>
        <p className="modal-carga__cliente">{cliente}</p>
        <p id="modal-carga-detalle">{tarea}</p>
        {esCompleta && (
          <div className="modal-carga__progreso">
            <div className="modal-carga__barra" aria-label={`${actual} de ${total} módulos completos`}>
              <span style={{ width: `${Math.round((actual / Math.max(total, 1)) * 100)}%` }} />
            </div>
            <ol className="modal-carga__modulos">
              {MODULOS_COMPLETOS.map((modulo, indice) => {
                const estado = indice < actual ? 'completo' : indice === actual ? 'activo' : 'pendiente';
                return (
                  <li key={modulo} className={`modal-carga__modulo modal-carga__modulo--${estado}`}>
                    <span aria-hidden="true">{estado === 'completo' ? '✓' : indice + 1}</span>
                    <strong>{modulo}</strong>
                  </li>
                );
              })}
            </ol>
            <p className="modal-carga__paso" aria-live="polite">
              {paso}
            </p>
          </div>
        )}
        {!esCompleta && job && (
          <p className="modal-carga__estado-cola" aria-live="polite">
            {paso}
          </p>
        )}
        <p className="modal-carga__nota" aria-live="polite">
          El worker está procesando la información. Esto puede demorar algunos minutos.
        </p>
      </div>
    </div>
  );
}
