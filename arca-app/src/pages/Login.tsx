import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Atajo para los usuarios que siembra `arca-api` con SEMBRAR_DEMO=1.
 *
 * Sólo en desarrollo (`import.meta.env.DEV`): en un build servido en la red del
 * estudio, esta lista publica direcciones de acceso válidas a cualquiera que
 * abra la pantalla, que es justo la mitad del trabajo de quien quiera entrar.
 */
const MOSTRAR_ATAJO_DEMO = import.meta.env.DEV;
const PASSWORD_DEMO = 'demo';
const USUARIOS = [
  { id: 'u1', email: 'bruno@fisterra.com', rol: 'admin' },
  { id: 'u2', email: 'ayudante@fisterra.com', rol: 'user' },
];

export default function Login() {
  const { entrar } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await entrar(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <form className="login__caja" onSubmit={onSubmit}>
        <div className="marca marca--login">
          <img src="/brand/fisterra-lockup-horizontal.svg" alt="Fisterra" />
          <span className="marca__producto">ARCA Panel</span>
        </div>
        <h1 className="login__titulo">
          <strong>GESTIÓN ARCA</strong>
          <span>multi-cliente</span>
        </h1>

        <label className="campo">
          <span className="campo__etiqueta">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </label>

        <label className="campo">
          <span className="campo__etiqueta">Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <div className="campo__error">{error}</div>}

        <button className="btn btn--primario" type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>

        {MOSTRAR_ATAJO_DEMO && (
          <div className="login__demo">
            <strong>Demo</strong> — contraseña <code>{PASSWORD_DEMO}</code> para cualquiera de:
            <ul>
              {USUARIOS.map((u) => (
                <li key={u.id}>
                  <button type="button" className="enlace" onClick={() => setEmail(u.email)}>
                    {u.email}
                  </button>{' '}
                  <span className="tenue">({u.rol})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </div>
  );
}
