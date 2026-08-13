import type { EstadoCredencial, EstadoSync } from '../types';

export type Tono = 'ok' | 'alerta' | 'error' | 'neutro';

export function Badge({ tono, children }: { tono: Tono; children: React.ReactNode }) {
  return <span className={`badge badge--${tono}`}>{children}</span>;
}

/**
 * El estado de sincronizacion siempre visible es deliberado: si un sync falla
 * en silencio, el contador cree estar mirando datos completos cuando no lo son.
 * Es peor que no tener el tablero.
 */
export function EstadoSyncBadge({
  estado,
  credencial,
}: {
  estado: EstadoSync;
  credencial: EstadoCredencial;
}) {
  if (estado === 'OK') return <Badge tono="ok">Sincronizado</Badge>;
  if (estado === 'ERROR') return <Badge tono="error">Error de sincronización</Badge>;
  if (estado === 'SINCRONIZANDO') return <Badge tono="neutro">En cola / sincronizando</Badge>;
  if (estado === 'NUNCA') {
    // "Nunca sincronizo" tiene dos causas distintas y el contador necesita
    // saber cual: si falta cargar la credencial hay trabajo por hacer, si ya
    // esta cargada solo falta que corra el primer job.
    return (
      <Badge tono="neutro">
        {credencial === 'SIN_CARGAR' ? 'Sin configurar' : 'Sin sincronizar'}
      </Badge>
    );
  }

  const etiqueta =
    credencial === 'VENCIDA'
      ? 'Clave vencida'
      : credencial === 'BLOQUEADA'
        ? 'Clave bloqueada'
        : 'Requiere intervención';
  return <Badge tono="alerta">{etiqueta}</Badge>;
}
