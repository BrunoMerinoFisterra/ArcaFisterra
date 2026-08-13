import { Fragment, useEffect, useState, type FormEvent } from 'react';
import {
  actualizarUsuario,
  crearUsuario,
  listarUsuarios,
  quitarClienteDeUsuario,
} from '../api/client';
import { Badge } from '../components/Badge';
import type { UsuarioGestion } from '../types';

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState<UsuarioGestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);

  const recargar = () => listarUsuarios().then(setUsuarios);
  useEffect(() => {
    void recargar().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los usuarios.');
    });
  }, []);

  async function ejecutar(fn: () => Promise<unknown>, confirmacion: string) {
    setError(null);
    setMensaje(null);
    try {
      await fn();
      await recargar();
      setMensaje(confirmacion);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo actualizar la cuenta.');
    }
  }

  if (!usuarios && error) return <div className="aviso aviso--error">{error}</div>;
  if (!usuarios) return <p className="vacio">Cargando usuarios…</p>;

  return (
    <>
      <header className="encabezado-pagina">
        <h1 className="titulo-pareado">
          <strong>GESTIÓN</strong>
          <span>de cuentas</span>
        </h1>
        <p>Altas, cupos de clientes y estado de acceso de cada usuario.</p>
      </header>

      {error && <div className="aviso aviso--error">{error}</div>}
      {mensaje && <div className="aviso aviso--ok">{mensaje}</div>}

      <AltaUsuario
        alCrear={(datos) =>
          ejecutar(() => crearUsuario(datos), `Cuenta de ${datos.nombre} creada correctamente.`)
        }
      />

      <section className="seccion">
        <h2 className="seccion__titulo">{usuarios.length} cuentas</h2>
        <div className="tabla-scroll">
          <table className="tabla tabla--usuarios">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Clientes</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {usuarios.map((usuario) => (
                <Fragment key={usuario.id}>
                  <tr className={!usuario.activo ? 'fila--pausada' : undefined}>
                    <td>
                      <div className="fuerte">{usuario.nombre}</div>
                      <div className="tenue">{usuario.email}</div>
                    </td>
                    <td>
                      <Badge tono={usuario.rol === 'admin' ? 'neutro' : 'ok'}>
                        {usuario.rol === 'admin' ? 'Administrador' : 'Usuario'}
                      </Badge>
                    </td>
                    <td>
                      <span className="mono fuerte">{usuario.clientesAsignados}</span>
                      <span className="tenue">
                        {' '}de {usuario.limiteClientes === null ? '∞' : usuario.limiteClientes}
                      </span>
                    </td>
                    <td>
                      <Badge tono={usuario.activo ? 'ok' : 'alerta'}>
                        {usuario.activo ? 'Activa' : 'Pausada'}
                      </Badge>
                    </td>
                    <td className="der">
                      {usuario.rol === 'user' ? (
                        <button
                          type="button"
                          className="btn btn--chico"
                          onClick={() => setExpandido(expandido === usuario.id ? null : usuario.id)}
                        >
                          {expandido === usuario.id ? 'Cerrar' : 'Gestionar'}
                        </button>
                      ) : (
                        <span className="tenue">Cuenta protegida</span>
                      )}
                    </td>
                  </tr>
                  {expandido === usuario.id && usuario.rol === 'user' && (
                    <tr>
                      <td colSpan={5} className="panel-gestion">
                        <PanelUsuario
                          usuario={usuario}
                          alGuardar={(cambios) =>
                            ejecutar(
                              () => actualizarUsuario(usuario.id, cambios),
                              `Cuenta de ${usuario.nombre} actualizada.`,
                            )
                          }
                          alQuitarCliente={(cliente) =>
                            ejecutar(
                              () => quitarClienteDeUsuario(usuario.id, cliente.id),
                              `${cliente.razonSocial} fue quitada de la cuenta de ${usuario.nombre}.`,
                            )
                          }
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AltaUsuario({
  alCrear,
}: {
  alCrear: (datos: {
    nombre: string;
    email: string;
    password: string;
    limiteClientes: number;
  }) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [limite, setLimite] = useState(5);

  function enviar(evento: FormEvent) {
    evento.preventDefault();
    alCrear({ nombre, email, password, limiteClientes: limite });
    setNombre('');
    setEmail('');
    setPassword('');
    setLimite(5);
    setAbierto(false);
  }

  if (!abierto) {
    return (
      <button type="button" className="btn btn--primario btn--bloque" onClick={() => setAbierto(true)}>
        + Crear usuario
      </button>
    );
  }

  return (
    <form className="seccion" onSubmit={enviar}>
      <h2 className="seccion__titulo">Nueva cuenta</h2>
      <div className="fila-campos usuarios__alta">
        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Nombre</span>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required />
        </label>
        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Contraseña inicial</span>
          <input
            type="password"
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="campo usuarios__limite">
          <span className="campo__etiqueta">Límite de clientes</span>
          <input
            type="number"
            min={0}
            max={10_000}
            value={limite}
            onChange={(e) => setLimite(Number(e.target.value))}
            required
          />
        </label>
      </div>
      <div className="acciones">
        <button className="btn btn--primario" type="submit">Crear cuenta</button>
        <button className="btn" type="button" onClick={() => setAbierto(false)}>Cancelar</button>
      </div>
    </form>
  );
}

function PanelUsuario({
  usuario,
  alGuardar,
  alQuitarCliente,
}: {
  usuario: UsuarioGestion;
  alGuardar: (cambios: {
    nombre?: string;
    password?: string;
    limiteClientes?: number;
    activo?: boolean;
  }) => void;
  alQuitarCliente: (cliente: UsuarioGestion['clientes'][number]) => void;
}) {
  const [nombre, setNombre] = useState(usuario.nombre);
  const [limite, setLimite] = useState(usuario.limiteClientes ?? 0);
  const [password, setPassword] = useState('');
  const [clienteAConfirmar, setClienteAConfirmar] = useState<string | null>(null);

  return (
    <div className="gestion gestion--usuario">
      <div className="gestion__bloque">
        <h3>Datos y cupo</h3>
        <div className="fila-campos">
          <label className="campo campo--ancho">
            <span className="campo__etiqueta">Nombre</span>
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </label>
          <label className="campo usuarios__limite">
            <span className="campo__etiqueta">Límite de clientes</span>
            <input
              type="number"
              min={0}
              max={10_000}
              value={limite}
              onChange={(e) => setLimite(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn btn--primario"
            onClick={() => alGuardar({ nombre, limiteClientes: limite })}
          >
            Guardar cambios
          </button>
        </div>
        {limite < usuario.clientesAsignados && (
          <p className="aviso aviso--bloqueo">
            La cuenta conservará sus {usuario.clientesAsignados} clientes, pero se bloqueará su
            acceso fiscal. Sólo podrá consultar Clientes hasta que un administrador quite las
            asignaciones necesarias.
          </p>
        )}
      </div>

      <div className="gestion__bloque gestion__bloque--clientes">
        <h3>Empresas asignadas ({usuario.clientes.length})</h3>
        <p className="tenue">
          Sólo un administrador puede quitar empresas. Esto evita que la cuenta reutilice el cupo
          rotando clientes.
        </p>
        {usuario.clientes.length === 0 ? (
          <p className="vacio">No tiene empresas asignadas.</p>
        ) : (
          <div className="tabla-scroll">
            <table className="tabla tabla--compacta usuarios-clientes">
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>CUIT</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {usuario.clientes.map((cliente) => (
                  <tr key={cliente.id}>
                    <td className="fuerte">{cliente.razonSocial}</td>
                    <td className="mono">{cliente.cuit}</td>
                    <td className="der">
                      {clienteAConfirmar === cliente.id ? (
                        <div className="acciones acciones--compactas">
                          <button
                            type="button"
                            className="btn btn--peligro btn--chico"
                            onClick={() => {
                              alQuitarCliente(cliente);
                              setClienteAConfirmar(null);
                            }}
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            className="btn btn--chico"
                            onClick={() => setClienteAConfirmar(null)}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--peligro btn--chico"
                          onClick={() => setClienteAConfirmar(cliente.id)}
                        >
                          Quitar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="gestion__bloque">
        <h3>Restablecer contraseña</h3>
        <div className="fila-campos">
          <label className="campo campo--ancho">
            <span className="campo__etiqueta">Nueva contraseña</span>
            <input
              type="password"
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={password.length < 6}
            onClick={() => {
              alGuardar({ password });
              setPassword('');
            }}
          >
            Cambiar contraseña
          </button>
        </div>
      </div>

      <div className={`gestion__bloque${usuario.activo ? ' gestion__bloque--peligro' : ''}`}>
        <h3>{usuario.activo ? 'Pausar cuenta' : 'Reactivar cuenta'}</h3>
        <p className="tenue">
          {usuario.activo
            ? 'Cierra el acceso en la próxima petición y bloquea nuevos inicios de sesión. No elimina clientes ni información.'
            : 'Devuelve el acceso a la cuenta con sus clientes y configuración intactos.'}
        </p>
        <button
          type="button"
          className={usuario.activo ? 'btn btn--peligro' : 'btn btn--primario'}
          onClick={() => alGuardar({ activo: !usuario.activo })}
        >
          {usuario.activo ? 'Pausar cuenta' : 'Reactivar cuenta'}
        </button>
      </div>
    </div>
  );
}
