import { Fragment, useEffect, useState, type FormEvent } from 'react';
import {
  crearCliente,
  ErrorApi,
  esperarJob,
  esperarSolicitud,
  guardarCredencial,
  guardarNombreContribuyente,
  listarEmpresasDeCliente,
  obtenerAdministracionClientes,
  pedirAccesoAEmpresa,
  sincronizarCompleto,
  validarCuit,
} from '../api/client';
import type {
  AdministracionClientes,
  Cliente,
  EmpresaRepresentada,
  SolicitudAcceso,
  SyncJob,
} from '../types';
import { desde } from '../lib/format';
import { Badge, EstadoSyncBadge } from '../components/Badge';
import { ModalCargando } from '../components/ModalCargando';
import { NombreContribuyente } from '../components/NombreContribuyente';
import { plural } from '../lib/plural';

export default function Clientes() {
  const [administracion, setAdministracion] = useState<AdministracionClientes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [clienteSincronizando, setClienteSincronizando] = useState<Cliente | null>(null);
  const [jobSincronizando, setJobSincronizando] = useState<SyncJob | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [verificando, setVerificando] = useState<SolicitudAcceso | null>(null);

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

  /**
   * Variante que RELANZA. El alta la necesita así: un CUIT ya cargado no es un
   * final de camino sino un desvío, y el formulario tiene que poder verlo para
   * ofrecer el pedido de acceso en vez de mostrar un cartel rojo y cerrarse.
   */
  async function accionRelanzando(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await recargar();
    } catch (e) {
      if (e instanceof ErrorApi && e.codigo === 'CUIT_YA_CARGADO') throw e;
      setError(e instanceof Error ? e.message : 'Algo falló.');
    }
  }

  async function pedirAcceso(datos: { cuit: string; usuarioCuit: string; clave: string }) {
    setError(null);
    setMensaje(null);
    try {
      const { solicitud } = await pedirAccesoAEmpresa(datos);
      setVerificando(solicitud);
      const resuelta = await esperarSolicitud(solicitud.id, setVerificando);
      await recargar();
      if (resuelta.estado === 'APROBADA') {
        setMensaje(`${resuelta.razonSocial} quedó agregada a tu cuenta.`);
      } else {
        setError(resuelta.detalle ?? 'ARCA no confirmó que esa clave pueda acceder a la empresa.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo verificar el acceso.');
    } finally {
      setVerificando(null);
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
      {mensaje && <div className="aviso aviso--ok">{mensaje}</div>}
      {verificando && (
        <div className="aviso" role="status">
          <strong>Verificando tu acceso a {verificando.cuit} contra ARCA…</strong>
          <span>Puede tardar un par de minutos. No cierres la página.</span>
        </div>
      )}

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
          onCrear={(datos) => accionRelanzando(() => crearCliente(datos))}
          onPedirAcceso={pedirAcceso}
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
  onPedirAcceso,
  sinCupo,
  limite,
}: {
  onCrear: (datos: { cuit: string; razonSocial: string }) => Promise<void>;
  onPedirAcceso: (datos: {
    cuit: string;
    usuarioCuit: string;
    clave: string;
  }) => Promise<void>;
  sinCupo: boolean;
  limite: number | null;
}) {
  const [cuit, setCuit] = useState('');
  const [razonSocial, setRazonSocial] = useState('');
  const [abierto, setAbierto] = useState(false);
  // Cuando el CUIT ya está cargado por otra cuenta, el alta no es el camino:
  // el formulario pasa a pedir acceso con la clave fiscal propia.
  const [yaCargado, setYaCargado] = useState<string | null>(null);
  const [usuarioCuit, setUsuarioCuit] = useState('');
  const [clave, setClave] = useState('');
  const [enviando, setEnviando] = useState(false);

  // Se valida mientras escribe, pero el error solo aparece con 11 digitos:
  // marcar en rojo un CUIT a medio tipear es ruido.
  const problemaCuit = cuit.replace(/\D/g, '').length === 11 ? validarCuit(cuit) : null;
  const problemaUsuarioCuit =
    usuarioCuit.replace(/\D/g, '').length === 11 ? validarCuit(usuarioCuit) : null;

  function cerrar() {
    setCuit('');
    setRazonSocial('');
    setUsuarioCuit('');
    setClave('');
    setYaCargado(null);
    setAbierto(false);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problemaCuit || enviando) return;
    setEnviando(true);
    try {
      await onCrear({ cuit, razonSocial });
      cerrar();
    } catch (error) {
      // El único error que no cierra el formulario: hay una salida y es acá.
      if (error instanceof ErrorApi && error.codigo === 'CUIT_YA_CARGADO') {
        setYaCargado(error.message);
        return;
      }
      throw error;
    } finally {
      setEnviando(false);
    }
  }

  async function onSubmitAcceso(e: FormEvent) {
    e.preventDefault();
    if (problemaCuit || problemaUsuarioCuit || enviando) return;
    setEnviando(true);
    try {
      await onPedirAcceso({ cuit, usuarioCuit, clave });
      cerrar();
    } finally {
      // La clave no queda en memoria del componente ni siquiera si falla.
      setClave('');
      setEnviando(false);
    }
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

  if (yaCargado) {
    return (
      <form className="seccion" onSubmit={onSubmitAcceso}>
        <h2 className="seccion__titulo">Pedir acceso a {cuit}</h2>
        <div className="aviso">
          <strong>{yaCargado}</strong>
          <span>
            Para compartirla, ARCA tiene que confirmar que tu clave fiscal puede actuar por ese
            CUIT. Se prueba una sola vez y no se guarda: la empresa conserva la clave que ya tenía
            cargada.
          </span>
        </div>
        <div className="fila-campos">
          <label className="campo">
            <span className="campo__etiqueta">Tu usuario ARCA (CUIT)</span>
            <input
              value={usuarioCuit}
              onChange={(e) => setUsuarioCuit(e.target.value)}
              placeholder="20-12345678-9"
              required
            />
            <span className="campo__ayuda">Con el que iniciás sesión, que puede no ser el de la empresa.</span>
            {problemaUsuarioCuit && <span className="campo__error">{problemaUsuarioCuit}</span>}
          </label>
          <label className="campo campo--ancho">
            <span className="campo__etiqueta">Clave fiscal</span>
            <input
              type="password"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
              required
            />
          </label>
        </div>
        <div className="acciones">
          <button
            className="btn btn--primario"
            type="submit"
            disabled={enviando || Boolean(problemaUsuarioCuit)}
          >
            {enviando ? 'Verificando…' : 'Pedir acceso'}
          </button>
          <button className="btn" type="button" onClick={cerrar}>
            Cancelar
          </button>
        </div>
      </form>
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
        <button
          className="btn btn--primario"
          type="submit"
          disabled={enviando || Boolean(problemaCuit)}
        >
          {enviando ? 'Creando…' : 'Crear'}
        </button>
        <button className="btn" type="button" onClick={cerrar}>
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

      {!bloqueadoPorCupo && <EmpresasDeLaCuenta cliente={cliente} />}
    </div>
  );
}

/**
 * Las empresas que esta cuenta representa, con su razón social editable.
 *
 * Es el único lugar donde se pueden nombrar TODAS. Los grupos por CUIT del
 * detalle también dejan hacerlo, pero sólo existen para las empresas que
 * tienen datos en ese módulo: una que ARCA ofrece y todavía no tiene
 * movimientos no aparece en ninguno, y quedaba sin forma de dejar de verse
 * como un número suelto en el panel.
 *
 * Se pide al abrir el panel y no con la lista de clientes: son N pedidos que
 * casi nunca se miran, y el listado de clientes tiene que cargar rápido.
 */
function EmpresasDeLaCuenta({ cliente }: { cliente: Cliente }) {
  const [empresas, setEmpresas] = useState<EmpresaRepresentada[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    listarEmpresasDeCliente(cliente.id)
      .then((e) => {
        if (vigente) setEmpresas(e);
      })
      .catch((e: unknown) => {
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudieron cargar las empresas.');
      });
    return () => {
      vigente = false;
    };
  }, [cliente.id]);

  /**
   * Refleja el nombre nuevo sin volver a pedir la lista.
   *
   * El CUIT se compara en dígitos: la lista lo trae con guiones y la respuesta
   * devuelve el que se mandó, y hacer que esto dependa de que coincidan de
   * formato es justo el error que ya rompió el filtro por empresa una vez.
   */
  async function ponerNombre(cuit: string, nombre: string) {
    const guardado = await guardarNombreContribuyente(cuit, nombre);
    const digitos = guardado.cuit.replace(/\D/g, '');
    setEmpresas((actuales) =>
      (actuales ?? []).map((empresa) =>
        empresa.cuit.replace(/\D/g, '') === digitos
          ? { ...empresa, nombre: guardado.nombre, nombreCargado: true }
          : empresa,
      ),
    );
  }

  return (
    <div className="gestion__bloque gestion__bloque--clientes">
      <h3>3. Empresas representadas</h3>
      <p className="tenue">
        Las que ARCA ofrece bajo esta clave fiscal. El nombre es del CUIT, no de la cuenta: cargarlo
        acá lo muestra en todo el panel.
      </p>

      {error && <p className="campo__error">{error}</p>}
      {!error && empresas === null && <p className="tenue">Cargando empresas…</p>}
      {!error && empresas?.length === 0 && (
        <p className="tenue">
          Todavía no hay ninguna. Aparecen después de la primera sincronización, con lo que ARCA
          ofrezca en cada servicio.
        </p>
      )}

      {empresas && empresas.length > 0 && (
        <ul className="empresas-cuenta">
          {empresas.map((empresa) => (
            <li className="empresas-cuenta__fila" key={empresa.cuit}>
              <div className="empresas-cuenta__cuit">
                <span className="mono">{empresa.cuit}</span>
                {empresa.esTitular && <Badge tono="neutro">Titular</Badge>}
              </div>
              <NombreContribuyente
                cuit={empresa.cuit}
                // `undefined` y no el CUIT de relleno: es lo que hace que el
                // botón ofrezca "Poner nombre" en vez de "Editar nombre" y que
                // el input arranque vacío en lugar de con el número adentro.
                nombre={empresa.nombreCargado ? empresa.nombre : undefined}
                alGuardar={ponerNombre}
              />
              <span className="tenue empresas-cuenta__visto">
                {empresa.vistoEn ? `Visto en ${empresa.vistoEn}` : 'Sin registro de servicios'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
