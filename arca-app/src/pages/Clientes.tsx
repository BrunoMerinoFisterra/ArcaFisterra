import { Fragment, useEffect, useState, type FormEvent } from 'react';
import {
  crearCliente,
  esperarJob,
  guardarCredencial,
  obtenerAdministracionClientes,
  sincronizarCompleto,
  validarCuit,
} from '../api/client';
import type { AdministracionClientes, Cliente, SyncJob } from '../types';
import { desde } from '../lib/format';
import { Badge, EstadoSyncBadge } from '../components/Badge';
import { ModalCargando } from '../components/ModalCargando';
import { plural } from '../lib/plural';

export default function Clientes() {
  const [administracion, setAdministracion] = useState<AdministracionClientes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [clienteSincronizando, setClienteSincronizando] = useState<Cliente | null>(null);
  const [jobSincronizando, setJobSincronizando] = useState<SyncJob | null>(null);

  const recargar = () => obtenerAdministracionClientes().then(setAdministracion);
  useEffect(() => {
    void recargar().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los clientes.');
    });
  }, []);

  async function accion(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló.');
    }
  }

  async function sincronizarCliente(cliente: Cliente) {
    setError(null);
    setClienteSincronizando(cliente);
    try {
      const job = await sincronizarCompleto(cliente.id);
      setJobSincronizando(job);
      await recargar();
      const terminado = await esperarJob(cliente.id, job.id, setJobSincronizando);
      if (terminado.estado !== 'DONE') {
        throw new Error(terminado.error ?? 'No se pudo completar la sincronización de ARCA.');
      }
      await recargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo falló.');
      await recargar().catch(() => undefined);
    } finally {
      setClienteSincronizando(null);
      setJobSincronizando(null);
    }
  }

  if (!administracion && error) return <div className="aviso aviso--error">{error}</div>;
  if (!administracion) return <p className="vacio">Cargando clientes…</p>;
  const { clientes, cantidadClientes, limiteClientes, excedido } = administracion;
  const sinCupo =
    limiteClientes !== null && cantidadClientes >= limiteClientes;

  return (
    <>
      {clienteSincronizando && (
        <ModalCargando
          cliente={clienteSincronizando.razonSocial}
          tarea="Sincronizando todos los servicios fiscales en una sola sesión."
          job={jobSincronizando}
        />
      )}
      <header className="encabezado-pagina">
        <h1 className="titulo-pareado">
          <strong>ADMINISTRACIÓN</strong>
          <span>de clientes</span>
        </h1>
        <p>Accesos, credenciales y sincronizaciones ARCA.</p>
        <p className="tenue">
          {limiteClientes === null
            ? `${clientes.length} clientes · cuenta sin límite`
            : `${clientes.length} de ${limiteClientes} ${
                limiteClientes === 1 ? 'cliente utilizado' : 'clientes utilizados'
              }`}
        </p>
      </header>

      {error && <div className="aviso aviso--error">{error}</div>}

      {excedido && limiteClientes !== null && (
        <div className="aviso aviso--bloqueo" role="alert">
          <strong>Cupo excedido: acceso fiscal temporalmente bloqueado.</strong>
          <span>
            Tenés {plural(cantidadClientes, 'cliente activo', 'clientes activos')} y tu cupo es de{' '}
            {limiteClientes}. Un administrador debe quitar{' '}
            {plural(cantidadClientes - limiteClientes, 'cliente', 'clientes')} de tu cuenta para
            rehabilitar el tablero, los detalles y las sincronizaciones.
          </span>
        </div>
      )}

      {!excedido && (
        <AltaCliente
          sinCupo={sinCupo}
          limite={limiteClientes}
          onCrear={(datos) => accion(() => crearCliente(datos))}
        />
      )}

      <section className="seccion">
        <h2 className="seccion__titulo">
          {plural(clientes.length, 'cliente', 'clientes')}
        </h2>
        <table className="tabla">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Acceso ARCA</th>
              <th>Sincronización</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => (
              // La key va en el Fragment, que es el elemento que devuelve el
              // map. Ponerla en el <tr> de adentro no cuenta.
              <Fragment key={c.id}>
                <tr>
                  <td>
                    <div className="fuerte">{c.razonSocial}</div>
                    <div className="tenue mono">{c.cuit}</div>
                  </td>
                  <td>
                    {/*
                      La clave nunca se muestra ni se puede recuperar: la API
                      solo permite escribirla. Lo unico que se expone es cuando
                      se cargo, que alcanza para saber si esta al dia.
                    */}
                    {c.credencialCargadaEn ? (
                      <>
                        <span className="mono">••••••••</span>
                        <div className="tenue">cargada {desde(c.credencialCargadaEn)}</div>
                      </>
                    ) : (
                      <Badge tono="neutro">Sin cargar</Badge>
                    )}
                  </td>
                  <td>
                    <EstadoSyncBadge estado={c.estadoSync} credencial={c.estadoCredencial} />
                    <div className="tenue">{desde(c.ultimoSync)}</div>
                  </td>
                  <td className="der">
                    <button
                      className="btn btn--chico"
                      onClick={() => setExpandido(expandido === c.id ? null : c.id)}
                    >
                      {expandido === c.id ? 'Cerrar' : excedido ? 'Ver bloqueo' : 'Gestionar'}
                    </button>
                  </td>
                </tr>
                {expandido === c.id && (
                  <tr>
                    <td colSpan={4} className="panel-gestion">
                      <PanelGestion
                        cliente={c}
                        bloqueadoPorCupo={excedido}
                        onCredencial={(usuarioCuit, clave) =>
                          accion(() => guardarCredencial(c.id, usuarioCuit, clave))
                        }
                        onSincronizar={() => void sincronizarCliente(c)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function AltaCliente({
  onCrear,
  sinCupo,
  limite,
}: {
  onCrear: (datos: { cuit: string; razonSocial: string }) => void;
  sinCupo: boolean;
  limite: number | null;
}) {
  const [cuit, setCuit] = useState('');
  const [razonSocial, setRazonSocial] = useState('');
  const [abierto, setAbierto] = useState(false);

  // Se valida mientras escribe, pero el error solo aparece con 11 digitos:
  // marcar en rojo un CUIT a medio tipear es ruido.
  const problemaCuit = cuit.replace(/\D/g, '').length === 11 ? validarCuit(cuit) : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problemaCuit) return;
    onCrear({ cuit, razonSocial });
    setCuit('');
    setRazonSocial('');
    setAbierto(false);
  }

  if (!abierto) {
    return sinCupo ? (
      <div className="aviso">
        Alcanzaste el límite de {plural(limite ?? 0, 'cliente', 'clientes')}. Un administrador debe ampliar tu cupo para
        poder agregar otro.
      </div>
    ) : (
      <button className="btn btn--primario btn--bloque" onClick={() => setAbierto(true)}>
        + Agregar cliente
      </button>
    );
  }

  return (
    <form className="seccion" onSubmit={onSubmit}>
      <h2 className="seccion__titulo">Nuevo cliente</h2>
      <div className="fila-campos">
        <label className="campo">
          <span className="campo__etiqueta">CUIT del contribuyente a consultar</span>
          <input
            value={cuit}
            onChange={(e) => setCuit(e.target.value)}
            placeholder="30-71234567-4"
            required
          />
          <span className="campo__ayuda">El de la empresa o persona cuyos datos querés traer.</span>
          {problemaCuit && <span className="campo__error">{problemaCuit}</span>}
        </label>
        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Razón social</span>
          <input
            value={razonSocial}
            onChange={(e) => setRazonSocial(e.target.value)}
            placeholder="Molinos del Sur S.A."
            required
          />
        </label>
      </div>
      <div className="acciones">
        <button className="btn btn--primario" type="submit" disabled={Boolean(problemaCuit)}>
          Crear
        </button>
        <button className="btn" type="button" onClick={() => setAbierto(false)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function PanelGestion({
  cliente,
  bloqueadoPorCupo,
  onCredencial,
  onSincronizar,
}: {
  cliente: Cliente;
  bloqueadoPorCupo: boolean;
  onCredencial: (usuarioCuit: string, clave: string) => void;
  onSincronizar: () => void;
}) {
  const [usuarioCuit, setUsuarioCuit] = useState(cliente.cuit);
  const [clave, setClave] = useState('');

  return (
    <div className="gestion">
      {bloqueadoPorCupo && (
        <div className="gestion__bloque">
          <h3>Acceso bloqueado por cupo</h3>
          <p className="tenue">
            La empresa sigue asignada, pero sólo un administrador puede quitarla. Contactalo para
            regularizar la cuenta.
          </p>
        </div>
      )}

      {!bloqueadoPorCupo && <div className="gestion__bloque">
        <h3>1. Acceso ARCA</h3>
        <p className="tenue">
          Puede ser el CUIT de la persona que administra o representa al cliente. El usuario y la
          contraseña se guardan cifrados y sólo se pueden reemplazar.
        </p>
        <div className="fila-campos">
          <label className="campo">
            <span className="campo__etiqueta">Usuario ARCA (CUIT)</span>
            <input
              value={usuarioCuit}
              onChange={(e) => setUsuarioCuit(e.target.value)}
              placeholder="20-12345678-3"
              autoComplete="username"
            />
          </label>
          <label className="campo campo--ancho">
            <span className="campo__etiqueta">Contraseña / clave fiscal</span>
            <input
              type="password"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
              placeholder={cliente.credencialCargadaEn ? 'Reemplazar contraseña' : 'Contraseña'}
              autoComplete="new-password"
            />
          </label>
          <button
            className="btn btn--primario"
            disabled={usuarioCuit.trim().length === 0 || clave.length === 0}
            onClick={() => {
              onCredencial(usuarioCuit, clave);
              setClave('');
            }}
          >
            Guardar
          </button>
        </div>
      </div>}

      {!bloqueadoPorCupo && <div className="gestion__bloque">
        <h3>2. Sincronización</h3>
        <p className="tenue">
          Encola un job para <code>arca-worker</code>. El scraping no corre en el navegador.
        </p>
        <button
          className="btn"
          disabled={
            cliente.estadoCredencial !== 'OK' || cliente.estadoSync === 'SINCRONIZANDO'
          }
          onClick={onSincronizar}
        >
          Sincronizar todos los servicios
        </button>
        {cliente.estadoCredencial !== 'OK' && (
          <p className="tenue">Requiere una credencial en estado correcto.</p>
        )}
      </div>}

    </div>
  );
}
