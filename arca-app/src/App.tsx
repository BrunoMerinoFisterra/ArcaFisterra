import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ClienteDetalle from './pages/ClienteDetalle';
import Clientes from './pages/Clientes';
import Login from './pages/Login';
import MiCuenta from './pages/MiCuenta';
import Usuarios from './pages/Usuarios';
import { useAuth } from './auth/AuthContext';
import { WipeLink } from './components/IrisLink';

export default function App() {
  const { usuario } = useAuth();

  return (
    <div className="app">
      {/* Los módulos de consulta habilitados ya pueden venir del portal real. */}
      <div className="banner-mock" role="status">
        Modo local — Comprobantes, Facilidades, Domicilio Fiscal y Cuentas Tributarias
        pueden venir de ARCA
      </div>

      {usuario && <Topbar />}

      <main className={usuario ? 'contenido' : undefined}>
        <Routes>
          <Route path="/login" element={usuario ? <Navigate to="/" replace /> : <Login />} />
          <Route
            path="/"
            element={
              <Protegida>
                <Dashboard />
              </Protegida>
            }
          />
          <Route
            path="/cliente/:id"
            element={
              <Protegida>
                <ClienteDetalle />
              </Protegida>
            }
          />
          <Route
            path="/clientes"
            element={
              <Protegida>
                <Clientes />
              </Protegida>
            }
          />
          <Route
            path="/usuarios"
            element={
              <Protegida soloAdmin>
                <Usuarios />
              </Protegida>
            }
          />
          <Route
            path="/mi-cuenta"
            element={
              <Protegida>
                <MiCuenta />
              </Protegida>
            }
          />
          <Route path="*" element={<p className="vacio">Esa página no existe.</p>} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * Guarda de rutas.
 *
 * Es solo presentacion: esconde lo que el usuario no deberia ver, pero no
 * autoriza nada. Cuando exista `arca-api`, cada endpoint tiene que validar el
 * rol por su cuenta — una guarda de front se saltea escribiendo la URL.
 */
function Protegida({ children, soloAdmin }: { children: React.ReactNode; soloAdmin?: boolean }) {
  const { usuario, esAdmin } = useAuth();
  const location = useLocation();

  if (!usuario) return <Navigate to="/login" replace state={{ desde: location.pathname }} />;
  if (soloAdmin && !esAdmin) {
    return <p className="vacio">No tenés permisos para ver esta sección.</p>;
  }
  return <>{children}</>;
}

function Topbar() {
  const { usuario, esAdmin, salir } = useAuth();
  const { pathname } = useLocation();
  const clase = (ruta: string) =>
    pathname === ruta ? 'nav__link nav__link--activo' : 'nav__link';

  return (
    <header className="topbar">
      <WipeLink to="/" direccion="derecha" className="marca" aria-label="Fisterra">
        <img src="/brand/fisterra-lockup-horizontal.svg" alt="Fisterra" />
      </WipeLink>
      <nav className="nav">
        <WipeLink to="/" direccion="derecha" className={clase('/')}>
          Tablero
        </WipeLink>
        <WipeLink to="/clientes" direccion="izquierda" className={clase('/clientes')}>
          Clientes
        </WipeLink>
        {esAdmin && (
          <WipeLink to="/usuarios" direccion="izquierda" className={clase('/usuarios')}>
            Usuarios
          </WipeLink>
        )}
      </nav>
      <div className="topbar__usuario">
        <WipeLink to="/mi-cuenta" direccion="izquierda" className={clase('/mi-cuenta')}>
          {usuario?.nombre}
        </WipeLink>
        {esAdmin && <span className="topbar__rol">admin</span>}
        <button className="enlace" onClick={salir}>
          Salir
        </button>
      </div>
    </header>
  );
}
