import { useState, type FormEvent } from 'react';
import { cambiarPasswordPropia } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/Badge';

const LARGO_MINIMO = 6;

export default function MiCuenta() {
  const { usuario, esAdmin } = useAuth();
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Se chequea acá sólo para avisar antes de mandar; la API valida igual.
  const noCoincide = repetida.length > 0 && nueva !== repetida;
  const listo =
    actual.length > 0 && nueva.length >= LARGO_MINIMO && nueva === repetida && !enviando;

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setMensaje(null);
    setEnviando(true);
    try {
      await cambiarPasswordPropia(actual, nueva);
      setActual('');
      setNueva('');
      setRepetida('');
      setMensaje('Contraseña actualizada. Usala la próxima vez que entres.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar la contraseña.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <header className="encabezado-pagina">
        <h1 className="titulo-pareado">
          <strong>MI CUENTA</strong>
          <span>{usuario?.nombre}</span>
        </h1>
        <p>
          {usuario?.email} <Badge tono={esAdmin ? 'neutro' : 'ok'}>
            {esAdmin ? 'Administrador' : 'Usuario'}
          </Badge>
        </p>
      </header>

      {error && <div className="aviso aviso--error">{error}</div>}
      {mensaje && <div className="aviso aviso--ok">{mensaje}</div>}

      <form className="seccion" onSubmit={enviar}>
        <h2 className="seccion__titulo">Cambiar contraseña</h2>

        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Contraseña actual</span>
          <input
            type="password"
            autoComplete="current-password"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            required
          />
        </label>

        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Contraseña nueva</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={LARGO_MINIMO}
            value={nueva}
            onChange={(e) => setNueva(e.target.value)}
            placeholder={`Mínimo ${LARGO_MINIMO} caracteres`}
            required
          />
        </label>

        <label className="campo campo--ancho">
          <span className="campo__etiqueta">Repetir la nueva</span>
          <input
            type="password"
            autoComplete="new-password"
            value={repetida}
            onChange={(e) => setRepetida(e.target.value)}
            required
          />
        </label>

        {noCoincide && <div className="campo__error">Las dos contraseñas no coinciden.</div>}

        <div className="acciones">
          <button className="btn btn--primario" type="submit" disabled={!listo}>
            {enviando ? 'Cambiando…' : 'Cambiar contraseña'}
          </button>
        </div>

        <p className="tenue">
          Cambiar la contraseña no cierra las sesiones que ya estén abiertas en otras
          computadoras. Si sospechás que alguien entró con tu cuenta, avisale a un
          administrador para que la pause.
        </p>
      </form>
    </>
  );
}
