import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { pesos } from '../lib/format';
import type { Comprobante, TipoComprobante } from '../types';

interface MesComprobantes {
  clave: string;
  etiqueta: string;
  etiquetaCompleta: string;
  emitidosCantidad: number;
  recibidosCantidad: number;
  emitidosTotal: number;
  recibidosTotal: number;
}

interface BarraActiva {
  indice: number;
  tipo: TipoComprobante;
  mes: string;
  cantidad: number;
  total: number;
  x: number;
  y: number;
}

export function ModalGraficoComprobantes({
  comprobantes,
  razonSocial,
  anio,
  alCerrar,
}: {
  comprobantes: Comprobante[];
  razonSocial: string;
  anio: string;
  alCerrar: () => void;
}) {
  const tituloId = useId();
  const descripcionId = useId();
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const meses = useMemo(() => agruparPorMes(comprobantes, anio), [anio, comprobantes]);
  const [barraActiva, setBarraActiva] = useState<BarraActiva | null>(null);
  const totales = useMemo(
    () => meses.reduce(
      (acumulado, mes) => ({
        emitidosCantidad: acumulado.emitidosCantidad + mes.emitidosCantidad,
        recibidosCantidad: acumulado.recibidosCantidad + mes.recibidosCantidad,
        emitidosTotal: acumulado.emitidosTotal + mes.emitidosTotal,
        recibidosTotal: acumulado.recibidosTotal + mes.recibidosTotal,
      }),
      { emitidosCantidad: 0, recibidosCantidad: 0, emitidosTotal: 0, recibidosTotal: 0 },
    ),
    [meses],
  );

  useEffect(() => {
    const focoAnterior = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cerrarRef.current?.focus();

    function cerrarConEscape(evento: KeyboardEvent) {
      if (evento.key === 'Escape') alCerrar();
    }
    window.addEventListener('keydown', cerrarConEscape);
    return () => {
      window.removeEventListener('keydown', cerrarConEscape);
      document.body.style.overflow = overflowAnterior;
      focoAnterior?.focus();
    };
  }, [alCerrar]);

  return (
    <div
      className="grafico-modal__fondo"
      onMouseDown={(evento) => {
        if (evento.currentTarget === evento.target) alCerrar();
      }}
    >
      <section
        className="grafico-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        aria-describedby={descripcionId}
      >
        <header className="grafico-modal__cabecera">
          <div>
            <span className="grafico-modal__rotulo">ANÁLISIS ANUAL · {anio}</span>
            <h2 id={tituloId}>Comprobantes emitidos vs. recibidos</h2>
            <p id={descripcionId}>
              {razonSocial} · cantidad mensual e importe total acumulado por serie.
            </p>
          </div>
          <button
            ref={cerrarRef}
            type="button"
            className="grafico-modal__cerrar"
            onClick={alCerrar}
            aria-label="Cerrar gráfico de comprobantes"
          >
            Cerrar
          </button>
        </header>

        <div className="grafico-comprobantes__metricas">
          <article className="grafico-metrica grafico-metrica--emitidos">
            <span>Emitidos</span>
            <strong>{totales.emitidosCantidad}</strong>
            <small>{pesos(totales.emitidosTotal, true)} en total</small>
          </article>
          <article className="grafico-metrica grafico-metrica--recibidos">
            <span>Recibidos</span>
            <strong>{totales.recibidosCantidad}</strong>
            <small>{pesos(totales.recibidosTotal, true)} en total</small>
          </article>
        </div>

        <div className="grafico-comprobantes__leyenda" aria-label="Series del gráfico">
          <span><i className="grafico-leyenda__muestra grafico-leyenda__muestra--emitidos" /> Emitidos</span>
          <span><i className="grafico-leyenda__muestra grafico-leyenda__muestra--recibidos" /> Recibidos</span>
          <small>Altura: cantidad de comprobantes</small>
        </div>

        <GraficoBarrasComprobantes
          meses={meses}
          activa={barraActiva}
          alActivar={setBarraActiva}
        />

        <div className="grafico-comprobantes__lectura" role="status" aria-live="polite">
          {barraActiva ? (
            <>
              <strong>{barraActiva.mes} · {barraActiva.tipo === 'EMITIDO' ? 'Emitidos' : 'Recibidos'}</strong>
              <span>
                {barraActiva.cantidad} comprobantes · importe total {pesos(barraActiva.total, true)}
              </span>
            </>
          ) : (
            <span>Posate sobre una barra o enfócala con el teclado para consultar su detalle.</span>
          )}
        </div>
      </section>
    </div>
  );
}

function GraficoBarrasComprobantes({
  meses,
  activa,
  alActivar,
}: {
  meses: MesComprobantes[];
  activa: BarraActiva | null;
  alActivar: (barra: BarraActiva | null) => void;
}) {
  const tituloId = useId();
  const descripcionId = useId();
  const ancho = 960;
  const alto = 390;
  const margen = { arriba: 20, derecha: 22, abajo: 58, izquierda: 62 };
  const anchoPlot = ancho - margen.izquierda - margen.derecha;
  const altoPlot = alto - margen.arriba - margen.abajo;
  const baseY = margen.arriba + altoPlot;
  const maximaCantidad = Math.max(
    1,
    ...meses.flatMap((mes) => [mes.emitidosCantidad, mes.recibidosCantidad]),
  );
  const paso = pasoEscala(maximaCantidad / 4);
  const tope = Math.max(paso, Math.ceil(maximaCantidad / paso) * paso);
  const marcas = Array.from({ length: Math.round(tope / paso) + 1 }, (_, indice) => indice * paso);
  const anchoGrupo = anchoPlot / meses.length;
  const anchoBarra = Math.min(27, anchoGrupo * 0.31);
  const separacion = Math.min(8, anchoGrupo * 0.08);
  const alturaPara = (cantidad: number) => (cantidad / tope) * altoPlot;

  return (
    <div className="grafico-comprobantes__scroll">
      <svg
        className="grafico-comprobantes"
        viewBox={`0 0 ${ancho} ${alto}`}
        role="group"
        aria-labelledby={`${tituloId} ${descripcionId}`}
      >
        <title id={tituloId}>Cantidad mensual de comprobantes emitidos y recibidos</title>
        <desc id={descripcionId}>
          Gráfico de barras agrupadas con los doce meses. Cada barra puede enfocarse para conocer
          la cantidad y el importe total mensual.
        </desc>

        {marcas.map((marca) => {
          const y = baseY - alturaPara(marca);
          return (
            <g key={marca} className="grafico-comprobantes__grilla">
              <line x1={margen.izquierda} x2={ancho - margen.derecha} y1={y} y2={y} />
              <text x={margen.izquierda - 12} y={y + 4}>{marca}</text>
            </g>
          );
        })}

        {meses.map((mes, indice) => {
          const centro = margen.izquierda + anchoGrupo * indice + anchoGrupo / 2;
          const xEmitidos = centro - separacion / 2 - anchoBarra;
          const xRecibidos = centro + separacion / 2;
          const barras = [
            {
              tipo: 'EMITIDO' as const,
              cantidad: mes.emitidosCantidad,
              total: mes.emitidosTotal,
              x: xEmitidos,
              clase: 'grafico-comprobantes__barra--emitidos',
            },
            {
              tipo: 'RECIBIDO' as const,
              cantidad: mes.recibidosCantidad,
              total: mes.recibidosTotal,
              x: xRecibidos,
              clase: 'grafico-comprobantes__barra--recibidos',
            },
          ];
          return (
            <g key={mes.clave}>
              {barras.map((barra, serieIndice) => {
                const alturaReal = alturaPara(barra.cantidad);
                const alturaVisible = barra.cantidad === 0 ? 2 : Math.max(4, alturaReal);
                const y = baseY - alturaVisible;
                const datosActivos: BarraActiva = {
                  indice,
                  tipo: barra.tipo,
                  mes: mes.etiquetaCompleta,
                  cantidad: barra.cantidad,
                  total: barra.total,
                  x: barra.x + anchoBarra / 2,
                  y,
                };
                return (
                  <g
                    key={barra.tipo}
                    role="img"
                    tabIndex={0}
                    aria-label={`${mes.etiquetaCompleta}, ${barra.tipo === 'EMITIDO' ? 'emitidos' : 'recibidos'}: ${barra.cantidad} comprobantes, importe total ${pesos(barra.total, true)}`}
                    onMouseEnter={() => alActivar(datosActivos)}
                    onMouseLeave={() => alActivar(null)}
                    onFocus={() => alActivar(datosActivos)}
                    onBlur={() => alActivar(null)}
                    onClick={() => alActivar(datosActivos)}
                  >
                    <rect
                      className="grafico-comprobantes__zona"
                      x={barra.x - 5}
                      y={margen.arriba}
                      width={anchoBarra + 10}
                      height={altoPlot}
                    />
                    <rect
                      className={`grafico-comprobantes__barra ${barra.clase}${barra.cantidad === 0 ? ' grafico-comprobantes__barra--cero' : ''}`}
                      x={barra.x}
                      y={y}
                      width={anchoBarra}
                      height={alturaVisible}
                      rx={Math.min(7, anchoBarra / 3)}
                      style={{
                        transformOrigin: `${barra.x + anchoBarra / 2}px ${baseY}px`,
                        animationDelay: `${(indice * 2 + serieIndice) * 38}ms`,
                      }}
                    />
                  </g>
                );
              })}
              <text className="grafico-comprobantes__mes" x={centro} y={baseY + 28}>
                {mes.etiqueta}
              </text>
            </g>
          );
        })}

        {activa && <TooltipSvg activa={activa} ancho={ancho} />}
      </svg>
    </div>
  );
}

function TooltipSvg({ activa, ancho }: { activa: BarraActiva; ancho: number }) {
  const tooltipAncho = 300;
  const tooltipAlto = 62;
  const x = Math.min(Math.max(8, activa.x - tooltipAncho / 2), ancho - tooltipAncho - 8);
  const y = Math.max(7, activa.y - tooltipAlto - 10);
  return (
    <g className="grafico-tooltip" pointerEvents="none">
      <rect x={x} y={y} width={tooltipAncho} height={tooltipAlto} rx={11} />
      <text x={x + 14} y={y + 23} className="grafico-tooltip__titulo">
        {activa.mes} · {activa.tipo === 'EMITIDO' ? 'Emitidos' : 'Recibidos'}
      </text>
      <text x={x + 14} y={y + 45} className="grafico-tooltip__detalle">
        {activa.cantidad} comprobantes · total {pesos(activa.total, true)}
      </text>
    </g>
  );
}

function agruparPorMes(comprobantes: Comprobante[], anio: string): MesComprobantes[] {
  const formatoCorto = new Intl.DateTimeFormat('es-AR', { month: 'short', timeZone: 'UTC' });
  const formatoCompleto = new Intl.DateTimeFormat('es-AR', { month: 'long', timeZone: 'UTC' });
  const meses = Array.from({ length: 12 }, (_, indice): MesComprobantes => {
    const fecha = new Date(Date.UTC(Number(anio), indice, 1));
    const numero = String(indice + 1).padStart(2, '0');
    return {
      clave: `${anio}-${numero}`,
      etiqueta: formatoCorto.format(fecha).replace('.', ''),
      etiquetaCompleta: capitalizar(formatoCompleto.format(fecha)),
      emitidosCantidad: 0,
      recibidosCantidad: 0,
      emitidosTotal: 0,
      recibidosTotal: 0,
    };
  });

  for (const comprobante of comprobantes) {
    if (!comprobante.fecha.startsWith(`${anio}-`)) continue;
    const indice = Number(comprobante.fecha.slice(5, 7)) - 1;
    const mes = meses[indice];
    if (!mes) continue;
    if (comprobante.tipo === 'EMITIDO') {
      mes.emitidosCantidad += 1;
      mes.emitidosTotal += comprobante.total;
    } else {
      mes.recibidosCantidad += 1;
      mes.recibidosTotal += comprobante.total;
    }
  }
  return meses;
}

function pasoEscala(valor: number): number {
  if (!Number.isFinite(valor) || valor <= 1) return 1;
  const potencia = 10 ** Math.floor(Math.log10(valor));
  const normalizado = valor / potencia;
  if (normalizado <= 1) return potencia;
  if (normalizado <= 2) return 2 * potencia;
  if (normalizado <= 5) return 5 * potencia;
  return 10 * potencia;
}

function capitalizar(valor: string): string {
  return valor ? valor[0]!.toLocaleUpperCase('es-AR') + valor.slice(1) : valor;
}
