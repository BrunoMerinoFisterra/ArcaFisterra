import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorApi, listarEmpresas, listarResumenClientes } from '../api/client';
import type { ResumenCliente, ResumenEmpresa } from '../types';
import { desde, pesos } from '../lib/format';
import { plural } from '../lib/plural';
import { Badge, EstadoSyncBadge } from '../components/Badge';
import { IrisLink } from '../components/IrisLink';

export default function Dashboard() {
  const [resumenes, setResumenes] = useState<ResumenCliente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bloqueoCupo, setBloqueoCupo] = useState<string | null>(null);
  const [empresas, setEmpresas] = useState<ResumenEmpresa[] | null>(null);
  const [fallaEmpresas, setFallaEmpresas] = useState(false);

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
        // Un fallo aca no debe tapar el tablero, pero tampoco puede quedar
        // como "Cargando…" para siempre: el panel se veria colgado sin decir
        // que el pedido ya termino y salio mal.
        if (vigente) setFallaEmpresas(true);
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
          <span>por empresa</span>
        </h1>
        <p>Ordenado por lo que necesita atención primero.</p>
      </header>

      <div className="tira-kpi">
        {/* Sin el listado cargado no hay numero honesto que poner: mostrar el
            de cuentas bajo la etiqueta "Empresas" seria decir otra cosa. */}
        <Kpi valor={empresas?.length ?? '—'} etiqueta="Empresas" />
        <Kpi valor={conProblemas} etiqueta="Cuentas con problemas" tono={conProblemas ? 'error' : 'ok'} />
        <Kpi valor={sinLeer} etiqueta="Notificaciones sin leer" tono={sinLeer ? 'alerta' : 'ok'} />
        <Kpi valor={impagas} etiqueta="Cuotas impagas" tono={impagas ? 'alerta' : 'ok'} />
      </div>

      {/* Las empresas primero: es la unidad en la que se trabaja. Las cuentas
          quedan abajo porque lo que aportan es el estado de la credencial, que
          se mira cuando algo falla, no todos los dias.
          Los dos bloques usan el mismo patron —titulo suelto y grilla— para que
          se lean como dos listas de tarjetas y no como una adentro de la otra. */}
      <section className="bloque">
        <h2 className="bloque__titulo">Empresas</h2>
        <p className="tenue bloque__bajada">
          Cada empresa por la que podés actuar en ARCA, con sus propios números. Al entrar vas a ver
          sólo lo de esa empresa.
        </p>
        {fallaEmpresas ? (
          <p className="vacio">No se pudo cargar el listado de empresas. Probá recargar la página.</p>
        ) : empresas === null ? (
          <p className="vacio">Cargando empresas…</p>
        ) : empresas.length === 0 ? (
          <p className="vacio">
            Todavía no hay empresas conocidas. Aparecen después de la primera sincronización de cada
            cuenta, con lo que ARCA ofrezca en cada servicio.
          </p>
        ) : (
          <div className="grilla">
            {empresas.map((r) => (
              <EmpresaCard key={`${r.empresa.clienteId} ${r.empresa.cuit}`} resumen={r} />
            ))}
          </div>
        )}
      </section>

      <section className="bloque">
        <h2 className="bloque__titulo">Cuentas</h2>
        <p className="tenue bloque__bajada">
          Las claves fiscales cargadas. Entrar acá muestra todo lo de la cuenta junto, sin separar
          por empresa.
        </p>
        <div className="grilla">
          {resumenes.map((r) => (
            <ClienteCard key={r.cliente.id} resumen={r} />
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * Una empresa con sus numeros. Entra al detalle ya filtrado por su CUIT.
 *
 * El estado que muestra el badge es el de la CUENTA: si la clave fiscal esta
 * invalida, esta empresa no se sincroniza aunque sus datos esten impecables, y
 * eso hay que verlo sin entrar.
 */
function EmpresaCard({ resumen }: { resumen: ResumenEmpresa }) {
  const {
    empresa,
    notificacionesSinLeer,
    cuotasImpagas,
    vencimientosProximos,
    saldoTotal,
    tieneSaldos,
    estadoCredencial,
    estadoSync,
  } = resumen;
  const enDeuda = saldoTotal < 0;

  return (
    <IrisLink to={`/cliente/${empresa.clienteId}?empresa=${empresa.cuit}`} className="card">
      <div className="card__cabecera">
        <div>
          <div className="card__titulo">{empresa.nombre}</div>
          <div className="card__cuit">
            {empresa.cuit}
            {empresa.esTitular && <Badge tono="neutro">Titular</Badge>}
          </div>
        </div>
        <EstadoSyncBadge estado={estadoSync} credencial={estadoCredencial} />
      </div>

      <p className="card__detalle">Representada por {empresa.representante.razonSocial}</p>

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
          <Badge tono="neutro">{plural(vencimientosProximos, 'vencimiento', 'vencimientos')}</Badge>
        )}
        {notificacionesSinLeer === 0 && cuotasImpagas === 0 && vencimientosProximos === 0 && (
          <span className="card__sin-alertas">Sin novedades</span>
        )}
      </div>

      {/* El servicio donde ARCA la ofreció por última vez. Explica por qué una
          empresa tiene unos módulos y no otros, y era la única columna de la
          tabla anterior que no sobrevivió al pasar a tarjetas. */}
      <div className="card__pie">Visto en: {empresa.vistoEn || '—'}</div>
    </IrisLink>
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
