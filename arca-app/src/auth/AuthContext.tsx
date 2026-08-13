import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  borrarToken,
  iniciarSesion,
  obtenerSesionActual,
  onSesionExpirada,
} from '../api/client';
import type { Usuario } from '../types';

const CLAVE_USUARIO = 'arcapanel.usuario';

interface AuthCtx {
  usuario: Usuario | null;
  esAdmin: boolean;
  entrar: (email: string, password: string) => Promise<void>;
  salir: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

function leerUsuario(): Usuario | null {
  try {
    const crudo = localStorage.getItem(CLAVE_USUARIO);
    return crudo ? (JSON.parse(crudo) as Usuario) : null;
  } catch {
    // Storage corrupto o deshabilitado: se arranca deslogueado, no se rompe.
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(leerUsuario);

  const salir = useCallback(() => {
    borrarToken();
    localStorage.removeItem(CLAVE_USUARIO);
    setUsuario(null);
  }, []);

  // Si la API contesta 401 en cualquier pedido, la sesión murió: hay que
  // reflejarlo en la UI y no seguir mostrando pantallas como si nada.
  useEffect(() => {
    onSesionExpirada(() => {
      localStorage.removeItem(CLAVE_USUARIO);
      setUsuario(null);
    });
  }, []);

  // Refresca cupo, nombre y rol desde la base. También hace que una cuenta
  // pausada salga de la aplicación aunque tuviera un JWT todavía vigente.
  useEffect(() => {
    if (!usuario) return;
    void obtenerSesionActual()
      .then((actual) => {
        localStorage.setItem(CLAVE_USUARIO, JSON.stringify(actual));
        setUsuario(actual);
      })
      .catch(() => undefined);
    // Sólo al recuperar una sesión guardada; no se repite con cada setUsuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entrar = useCallback(async (email: string, password: string) => {
    const u = await iniciarSesion(email, password);
    // Sólo el perfil, nunca la password. El `rol` guardado acá es para pintar
    // la UI: quien autoriza de verdad es la API, que lo lee del JWT firmado.
    localStorage.setItem(CLAVE_USUARIO, JSON.stringify(u));
    setUsuario(u);
  }, []);

  const valor = useMemo<AuthCtx>(
    () => ({ usuario, esAdmin: usuario?.rol === 'admin', entrar, salir }),
    [usuario, entrar, salir],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}
