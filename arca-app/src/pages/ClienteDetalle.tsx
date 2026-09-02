import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  actualizarLecturaNotificacion,
  actualizarLecturaPlan,
  descargarAdjuntoNotificacion,
  diasHasta,
  esperarJob,
  guardarNombreContribuyente,
  obtenerDetalleCliente,
  sincronizarAhora,
  sincronizarCompleto,
  sincronizarDomicilio,
  sincronizarFacilidades,
  sincronizarSaldos,
} from '../api/client';
import type {
  Comprobante,
  DetalleCliente,
  Notificacion,
  NotificacionAdjunto,
  PlanPago,
  SaldoTributario,
  SyncJob,
  TipoComprobante,
} from '../types';
import { desde, fecha, pesos, plazo } from '../lib/format';
import { plural } from '../lib/plural';
import { descargarCsv, type ValorCsv } from '../lib/csv';
import { Badge, EstadoSyncBadge } from '../components/Badge';
import { ModalGraficoComprobantes } from '../components/GraficoComprobantes';
import { ModalCargando } from '../components/ModalCargando';
import { Paginacion, usePaginacion } from '../components/Paginacion';

type ModuloActivo = 'completa' | 'domicilio' | 'saldos' | 'facilidades' | 'comprobantes';

export default function ClienteDetalle() {
  const { id } = useParams<{ id: string }>();
  // `?empresa=<cuit>` acota TODO el detalle a una empresa de la cuenta. Sin el,
  // se ve la cuenta entera: la mezcla de todos sus representados.
  const [parametros] = useSearchParams();
  const empresa = parametros.get('empresa') ?? undefined;
  const [detalle, setDetalle] = useState<DetalleCliente | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [moduloActivo, setModuloActivo] = useState<ModuloActivo | null>(null);
  const [jobActivo, setJobActivo] = useState<SyncJob | null>(null);
  const [mensajeCompleto, setMensajeCompleto] = useState<string | null>(null);
  const [mensajeDomicilio, setMensajeDomicilio] = useState<string | null>(null);
  const [mensajeSaldos, setMensajeSaldos] = useState<string | null>(null);
  const [mensajePlanes, setMensajePlanes] = useState<string | null>(null);
  const [mensajeComprobantes, setMensajeComprobantes] = useState<string | null>(null);
  const [graficoComprobantesAbierto, setGraficoComprobantesAbierto] = useState(false);

  /**
   * Guarda el nombre y lo refleja sin recargar el detalle entero: traer de
   * nuevo los 81 registros para pintar un texto sería desproporcionado.
   */
  async function ponerNombreContribuyente(cuit: string, nombre: string) {
    const guardado = await guardarNombreContribuyente(cuit, nombre);
    setDetalle((actual) =>
      actual
        ? { ...actual, contribuyentes: { ...actual.contribuyentes, [guardado.cuit.replace(/\D/g, '')]: guardado.nombre } }
        : actual,
    );
  }

  useEffect(() => {
    if (!id) return;
    let vigente = true;
    setDetalle(undefined);
    setError(null);
    setGraficoComprobantesAbierto(false);
    obtenerDetalleCliente(id, empresa)
      .then((d) => {
        if (vigente) setDetalle(d);
      })
      .catch((e: unknown) => {
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudo cargar el cliente.');
      });
    return () => {
      vigente = false;
    };
  }, [id, empresa]);

  async function actualizarTodo() {
    if (!id) return;
    setModuloActivo('completa');
    setJobActivo(null);
    setMensajeCompleto(null);
    try {
      const job = await sincronizarCompleto(id);
      setJobActivo(job);
      const terminado = await esperarJob(id, job.id, setJobActivo);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo completar la sincronización de ARCA.');
      }
      const actualizado = await obtenerDetalleCliente(id, empresa);
      if (actualizado) setDetalle(actualizado);
      setMensajeCompleto('Sincronización completa: los cuatro módulos se actualizaron correctamente.');
    } catch (e) {
      setMensajeCompleto(e instanceof Error ? e.message : 'No se pudo iniciar la sincronización.');
    } finally {
      setModuloActivo(null);
      setJobActivo(null);
    }
  }

  async function actualizarDomicilio() {
    if (!id) return;
    setModuloActivo('domicilio');
    setJobActivo(null);
    setMensajeDomicilio(null);
    try {
      const job = await sincronizarDomicilio(id);
      setJobActivo(job);
      const terminado = await esperarJob(id, job.id, setJobActivo);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo actualizar el Domicilio Fiscal Electrónico.');
      }
      const actualizado = await obtenerDetalleCliente(id, empresa);
      if (actualizado) setDetalle(actualizado);
      const cantidad = actualizado?.notificaciones.length ?? 0;
      const sinLeer =
        actualizado?.notificaciones.filter((notificacion) => notificacion.estado === 'SIN_LEER')
          .length ?? 0;
      setMensajeDomicilio(`Domicilio Fiscal actualizado: ${cantidad} comunicaciones, ${sinLeer} sin leer.`);
    } catch (e) {
      setMensajeDomicilio(e instanceof Error ? e.message : 'No se pudo iniciar la sincronización.');
    } finally {
      setModuloActivo(null);
      setJobActivo(null);
    }
  }

  async function actualizarFacilidades() {
    if (!id) return;
    setModuloActivo('facilidades');
    setJobActivo(null);
    setMensajePlanes(null);
    try {
      const job = await sincronizarFacilidades(id);
      setJobActivo(job);
      const terminado = await esperarJob(id, job.id, setJobActivo);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo actualizar Mis Facilidades.');
      }
      const actualizado = await obtenerDetalleCliente(id, empresa);
      if (actualizado) setDetalle(actualizado);
      setMensajePlanes(`Mis Facilidades actualizado: ${actualizado?.planes.length ?? 0} planes.`);
    } catch (e) {
      setMensajePlanes(e instanceof Error ? e.message : 'No se pudo iniciar la sincronización.');
    } finally {
      setModuloActivo(null);
      setJobActivo(null);
    }
  }

  async function actualizarSaldos() {
    if (!id) return;
    setModuloActivo('saldos');
    setJobActivo(null);
    setMensajeSaldos(null);
    try {
      const job = await sincronizarSaldos(id);
      setJobActivo(job);
      const terminado = await esperarJob(id, job.id, setJobActivo);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo actualizar Cuentas Tributarias.');
      }
      const actualizado = await obtenerDetalleCliente(id, empresa);
      if (actualizado) setDetalle(actualizado);
      const obligaciones = actualizado?.saldos ?? [];
      const vencimientosActualizados = actualizado?.vencimientos ?? [];
      const ddjjActualizadas = actualizado?.ddjjPendientes ?? [];
      const deuda = Math.abs(obligaciones.reduce((total, saldo) => total + totalSaldo(saldo), 0));
      setMensajeSaldos(
        `Cuentas Tributarias actualizado: ${obligaciones.length} obligaciones, ` +
          `${vencimientosActualizados.length} vencimientos, ` +
          `${ddjjActualizadas.length} DDJJ pendientes, deuda total ${pesos(deuda, true)}.`,
      );
    } catch (e) {
      setMensajeSaldos(e instanceof Error ? e.message : 'No se pudo iniciar la sincronización.');
    } finally {
      setModuloActivo(null);
      setJobActivo(null);
    }
  }

  async function actualizarComprobantes() {
    if (!id) return;
    setModuloActivo('comprobantes');
    setJobActivo(null);
    setMensajeComprobantes(null);
    try {
      const job = await sincronizarAhora(id);
      setJobActivo(job);
      const terminado = await esperarJob(id, job.id, setJobActivo);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo actualizar Mis Comprobantes.');
      }
      const actualizado = await obtenerDetalleCliente(id, empresa);
      if (actualizado) setDetalle(actualizado);
      setMensajeComprobantes('Mis Comprobantes se actualizó correctamente.');
    } catch (e) {
      setMensajeComprobantes(e instanceof Error ? e.message : 'No se pudo iniciar la sincronización.');
    } finally {
      setModuloActivo(null);
      setJobActivo(null);
    }
  }

  if (error) return <div className="aviso aviso--error">{error}</div>;
  if (detalle === undefined) return <p className="vacio">Cargando…</p>;
  if (detalle === null) return <p className="vacio">No existe ese cliente.</p>;

  const { cliente, notificaciones, saldos, planes, vencimientos, ddjjPendientes, comprobantes } = detalle;
  const anio = claveAnioActual();
  const comprobantesAnio = comprobantes.filter((c) => c.fecha.startsWith(anio));
  const emitidos = comprobantesAnio.filter((c) => c.tipo === 'EMITIDO');
  const recibidos = comprobantesAnio.filter((c) => c.tipo === 'RECIBIDO');

  return (
    <>
      {moduloActivo && (
        <ModalCargando
          cliente={cliente.razonSocial}
          job={jobActivo}
          tarea={
            moduloActivo === 'completa'
              ? 'Sincronizando todos los servicios fiscales en una sola sesión.'
              : moduloActivo === 'domicilio'
              ? 'Abriendo comunicaciones en ARCA y descargando sus detalles y adjuntos.'
              : moduloActivo === 'saldos'
              ? 'Leyendo deudas, vencimientos y DDJJ de todos los CUIT delegados.'
              : moduloActivo === 'facilidades'
              ? 'Leyendo presentaciones, detalles y pagos de Mis Facilidades.'
              : 'Descargando comprobantes emitidos y recibidos del año actual.'
          }
        />
      )}
      {graficoComprobantesAbierto && (
        <ModalGraficoComprobantes
          comprobantes={comprobantesAnio}
          razonSocial={cliente.razonSocial}
          anio={anio}
          alCerrar={() => setGraficoComprobantesAbierto(false)}
        />
      )}
      <Link to="/" className="volver">
        ← Todos los clientes
      </Link>

      <div className="detalle-cabecera">
        <div>
          <h1 className="titulo-pareado titulo-pareado--detalle">
            <strong>CUENTA FISCAL</strong>
            <span>{cliente.razonSocial}</span>
          </h1>
          <div className="card__cuit">{cliente.cuit}</div>
        </div>
        <div className="detalle-cabecera__estado">
          <EstadoSyncBadge estado={cliente.estadoSync} credencial={cliente.estadoCredencial} />
          <span className="card__pie">Última sincronización: {desde(cliente.ultimoSync)}</span>
        </div>
      </div>

      <section className="sync-completa">
        <div>
          <strong>Sincronización completa</strong>
          <p>
            Domicilio Fiscal, Cuentas Tributarias y vencimientos, Mis Facilidades y Mis Comprobantes.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primario"
          onClick={actualizarTodo}
          disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
        >
          {moduloActivo === 'completa' ? 'Sincronizando 0 de 4…' : 'Sincronizar todos los servicios'}
        </button>
      </section>

      {mensajeCompleto && (
        <div className={mensajeCompleto.startsWith('Sincronización completa:') ? 'aviso aviso--ok' : 'aviso aviso--error'}>
          {mensajeCompleto}
        </div>
      )}

      {cliente.detalleSync && <div className="aviso">{cliente.detalleSync}</div>}

      <Seccion
        titulo="Domicilio Fiscal Electrónico"
        vacio="Sin notificaciones."
        accion={
          <>
            <BotonExportar nombre={`${cliente.razonSocial}-notificaciones`} {...csvNotificaciones(notificaciones)} />
          <button
            type="button"
            className="btn btn--chico"
            onClick={actualizarDomicilio}
            disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
          >
            {moduloActivo === 'domicilio' ? 'Abriendo en ARCA…' : 'Actualizar y abrir en ARCA'}
          </button>
          </>
        }
      >
        {mensajeDomicilio && <p className="estado-facilidades">{mensajeDomicilio}</p>}
        {!mensajeDomicilio && notificaciones.length === 0 && <p className="tenue">Sin notificaciones.</p>}
        {notificaciones.length > 0 && (
          <NotificacionesDfe
            clienteId={cliente.id}
            notificaciones={notificaciones}
            alActualizarLectura={(notificacionId, leidoAppEn) =>
              setDetalle((actual) =>
                actual
                  ? {
                      ...actual,
                      notificaciones: actual.notificaciones.map((notificacion) =>
                        notificacion.id === notificacionId
                          ? { ...notificacion, leidoAppEn }
                          : notificacion,
                      ),
                    }
                  : actual,
              )
            }
          />
        )}
      </Seccion>

      <Seccion
        titulo="Vencimientos"
        vacio="Sin vencimientos informados por ARCA."
        accion={
          <>
            <BotonExportar nombre={`${cliente.razonSocial}-vencimientos`} {...csvVencimientos(vencimientos, detalle.contribuyentes)} />
          <button
            type="button"
            className="btn btn--chico"
            onClick={actualizarSaldos}
            disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
          >
            {moduloActivo === 'saldos' ? 'Consultando ARCA…' : 'Actualizar desde ARCA'}
          </button>
          </>
        }
      >
        {mensajeSaldos && <p className="estado-facilidades">{mensajeSaldos}</p>}
        {!mensajeSaldos && vencimientos.length === 0 && (
          <p className="tenue">Sin vencimientos informados por ARCA.</p>
        )}
        {vencimientos.length > 0 && (
          <AgrupadosPorCuit
            datos={vencimientos}
            etiqueta="vencimientos"
            renderGrupo={(datos) => <TablaVencimientos vencimientos={datos} />}
          nombres={detalle.contribuyentes}
          alGuardarNombre={ponerNombreContribuyente}
        />
        )}
      </Seccion>

      <Seccion
        titulo="Deudas"
        vacio="Sin saldos registrados."
        accion={
          <>
            <BotonExportar nombre={`${cliente.razonSocial}-deudas`} {...csvSaldos(saldos, detalle.contribuyentes)} />
          <button
            type="button"
            className="btn btn--chico"
            onClick={actualizarSaldos}
            disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
          >
            {moduloActivo === 'saldos' ? 'Consultando ARCA…' : 'Actualizar desde ARCA'}
          </button>
          </>
        }
      >
        {mensajeSaldos && <p className="estado-facilidades">{mensajeSaldos}</p>}
        {!mensajeSaldos && saldos.length === 0 && <p className="tenue">Sin saldos registrados.</p>}
        {saldos.length > 0 && (
          <>
            <p className="estado-facilidades">
              {saldos.length} obligaciones · Deuda total{' '}
              <strong>{pesos(Math.abs(saldos.reduce((total, saldo) => total + totalSaldo(saldo), 0)), true)}</strong>
            </p>
            <AgrupadosPorCuit
              datos={saldos}
              etiqueta="obligaciones"
              renderGrupo={(datos) => <TablaSaldos saldos={datos} />}
            nombres={detalle.contribuyentes}
            alGuardarNombre={ponerNombreContribuyente}
          />
          </>
        )}
      </Seccion>

      <Seccion
        titulo="DDJJ pendientes de presentación"
        vacio="Sin declaraciones juradas pendientes informadas por ARCA."
        accion={
          <>
            <BotonExportar nombre={`${cliente.razonSocial}-ddjj-pendientes`} {...csvDdjj(ddjjPendientes, detalle.contribuyentes)} />
          <button
            type="button"
            className="btn btn--chico"
            onClick={actualizarSaldos}
            disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
          >
            {moduloActivo === 'saldos' ? 'Consultando ARCA…' : 'Actualizar desde ARCA'}
          </button>
          </>
        }
      >
        {mensajeSaldos && <p className="estado-facilidades">{mensajeSaldos}</p>}
        {!mensajeSaldos && ddjjPendientes.length === 0 && (
          <p className="tenue">Sin declaraciones juradas pendientes informadas por ARCA.</p>
        )}
        {ddjjPendientes.length > 0 && (
          <AgrupadosPorCuit
            datos={ddjjPendientes}
            etiqueta="DDJJ pendientes"
            renderGrupo={(datos) => <TablaDdjj declaraciones={datos} />}
          nombres={detalle.contribuyentes}
          alGuardarNombre={ponerNombreContribuyente}
        />
        )}
      </Seccion>

      <Seccion
        titulo="Mis Facilidades"
        vacio="Sin planes de pago."
        accion={
          <>
            <BotonExportar nombre={`${cliente.razonSocial}-facilidades`} {...csvPlanes(planes)} />
          <button
            type="button"
            className="btn btn--chico"
            onClick={actualizarFacilidades}
            disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
          >
            {moduloActivo === 'facilidades' ? 'Consultando ARCA…' : 'Actualizar desde ARCA'}
          </button>
          </>
        }
      >
        {mensajePlanes && <p className="estado-facilidades">{mensajePlanes}</p>}
        {!mensajePlanes && planes.length === 0 && <p className="tenue">Sin planes de pago.</p>}
        {planes.length > 0 && (
          <TablaPlanes
            clienteId={cliente.id}
            planes={planes}
            alActualizarLectura={(planId, leidoAppEn) =>
              setDetalle((actual) =>
                actual
                  ? {
                      ...actual,
                      planes: actual.planes.map((plan) =>
                        plan.id === planId ? { ...plan, leidoAppEn } : plan,
                      ),
                    }
                  : actual,
              )
            }
          />
        )}
      </Seccion>

      <Seccion
        titulo={`Mis Comprobantes — ${anio} — ${emitidos.length} emitidos, ${recibidos.length} recibidos`}
        vacio="Sin comprobantes en el año actual."
        accion={
          <>
            <BotonExportar
              nombre={`${cliente.razonSocial}-comprobantes-${anio}`}
              {...csvComprobantes(comprobantesAnio, detalle.contribuyentes)}
            />
          <div className="seccion__acciones">
            <button
              type="button"
              className="btn btn--chico"
              onClick={() => setGraficoComprobantesAbierto(true)}
              disabled={comprobantesAnio.length === 0}
            >
              Ver gráfico anual
            </button>
            <button
              type="button"
              className="btn btn--chico"
              onClick={actualizarComprobantes}
              disabled={moduloActivo !== null || cliente.estadoCredencial !== 'OK'}
            >
              {moduloActivo === 'comprobantes' ? 'Consultando ARCA…' : 'Actualizar desde ARCA'}
            </button>
          </div>
          </>
        }
      >
        {mensajeComprobantes && <p className="estado-facilidades">{mensajeComprobantes}</p>}
        {!mensajeComprobantes && comprobantesAnio.length === 0 && (
          <p className="tenue">Sin comprobantes en el año actual.</p>
        )}
        {comprobantesAnio.length > 0 && (
          <AgrupadosPorCuit
            datos={comprobantesAnio}
            etiqueta="comprobantes"
            nombres={detalle.contribuyentes}
            alGuardarNombre={ponerNombreContribuyente}
            renderGrupo={(datos) => <TablaComprobantes comprobantes={datos} />}
          />
        )}
      </Seccion>
    </>
  );
}

function totalSaldo(saldo: SaldoTributario): number {
  return saldo.saldo + saldo.interesResarcitorio + saldo.interesPunitorio;
}

/**
 * Columnas de cada categoría.
 *
 * Se exporta el dato crudo, no lo formateado en pantalla: las fechas van en
 * ISO y los importes como número, para que Excel pueda ordenarlos y sumarlos.
 * Un `$ 1.500.400,00` bonito entra como texto y no sirve para nada.
 */
type Nombres = Record<string, string>;
const nombreDe = (nombres: Nombres, cuit: string) => nombres[cuit.replace(/\D/g, '')] ?? '';

const csvNotificaciones = (datos: Notificacion[]) => ({
  encabezados: ['fecha', 'organismo', 'asunto', 'estado', 'leida_en_arca', 'id_comunicacion'],
  filas: datos.map((n): ValorCsv[] => [
    n.fecha,
    n.organismo,
    n.asunto,
    n.estado,
    n.leida ? 'si' : 'no',
    n.idComunicacion,
  ]),
});

const csvSaldos = (datos: SaldoTributario[], nombres: Nombres) => ({
  encabezados: [
    'cuit', 'contribuyente', 'establecimiento', 'impuesto', 'concepto', 'subconcepto',
    'periodo', 'anticipo_cuota', 'vencimiento', 'saldo', 'interes_resarcitorio',
    'interes_punitorio', 'total',
  ],
  filas: datos.map((s): ValorCsv[] => [
    s.contribuyenteCuit,
    nombreDe(nombres, s.contribuyenteCuit),
    s.establecimiento,
    s.impuesto,
    s.concepto,
    s.subconcepto,
    s.periodo,
    s.anticipoCuota,
    s.fechaVencimiento,
    s.saldo,
    s.interesResarcitorio,
    s.interesPunitorio,
    totalSaldo(s),
  ]),
});

const csvVencimientos = (datos: DetalleCliente['vencimientos'], nombres: Nombres) => ({
  encabezados: [
    'cuit', 'contribuyente', 'impuesto', 'concepto', 'subconcepto', 'periodo',
    'anticipo_cuota', 'fecha', 'detalle',
  ],
  filas: datos.map((v): ValorCsv[] => [
    v.contribuyenteCuit,
    nombreDe(nombres, v.contribuyenteCuit),
    v.impuesto,
    v.concepto,
    v.subconcepto,
    v.periodo,
    v.anticipoCuota,
    v.fecha,
    v.detalle,
  ]),
});

const csvDdjj = (datos: DetalleCliente['ddjjPendientes'], nombres: Nombres) => ({
  encabezados: [
    'cuit', 'contribuyente', 'establecimiento', 'impuesto', 'concepto',
    'subconcepto', 'periodo', 'fecha',
  ],
  filas: datos.map((d): ValorCsv[] => [
    d.contribuyenteCuit,
    nombreDe(nombres, d.contribuyenteCuit),
    d.establecimiento,
    d.impuesto,
    d.concepto,
    d.subconcepto,
    d.periodo,
    d.fecha,
  ]),
});

const csvPlanes = (datos: PlanPago[]) => ({
  encabezados: [
    'numero', 'concepto', 'presentacion', 'estado', 'situacion', 'cuotas_totales',
    'cuotas_pagas', 'cuotas_impagas', 'monto_cuota', 'monto_consolidado',
    'proximo_vencimiento', 'total_pagado',
  ],
  filas: datos.map((p): ValorCsv[] => [
    p.numero,
    p.concepto,
    p.fechaPresentacion,
    p.estado,
    p.situacion,
    p.cuotasTotales,
    p.cuotasPagas,
    p.cuotasImpagas,
    p.montoCuota,
    p.montoConsolidado,
    p.proximoVencimiento,
    p.totalPagado,
  ]),
});

const csvComprobantes = (datos: Comprobante[], nombres: Nombres) => ({
  encabezados: [
    'cuit', 'contribuyente', 'tipo', 'fecha', 'comprobante', 'punto_venta',
    'numero', 'contraparte', 'cuit_contraparte', 'neto', 'iva', 'total',
  ],
  filas: datos.map((c): ValorCsv[] => [
    c.contribuyenteCuit,
    nombreDe(nombres, c.contribuyenteCuit),
    c.tipo,
    c.fecha,
    c.tipoComprobante,
    c.puntoVenta,
    c.numero,
    c.contraparte,
    c.cuitContraparte,
    c.neto,
    c.iva,
    c.total,
  ]),
});

/**
 * Botón de exportación de una sección.
 *
 * El CSV se arma en el navegador con los datos que ya están en pantalla: pedir
 * de nuevo lo mismo al servidor sería una ruta más para mantener y proteger,
 * sin ganar nada.
 */
function BotonExportar({
  nombre,
  encabezados,
  filas,
}: {
  nombre: string;
  encabezados: string[];
  filas: ValorCsv[][];
}) {
  if (filas.length === 0) return null;
  return (
    <button
      type="button"
      className="btn btn--chico"
      title={`Exportar ${filas.length} filas a CSV`}
      onClick={(e) => {
        // La cabecera de la sección despliega al hacer clic; sin esto, exportar
        // también la abre o la cierra.
        e.stopPropagation();
        descargarCsv(nombre, encabezados, filas);
      }}
    >
      Exportar CSV
    </button>
  );
}

function AgrupadosPorCuit<T extends { contribuyenteCuit: string }>({
  datos,
  etiqueta,
  renderGrupo,
  nombres,
  alGuardarNombre,
}: {
  datos: T[];
  etiqueta: string;
  renderGrupo: (datos: T[]) => ReactNode;
  /** CUIT sin guiones -> razón social. Ausente = todavía sin identificar. */
  nombres: Record<string, string>;
  alGuardarNombre: (cuit: string, nombre: string) => Promise<void>;
}) {
  const grupos = useMemo(() => {
    const agrupados = new Map<string, T[]>();
    for (const dato of datos) {
      const cuit = dato.contribuyenteCuit || 'CUIT sin identificar';
      agrupados.set(cuit, [...(agrupados.get(cuit) ?? []), dato]);
    }
    return [...agrupados.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [datos]);

  return (
    <div className="grupos-cuit">
      {grupos.map(([cuit, registros]) => (
        <section className="grupo-cuit" key={cuit}>
          <header className="grupo-cuit__cabecera">
            <div>
              <span>Contribuyente ARCA</span>
              <strong className="mono">{cuit}</strong>
              <NombreContribuyente
                cuit={cuit}
                nombre={nombres[cuit.replace(/\D/g, '')]}
                alGuardar={alGuardarNombre}
              />
            </div>
            <Badge tono="neutro">{plural(registros.length, etiqueta, etiqueta)}</Badge>
          </header>
          {renderGrupo(registros)}
        </section>
      ))}
    </div>
  );
}

/**
 * Razón social del contribuyente, con carga inline.
 *
 * El CUIT NO se tipea: sale del dato agrupado. Eso evita el error más probable
 * de un formulario suelto — cargar un nombre contra un CUIT mal escrito, que
 * después no matchea con nada y nadie nota, porque el grupo sigue sin nombre.
 */
function NombreContribuyente({
  cuit,
  nombre,
  alGuardar,
}: {
  cuit: string;
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
        {nombre ? (
          <strong>{nombre}</strong>
        ) : (
          <span className="tenue">Sin nombre cargado</span>
        )}{' '}
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

function TablaSaldos({ saldos }: { saldos: SaldoTributario[] }) {
  const paginacion = usePaginacion(saldos, claveSaldo);
  return (
    <>
      <div className="tabla-scroll">
        <table className="tabla tabla--saldos">
          <thead>
            <tr>
              <th>Est.</th>
              <th>Impuesto</th>
              <th>Concepto</th>
              <th>Período</th>
              <th>Ant./Cuota</th>
              <th>Venc.</th>
              <th className="der">Saldo</th>
              <th className="der">Int. resarc.</th>
              <th className="der">Int. pun.</th>
              <th className="der">Total</th>
            </tr>
          </thead>
          <tbody>
            {paginacion.elementosPagina.map((saldo) => (
              <tr key={claveSaldo(saldo)}>
                <td className="mono">{saldo.establecimiento || '—'}</td>
                <td>{saldo.impuesto}</td>
                <td>
                  {saldo.concepto || '—'}
                  {saldo.subconcepto && saldo.subconcepto !== saldo.concepto && (
                    <div className="tenue">{saldo.subconcepto}</div>
                  )}
                </td>
                <td className="mono">{saldo.periodo}</td>
                <td className="mono">{saldo.anticipoCuota || '—'}</td>
                <td>{saldo.fechaVencimiento ? fecha(saldo.fechaVencimiento) : '—'}</td>
                <td className="der mono monto--negativo">{pesos(Math.abs(saldo.saldo), true)}</td>
                <td className="der mono monto--negativo">
                  {pesos(Math.abs(saldo.interesResarcitorio), true)}
                </td>
                <td className="der mono monto--negativo">
                  {pesos(Math.abs(saldo.interesPunitorio), true)}
                </td>
                <td className="der mono fuerte monto--negativo">
                  {pesos(Math.abs(totalSaldo(saldo)), true)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginacion {...paginacion} etiqueta="obligaciones" />
    </>
  );
}

function claveSaldo(saldo: SaldoTributario): string {
  return [
    saldo.establecimiento,
    saldo.impuesto,
    saldo.concepto,
    saldo.subconcepto,
    saldo.periodo,
    saldo.anticipoCuota,
    saldo.fechaVencimiento,
  ].join('|');
}

function TablaVencimientos({
  vencimientos,
}: {
  vencimientos: DetalleCliente['vencimientos'];
}) {
  const paginacion = usePaginacion(vencimientos, (vencimiento) => vencimiento.id);
  return (
    <>
      <div className="tabla-scroll">
        <table className="tabla tabla--vencimientos">
          <thead>
            <tr>
              <th>Impuesto</th>
              <th>Concepto / Subconcepto</th>
              <th>Período</th>
              <th>Ant./Cuota</th>
              <th>Fecha</th>
              <th>Detalle</th>
              <th>Plazo</th>
            </tr>
          </thead>
          <tbody>
            {paginacion.elementosPagina.map((vencimiento) => {
              const dias = diasHasta(vencimiento.fecha);
              return (
                <tr key={vencimiento.id} className={dias < 0 ? 'fila--destacada' : undefined}>
                  <td>{vencimiento.impuesto}</td>
                  <td>
                    {vencimiento.concepto || '—'}
                    {vencimiento.subconcepto && vencimiento.subconcepto !== vencimiento.concepto && (
                      <div className="tenue">{vencimiento.subconcepto}</div>
                    )}
                  </td>
                  <td className="mono">{vencimiento.periodo}</td>
                  <td className="mono">{vencimiento.anticipoCuota || '—'}</td>
                  <td>{fecha(vencimiento.fecha)}</td>
                  <td>{vencimiento.detalle || '—'}</td>
                  <td>
                    {dias < 0 ? (
                      <Badge tono="error">{plazo(dias)}</Badge>
                    ) : dias <= 7 ? (
                      <Badge tono="alerta">{plazo(dias)}</Badge>
                    ) : (
                      <span className="tenue">{plazo(dias)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Paginacion {...paginacion} etiqueta="vencimientos" />
    </>
  );
}

function TablaDdjj({
  declaraciones,
}: {
  declaraciones: DetalleCliente['ddjjPendientes'];
}) {
  const paginacion = usePaginacion(declaraciones, (declaracion) => declaracion.id);
  return (
    <>
      <div className="tabla-scroll">
        <table className="tabla tabla--ddjj">
          <thead>
            <tr>
              <th>Est.</th>
              <th>Impuesto</th>
              <th>Concepto / Subconcepto</th>
              <th>Período</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {paginacion.elementosPagina.map((declaracion) => (
              <tr key={declaracion.id}>
                <td className="mono">{declaracion.establecimiento || '—'}</td>
                <td>{declaracion.impuesto}</td>
                <td>
                  {declaracion.concepto || '—'}
                  {declaracion.subconcepto && declaracion.subconcepto !== declaracion.concepto && (
                    <div className="tenue">{declaracion.subconcepto}</div>
                  )}
                </td>
                <td className="mono">{declaracion.periodo}</td>
                <td>{declaracion.fecha ? fecha(declaracion.fecha) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Paginacion {...paginacion} etiqueta="DDJJ pendientes" />
    </>
  );
}

function NotificacionesDfe({
  clienteId,
  notificaciones,
  alActualizarLectura,
}: {
  clienteId: string;
  notificaciones: Notificacion[];
  alActualizarLectura: (notificacionId: string, leidoAppEn: string | null) => void;
}) {
  const panelId = useId();
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [cargandoId, setCargandoId] = useState<string | null>(null);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [adjuntoDescargandoId, setAdjuntoDescargandoId] = useState<string | null>(null);
  const [errorAdjunto, setErrorAdjunto] = useState<string | null>(null);
  const seleccionada = notificaciones.find((notificacion) => notificacion.id === seleccionadaId);
  const paginacion = usePaginacion(notificaciones, (notificacion) => notificacion.id);

  useEffect(() => {
    if (seleccionadaId && !seleccionada) setSeleccionadaId(null);
  }, [seleccionada, seleccionadaId]);

  useEffect(() => {
    if (
      seleccionadaId &&
      !paginacion.elementosPagina.some((notificacion) => notificacion.id === seleccionadaId)
    ) {
      setSeleccionadaId(null);
      setErrorDetalle(null);
      setErrorAdjunto(null);
    }
  }, [paginacion.elementosPagina, seleccionadaId]);

  async function abrirNotificacion(notificacion: Notificacion) {
    const posicionScroll = { left: window.scrollX, top: window.scrollY };
    setSeleccionadaId(notificacion.id);
    setCargandoId(notificacion.id);
    setErrorDetalle(null);
    setErrorLectura(null);
    setErrorAdjunto(null);
    restaurarScrollDespuesDeRender(posicionScroll);
    try {
      const lectura = await actualizarLecturaNotificacion(clienteId, notificacion.id, true);
      alActualizarLectura(notificacion.id, lectura.leidoAppEn);
    } catch (e) {
      setErrorDetalle(
        e instanceof Error ? e.message : 'No se pudo abrir el detalle de la notificación.',
      );
    } finally {
      setCargandoId(null);
    }
  }

  async function marcarComoNoLeida(notificacion: Notificacion) {
    setCargandoId(notificacion.id);
    setErrorLectura(null);
    try {
      const lectura = await actualizarLecturaNotificacion(clienteId, notificacion.id, false);
      alActualizarLectura(notificacion.id, lectura.leidoAppEn);
    } catch (e) {
      setErrorLectura(
        e instanceof Error ? e.message : 'No se pudo cambiar el estado de lectura.',
      );
    } finally {
      setCargandoId(null);
    }
  }

  async function descargarAdjunto(adjunto: NotificacionAdjunto) {
    if (!seleccionada) return;
    setAdjuntoDescargandoId(adjunto.id);
    setErrorAdjunto(null);
    try {
      const archivo = await descargarAdjuntoNotificacion(
        clienteId,
        seleccionada.id,
        adjunto.id,
      );
      const url = URL.createObjectURL(archivo);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = adjunto.nombre;
      enlace.style.display = 'none';
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (e) {
      setErrorAdjunto(e instanceof Error ? e.message : 'No se pudo descargar el adjunto.');
    } finally {
      setAdjuntoDescargandoId(null);
    }
  }

  function cerrarDetalle() {
    const posicionScroll = { left: window.scrollX, top: window.scrollY };
    setSeleccionadaId(null);
    setErrorDetalle(null);
    setErrorAdjunto(null);
    restaurarScrollDespuesDeRender(posicionScroll);
  }

  return (
    <div className="notificaciones-dfe">
      <p className="notificaciones-dfe__aviso">
        Al actualizar, la app abre las comunicaciones en ARCA para descargar el contenido y los
        adjuntos. Como consecuencia, pasarán a figurar como leídas en el portal.
      </p>
      {errorLectura && <p className="aviso aviso--error" role="alert">{errorLectura}</p>}
      <div className="tabla-scroll">
        <table className="tabla tabla--notificaciones" aria-label="Notificaciones del Domicilio Fiscal Electrónico">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Organismo</th>
              <th>Asunto</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {paginacion.elementosPagina.map((notificacion) => {
              const seleccionada = seleccionadaId === notificacion.id;
              const clases = [
                notificacion.leidoAppEn === null ? 'fila--no-leida' : '',
                seleccionada ? 'fila--seleccionada' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <Fragment key={notificacion.id}>
                  <tr className={clases || undefined}>
                    <td>{fecha(notificacion.fecha)}</td>
                    <td>{notificacion.organismo}</td>
                    <td>
                      <button
                        type="button"
                        className="notificacion__abrir"
                        aria-expanded={seleccionada}
                        aria-controls={panelId}
                        disabled={cargandoId !== null}
                        onClick={() => abrirNotificacion(notificacion)}
                      >
                        <span>{notificacion.asunto}</span>
                        {notificacion.adjuntos.length > 0 && (
                          <span className="notificacion__adjuntos-resumen">
                            {plural(notificacion.adjuntos.length, 'adjunto', 'adjuntos')}
                          </span>
                        )}
                        {cargandoId === notificacion.id && (
                          <span className="notificacion__abriendo">Abriendo…</span>
                        )}
                      </button>
                    </td>
                    <td><BadgeLecturaLocal leido={notificacion.leidoAppEn !== null} /></td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--chico btn--lectura"
                        disabled={notificacion.leidoAppEn === null || cargandoId !== null}
                        onClick={() => marcarComoNoLeida(notificacion)}
                      >
                        {cargandoId === notificacion.id ? 'Guardando…' : 'Marcar como no leído'}
                      </button>
                    </td>
                  </tr>
                  {seleccionada && (
                    <tr className="notificacion-detalle__fila">
                      <td colSpan={5}>
                        <DetalleNotificacion
                          panelId={panelId}
                          notificacion={notificacion}
                          cargando={cargandoId === notificacion.id}
                          errorDetalle={errorDetalle}
                          errorAdjunto={errorAdjunto}
                          adjuntoDescargandoId={adjuntoDescargandoId}
                          alCerrar={cerrarDetalle}
                          alDescargar={(adjunto) => void descargarAdjunto(adjunto)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <Paginacion {...paginacion} etiqueta="notificaciones" />
    </div>
  );
}

function restaurarScrollDespuesDeRender(posicion: { left: number; top: number }): void {
  requestAnimationFrame(() => {
    window.scrollTo(posicion);
    requestAnimationFrame(() => window.scrollTo(posicion));
  });
}

function DetalleNotificacion({
  panelId,
  notificacion,
  cargando,
  errorDetalle,
  errorAdjunto,
  adjuntoDescargandoId,
  alCerrar,
  alDescargar,
}: {
  panelId: string;
  notificacion: Notificacion;
  cargando: boolean;
  errorDetalle: string | null;
  errorAdjunto: string | null;
  adjuntoDescargandoId: string | null;
  alCerrar: () => void;
  alDescargar: (adjunto: NotificacionAdjunto) => void;
}) {
  return (
    <article
      id={panelId}
      className="notificacion-detalle"
      role="region"
      aria-busy={cargando}
      aria-labelledby={`${panelId}-titulo`}
    >
      <header className="notificacion-detalle__cabecera">
        <div>
          <div className="notificacion-detalle__metadatos">
            <BadgeLecturaLocal leido={notificacion.leidoAppEn !== null} />
            <span>ARCA: {notificacion.leida ? 'leída' : 'sin leer'}</span>
            <span>{fecha(notificacion.fecha)}</span>
            <span>{notificacion.organismo}</span>
            <span className="mono">Comunicación {notificacion.idComunicacion}</span>
          </div>
          <h3 id={`${panelId}-titulo`}>{notificacion.asunto}</h3>
        </div>
        <button
          type="button"
          className="notificacion-detalle__cerrar"
          onClick={alCerrar}
          aria-label="Cerrar detalle de la notificación"
        >
          Cerrar
        </button>
      </header>

      {errorDetalle && <p className="aviso aviso--error" role="alert">{errorDetalle}</p>}

      <section className="notificacion-detalle__seccion" aria-labelledby={`${panelId}-cuerpo`}>
        <h4 id={`${panelId}-cuerpo`}>Contenido</h4>
        {cargando ? (
          <p className="tenue" role="status">Cargando el detalle…</p>
        ) : notificacion.cuerpo === null ? (
          <div className="notificacion-detalle__pendiente">
            El detalle todavía no pudo descargarse desde ARCA. Reintentá con “Actualizar y
            abrir en ARCA” para incorporar su contenido y adjuntos.
          </div>
        ) : notificacion.cuerpo.trim() ? (
          <div className="notificacion-detalle__cuerpo">{notificacion.cuerpo}</div>
        ) : (
          <p className="tenue">ARCA no informó texto adicional para esta comunicación.</p>
        )}
      </section>

      <section className="notificacion-detalle__seccion" aria-labelledby={`${panelId}-adjuntos`}>
        <h4 id={`${panelId}-adjuntos`}>
          Adjuntos <span className="notificacion-detalle__cantidad">{notificacion.adjuntos.length}</span>
        </h4>
        {notificacion.adjuntos.length > 0 ? (
          <ul className="notificacion-adjuntos">
            {notificacion.adjuntos.map((adjunto) => (
              <li key={adjunto.id} className="notificacion-adjunto">
                <div>
                  <strong>{adjunto.nombre}</strong>
                  <span>{adjunto.mimeType || 'Archivo'} · {formatearTamano(adjunto.tamano)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--chico"
                  disabled={adjuntoDescargandoId !== null}
                  onClick={() => alDescargar(adjunto)}
                >
                  {adjuntoDescargandoId === adjunto.id ? 'Descargando…' : 'Descargar'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tenue">Esta comunicación no tiene adjuntos.</p>
        )}
        {errorAdjunto && <p className="aviso aviso--error" role="alert">{errorAdjunto}</p>}
      </section>
    </article>
  );
}

function BadgeLecturaLocal({ leido }: { leido: boolean }) {
  return leido
    ? <Badge tono="neutro">Leído</Badge>
    : <Badge tono="alerta">No leído</Badge>;
}

function formatearTamano(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Tamaño no informado';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toLocaleString('es-AR', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1_048_576).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB`;
}

function TablaPlanes({
  clienteId,
  planes,
  alActualizarLectura,
}: {
  clienteId: string;
  planes: PlanPago[];
  alActualizarLectura: (planId: string, leidoAppEn: string | null) => void;
}) {
  const paginacion = usePaginacion(planes, (plan) => plan.id);
  return (
    <>
      <div className="planes">
        {paginacion.elementosPagina.map((plan) => (
          <DetallePlan
            key={plan.id}
            clienteId={clienteId}
            plan={plan}
            alActualizarLectura={alActualizarLectura}
          />
        ))}
      </div>
      <Paginacion {...paginacion} etiqueta="planes" />
    </>
  );
}

function DetallePlan({
  clienteId,
  plan,
  alActualizarLectura,
}: {
  clienteId: string;
  plan: PlanPago;
  alActualizarLectura: (planId: string, leidoAppEn: string | null) => void;
}) {
  const paginacion = usePaginacion(plan.cuotas, (cuota) => cuota.id);
  const [abierto, setAbierto] = useState(false);
  const [actualizandoLectura, setActualizandoLectura] = useState(false);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const variantes = new Map<number, number>();
  for (const cuota of plan.cuotas) {
    variantes.set(cuota.numero, (variantes.get(cuota.numero) ?? 0) + 1);
  }

  async function cambiarLectura(leido: boolean) {
    setActualizandoLectura(true);
    setErrorLectura(null);
    try {
      const lectura = await actualizarLecturaPlan(clienteId, plan.id, leido);
      alActualizarLectura(plan.id, lectura.leidoAppEn);
    } catch (e) {
      setErrorLectura(e instanceof Error ? e.message : 'No se pudo cambiar la lectura del plan.');
    } finally {
      setActualizandoLectura(false);
    }
  }

  return (
    <details
      className={`plan${plan.leidoAppEn === null ? ' plan--no-leido' : ''}`}
      open={abierto}
      onToggle={(evento) => {
        const abiertoAhora = evento.currentTarget.open;
        setAbierto(abiertoAhora);
        if (abiertoAhora && plan.leidoAppEn === null && !actualizandoLectura) {
          void cambiarLectura(true);
        }
      }}
    >
      <summary className="plan__resumen">
        <span className="plan__numero">{plan.numero}</span>
        <span className="plan__concepto">{plan.concepto}</span>
        <Badge tono={tonoSituacion(plan.situacion)}>{plan.situacion || plan.estado}</Badge>
        <span className="plan__monto mono">{pesos(plan.montoConsolidado, true)}</span>
        <span className="plan__lectura"><BadgeLecturaLocal leido={plan.leidoAppEn !== null} /></span>
        <button
          type="button"
          className="btn btn--chico btn--lectura plan__marcar-no-leido"
          disabled={plan.leidoAppEn === null || actualizandoLectura}
          onClick={(evento) => {
            evento.preventDefault();
            evento.stopPropagation();
            void cambiarLectura(false);
          }}
        >
          {actualizandoLectura ? 'Guardando…' : 'Marcar como no leído'}
        </button>
      </summary>
      <div className="plan__contenido">
        {errorLectura && <p className="aviso aviso--error" role="alert">{errorLectura}</p>}
        <dl className="plan__datos">
          <div><dt>Presentación</dt><dd>{plan.fechaPresentacion ? fecha(plan.fechaPresentacion) : '—'}</dd></div>
          <div><dt>Consolidación</dt><dd>{plan.fechaConsolidacion ? fecha(plan.fechaConsolidacion) : '—'}</dd></div>
          <div><dt>Tipo de plan</dt><dd>{plan.tipoPlan || '—'}</dd></div>
          <div><dt>Estado</dt><dd>{plan.estado || '—'}</dd></div>
          <div><dt>Cuotas pagas</dt><dd>{plan.cuotasPagas}/{plan.cuotasTotales}</dd></div>
          <div><dt>Total pagado</dt><dd>{pesos(plan.totalPagado, true)}</dd></div>
        </dl>
        {plan.cuotasImpagas > 0 && (
          <p><Badge tono="error">{plural(plan.cuotasImpagas, 'cuota impaga', 'cuotas impagas')}</Badge></p>
        )}
        {plan.cuotas.length > 0 ? (
          <>
            <div className="tabla-scroll">
              <table className="tabla tabla--cuotas">
                <thead>
                  <tr>
                    <th>Cuota</th>
                    <th className="der">Capital</th>
                    <th className="der">Interés financiero</th>
                    <th className="der">Interés resarcitorio</th>
                    <th className="der">Total</th>
                    <th>Vencimiento</th>
                    <th>Pago</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {paginacion.elementosPagina.map((cuota) => (
                    <tr key={cuota.id} className={normalizarBusqueda(cuota.estado).includes('impaga') ? 'fila--destacada' : undefined}>
                      <td className="mono">
                        {cuota.numero}
                        {(variantes.get(cuota.numero) ?? 0) > 1 && <span className="tenue"> · vto. {cuota.variante}</span>}
                      </td>
                      <td className="der mono">{pesos(cuota.capital, true)}</td>
                      <td className="der mono">{pesos(cuota.interesFinanciero, true)}</td>
                      <td className="der mono">{pesos(cuota.interesResarcitorio, true)}</td>
                      <td className="der mono fuerte">{pesos(cuota.total, true)}</td>
                      <td>{cuota.fechaVencimiento ? fecha(cuota.fechaVencimiento) : '—'}</td>
                      <td>{cuota.pago || '—'}</td>
                      <td>{cuota.estado || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacion {...paginacion} etiqueta={`cuotas del plan ${plan.numero}`} />
          </>
        ) : (
          <p className="tenue">ARCA no informó filas en Ver Pagos para este plan.</p>
        )}
      </div>
    </details>
  );
}

function tonoSituacion(situacion: string): 'ok' | 'alerta' | 'error' | 'neutro' {
  const valor = normalizarBusqueda(situacion);
  if (valor.includes('vigente')) return 'ok';
  if (valor.includes('caduc')) return 'error';
  if (valor.includes('cancel')) return 'neutro';
  return 'alerta';
}

type FiltroTipo = 'AMBOS' | TipoComprobante;
type OrdenFecha = 'DESC' | 'ASC';

function TablaComprobantes({ comprobantes }: { comprobantes: Comprobante[] }) {
  const [tipo, setTipo] = useState<FiltroTipo>('AMBOS');
  const [busqueda, setBusqueda] = useState('');
  const [orden, setOrden] = useState<OrdenFecha>('DESC');

  const visibles = useMemo(() => {
    const termino = normalizarBusqueda(busqueda.trim());
    return comprobantes
      .filter((c) => tipo === 'AMBOS' || c.tipo === tipo)
      .filter((c) => !termino || textoBuscable(c).includes(termino))
      .toSorted((a, b) =>
        orden === 'DESC' ? b.fecha.localeCompare(a.fecha) : a.fecha.localeCompare(b.fecha),
      );
  }, [busqueda, comprobantes, orden, tipo]);
  const paginacion = usePaginacion(
    visibles,
    (comprobante) => comprobante.id,
    `${tipo}\u0000${busqueda}\u0000${orden}`,
  );

  return (
    <>
      <div className="filtros-comprobantes">
        <label className="campo filtros-comprobantes__tipo">
          <span className="campo__etiqueta">Mostrar</span>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as FiltroTipo)}>
            <option value="AMBOS">Emitidos y recibidos</option>
            <option value="EMITIDO">Sólo emitidos</option>
            <option value="RECIBIDO">Sólo recibidos</option>
          </select>
        </label>
        <label className="campo filtros-comprobantes__buscar">
          <span className="campo__etiqueta">Buscar en todas las columnas</span>
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Empresa, CUIT, comprobante, importe…"
          />
        </label>
        <div className="filtros-comprobantes__cantidad" aria-live="polite">
          {visibles.length} de {comprobantes.length} comprobantes
        </div>
      </div>

      <div className="tabla-scroll">
        <table className="tabla tabla--comprobantes">
          <thead>
            <tr>
            <th aria-sort={orden === 'DESC' ? 'descending' : 'ascending'}>
              <button
                type="button"
                className="tabla__orden"
                onClick={() => setOrden(orden === 'DESC' ? 'ASC' : 'DESC')}
                title="Invertir el orden por fecha"
              >
                Fecha {orden === 'DESC' ? '↓' : '↑'}
              </button>
            </th>
            <th>Tipo</th>
            <th>Comprobante</th>
            <th>Nro.</th>
            <th>Razón social</th>
            <th className="der">Neto</th>
            <th className="der">IVA</th>
            <th className="der">Total</th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 ? (
              <tr>
                <td colSpan={8} className="tabla__sin-resultados">
                  No hay comprobantes que coincidan con los filtros.
                </td>
              </tr>
            ) : (
              paginacion.elementosPagina.map((c) => (
                <tr key={c.id}>
                  <td>{fecha(c.fecha)}</td>
                  <td>
                    <Badge tono={c.tipo === 'EMITIDO' ? 'ok' : 'neutro'}>
                      {c.tipo === 'EMITIDO' ? 'Emitido' : 'Recibido'}
                    </Badge>
                  </td>
                  <td>{c.tipoComprobante}</td>
                  <td className="mono">{numeroComprobante(c)}</td>
                  <td>
                    {c.contraparte}
                    <div className="tenue mono">{c.cuitContraparte}</div>
                  </td>
                  <td className="der mono">{pesos(c.neto, true)}</td>
                  <td className="der mono">{pesos(c.iva, true)}</td>
                  <td className="der mono fuerte">{pesos(c.total, true)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Paginacion {...paginacion} etiqueta="comprobantes" />
    </>
  );
}

function numeroComprobante(c: Comprobante): string {
  return `${String(c.puntoVenta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`;
}

function textoBuscable(c: Comprobante): string {
  return normalizarBusqueda(
    [
      c.fecha,
      fecha(c.fecha),
      c.tipo,
      c.tipo === 'EMITIDO' ? 'Emitido' : 'Recibido',
      c.tipoComprobante,
      numeroComprobante(c),
      c.contraparte,
      c.cuitContraparte,
      c.neto,
      c.iva,
      c.total,
      pesos(c.neto, true),
      pesos(c.iva, true),
      pesos(c.total, true),
    ].join(' '),
  );
}

function normalizarBusqueda(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-AR');
}

function partesFechaArgentina(): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
}

function claveAnioActual(): string {
  const partes = partesFechaArgentina();
  return partes['year'] ?? String(new Date().getFullYear());
}

function Seccion({
  titulo,
  vacio,
  accion,
  children,
}: {
  titulo: string;
  vacio: string;
  accion?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [abierta, setAbierta] = useState(false);
  const contenidoId = useId();
  const tieneContenido = Boolean(children);
  return (
    <section className={`seccion seccion--plegable${abierta ? ' seccion--abierta' : ''}`}>
      <div className="seccion__cabecera">
        <h2 className="seccion__titulo">
          <button
            type="button"
            className="seccion__desplegar"
            aria-expanded={abierta}
            aria-controls={contenidoId}
            aria-label={`${abierta ? 'Contraer' : 'Desplegar'} ${titulo}`}
            onClick={() => setAbierta((valor) => !valor)}
          >
            <span className="seccion__chevron" aria-hidden="true">▸</span>
            <span>{titulo}</span>
          </button>
        </h2>
        {accion}
      </div>
      <div
        id={contenidoId}
        className="seccion__animacion"
        aria-hidden={!abierta}
        inert={abierta ? undefined : true}
      >
        <div className="seccion__contenido">
          {tieneContenido ? children : <p className="tenue">{vacio}</p>}
        </div>
      </div>
    </section>
  );
}
