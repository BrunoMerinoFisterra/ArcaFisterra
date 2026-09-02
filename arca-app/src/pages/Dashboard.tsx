import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorApi, listarEmpresas, listarResumenClientes } from '../api/client';
import type { EmpresaRepresentada, ResumenCliente } from '../types';
import { desde, pesos } from '../lib/format';
import { plural } from '../lib/plural';
import { Badge, EstadoSyncBadge } from '../components/Badge';
import { IrisLink } from '../components/IrisLink';

export default function Dashboard() {
  const [resumenes, setResumenes] = useState<ResumenCliente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bloqueoCupo, setBloqueoCupo] = useState<string | null>(null);
  const [empresas, setEmpresas] = useState<EmpresaRepresentada[] | null>(null);

  useEffect(() => {
    let vigente = true;
    listarResumenClientes()
      .then((r) => {
        if (vigente) setResumenes(r);
      })
      .catch((e: unknown) => {
        if (!vigente) return;
        if (e instanceof ErrorApi && e.status === 409) {
          setBloqueoCupo(e.message);
        } else {
          setError(e instanceof Error ? e.message : 'No se pudo cargar el tablero.');
        }
      });
    // Las empresas van en su propio pedido: el resumen es por cuenta y este
    // listado es por (cuenta, empresa), otra granularidad.
    listarEmpresas()
      .then((e) => {
        if (vigente) setEmpresas(e);
      })
      .catch(() => {
        // Un fallo aca no debe tapar el tablero: la seccion simplemente no se
        // muestra.
      });
    return () => {
      vigente = false;
    };
  }, []);

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
  if (error) return <div className="aviso aviso--error">{error}</div>;
  if (!resumenes) return <p className="vacio">Cargando clientes…</p>;

  const conProblemas = resumenes.filter((r) => r.cliente.estadoSync !== 'OK').length;
  const sinLeer = resumenes.reduce((a, r) => a + r.notificacionesSinLeer, 0);
  const impagas = resumenes.reduce((a, r) => a + r.cuotasImpagas, 0);

  return (
    <>
      <header className="encabezado-pagina">
        <h1 className="titulo-pareado">
          <strong>TABLERO FISCAL</strong>
          <span>por cliente</span>
        </h1>
        <p>Ordenado por lo que necesita atención primero.</p>
      </header>

      <div className="tira-kpi">
        <Kpi valor={resumenes.length} etiqueta="Clientes" />
        <Kpi valor={conProblemas} etiqueta="Con problemas" tono={conProblemas ? 'error' : 'ok'} />
        <Kpi valor={sinLeer} etiqueta="Notificaciones sin leer" tono={sinLeer ? 'alerta' : 'ok'} />
        <Kpi valor={impagas} etiqueta="Cuotas impagas" tono={impagas ? 'alerta' : 'ok'} />
      </div>

      <div className="grilla">
        {resumenes.map((r) => (
          <ClienteCard key={r.cliente.id} resumen={r} />
        ))}
      </div>

      <ListaEmpresas empresas={empresas} />
    </>
  );
}

/**
 * Las empresas por las que cada cuenta puede actuar en ARCA.
 *
 * Una fila por (cuenta, empresa): si dos claves representan a la misma empresa
 * aparece dos veces, cada una con su representante, porque los datos que se ven
 * son los que bajó ESA cuenta.
 *
 * Entrar lleva al detalle filtrado por su CUIT — que es el punto de todo esto:
 * dejar de ver la carpeta fiscal de todos los representados mezclada.
 */
function ListaEmpresas({ empresas }: { empresas: EmpresaRepresentada[] | null }) {
  if (empresas === null) return null;
  if (empresas.length === 0) {
    return (
      <section className="seccion">
        <h2>Empresas</h2>
        <p className="vacio">
          Todavía no hay empresas conocidas. Aparecen después de la primera sincronización de cada
          cuenta, con lo que ARCA ofrezca en cada servicio.
        </p>
      </section>
    );
  }

  return (
    <section className="seccion">
      <h2>Empresas</h2>
      <p className="tenue">
        {plural(empresas.length, 'empresa', 'empresas')} sobre las que podés actuar. Al entrar vas a
        ver sólo lo de esa empresa.
      </p>
      <div className="tabla-scroll">
        <table className="tabla">
          <thead>
            <tr>
              <th>Empresa</th>
              <th>CUIT</th>
              <th>Representada por</th>
              <th>Visto en</th>
            </tr>
          </thead>
          <tbody>
            {empresas.map((empresa) => (
              <tr key={`${empresa.clienteId} ${empresa.cuit}`}>
                <td>
                  <Link to={`/cliente/${empresa.clienteId}?empresa=${empresa.cuit}`}>
                    {empresa.nombre}
                  </Link>
                  {empresa.esTitular && <Badge tono="neutro">Titular</Badge>}
                </td>
                <td className="numero">{empresa.cuit}</td>
                <td>{empresa.representante.razonSocial}</td>
                <td className="tenue">{empresa.vistoEn || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Kpi({
  valor,
  etiqueta,
  tono = 'neutro',
}: {
  valor: number;
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

function ClienteCard({ resumen }: { resumen: ResumenCliente }) {
  const {
    cliente,
    notificacionesSinLeer,
    cuotasImpagas,
    vencimientosProximos,
    saldoTotal,
    tieneSaldos,
  } = resumen;
  const enDeuda = saldoTotal < 0;
  const destino = `/cliente/${cliente.id}`;

  return (
    <IrisLink
      to={destino}
      className="card"
    >
      <div className="card__cabecera">
        <div>
          <div className="card__titulo">{cliente.razonSocial}</div>
          <div className="card__cuit">{cliente.cuit}</div>
        </div>
        <EstadoSyncBadge estado={cliente.estadoSync} credencial={cliente.estadoCredencial} />
      </div>

      {cliente.detalleSync && <p className="card__detalle">{cliente.detalleSync}</p>}

      <div className="card__saldo">
        {tieneSaldos ? (
          <>
            <span className="card__saldo-etiqueta">
              {enDeuda ? 'Deuda total' : saldoTotal > 0 ? 'Saldo a favor' : 'Saldo'}
            </span>
            <span
              className={
                enDeuda ? 'monto monto--negativo' : saldoTotal > 0 ? 'monto monto--positivo' : 'monto'
              }
            >
              {pesos(Math.abs(saldoTotal))}
            </span>
          </>
        ) : (
          <span className="card__saldo-etiqueta">Sin datos de saldos</span>
        )}
      </div>

      <div className="card__alertas">
        {notificacionesSinLeer > 0 && (
          <Badge tono="alerta">
            {plural(notificacionesSinLeer, 'notificación', 'notificaciones')}
          </Badge>
        )}
        {cuotasImpagas > 0 && (
          <Badge tono="error">{plural(cuotasImpagas, 'cuota impaga', 'cuotas impagas')}</Badge>
        )}
        {vencimientosProximos > 0 && (
          <Badge tono="neutro">
            {plural(vencimientosProximos, 'vencimiento', 'vencimientos')}
          </Badge>
        )}
        {notificacionesSinLeer === 0 && cuotasImpagas === 0 && vencimientosProximos === 0 && (
          <span className="card__sin-alertas">Sin novedades</span>
        )}
      </div>

      <div className="card__pie">Última sincronización: {desde(cliente.ultimoSync)}</div>
    </IrisLink>
  );
}
