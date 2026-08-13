import type { MouseEvent } from 'react';
import { Link, useLocation, useNavigate, type LinkProps } from 'react-router-dom';

const TIEMPOS_TRANSICION = {
  iris: {
    duracionEntrada: 560,
    navegacionTrasCobertura: 0,
    salidaTrasCobertura: 100,
    duracionSalida: 520,
  },
  wipe: {
    duracionEntrada: 480,
    navegacionTrasCobertura: 170,
    salidaTrasCobertura: 380,
    duracionSalida: 460,
  },
} as const;

function alTerminarAnimacion(
  elemento: HTMLElement,
  tiempoMaximo: number,
  continuar: () => void,
) {
  let termino = false;
  const finalizar = () => {
    if (termino) return;
    termino = true;
    continuar();
  };

  elemento.addEventListener('animationend', finalizar, { once: true });
  // Respaldo para pestañas inactivas o navegadores que omitan animationend.
  window.setTimeout(finalizar, tiempoMaximo);
}

type DireccionWipe = 'izquierda' | 'derecha';
type EnlaceTransicionProps = LinkProps & {
  variante: 'iris' | 'wipe';
  direccion?: DireccionWipe;
};

/**
 * Enlace interno con la cortina iris de Fisterra.
 *
 * Conserva el comportamiento nativo para Ctrl/Cmd+click, click central,
 * targets externos y usuarios que prefieren movimiento reducido.
 */
function EnlaceTransicion({
  to,
  onClick,
  variante,
  direccion = 'derecha',
  ...props
}: EnlaceTransicionProps) {
  const navigate = useNavigate();
  const location = useLocation();

  function navegarConTransicion(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;

    const esNavegacionNormal =
      event.button <= 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (!event.currentTarget.target || event.currentTarget.target === '_self');
    const reducirMovimiento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mismoDestino = typeof to === 'string' && to === location.pathname;

    if (!esNavegacionNormal || reducirMovimiento || mismoDestino) return;

    event.preventDefault();

    // Evita dos navegaciones si se hace doble click durante la cortina.
    if (document.querySelector('.transicion-cortina')) return;

    if (variante === 'iris') {
      const rect = event.currentTarget.getBoundingClientRect();
      const esClickDeTeclado = event.detail === 0;
      const x = esClickDeTeclado ? rect.left + rect.width / 2 : event.clientX;
      const y = esClickDeTeclado ? rect.top + rect.height / 2 : event.clientY;
      const radioHastaEsquina = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );
      // El excedente deja el borde del circulo fuera del viewport antes de
      // cambiar de pantalla y evita saltos por redondeo/subpixeles.
      const diagonalViewport = Math.hypot(window.innerWidth, window.innerHeight);
      const radioBorde = Math.ceil(radioHastaEsquina + 2);
      // Termina ampliamente fuera de pantalla, sin depender de donde se hizo click.
      const radio = Math.ceil(diagonalViewport * 1.5);

      const raiz = document.documentElement.style;
      raiz.setProperty('--iris-x', `${x}px`);
      raiz.setProperty('--iris-y', `${y}px`);
      raiz.setProperty('--iris-radio-borde', `${radioBorde}px`);
      raiz.setProperty('--iris-radio', `${radio}px`);
    }

    const tipoCortina =
      variante === 'iris' ? 'iris-cortina' : `wipe-cortina wipe-cortina--${direccion}`;
    const faseCortina = variante === 'iris' ? 'iris-cortina' : 'wipe-cortina';

    const cortina = document.createElement('div');
    cortina.className = `transicion-cortina ${tipoCortina} ${faseCortina}--entrando`;
    cortina.setAttribute('aria-hidden', 'true');

    if (variante === 'wipe') {
      const firma = document.createElement('div');
      firma.className = 'transicion-cortina__firma';

      const isotipo = document.createElement('img');
      isotipo.src = '/brand/fisterra-isotipo.svg';
      isotipo.alt = '';

      const firmaTexto = document.createElement('span');
      firmaTexto.textContent = 'Powered by Fisterra';

      firma.append(isotipo, firmaTexto);
      cortina.append(firma);
    }
    document.body.append(cortina);

    const tiempos = TIEMPOS_TRANSICION[variante];
    alTerminarAnimacion(cortina, tiempos.duracionEntrada + 160, () => {
      // La firma pertenece solo al wipe y aparece con el viewport ya cubierto.
      if (variante === 'wipe') cortina.classList.add('transicion-cortina--firma-visible');

      window.setTimeout(() => navigate(to), tiempos.navegacionTrasCobertura);
      window.setTimeout(() => {
        cortina.className = `transicion-cortina ${tipoCortina} ${faseCortina}--saliendo`;
        alTerminarAnimacion(cortina, tiempos.duracionSalida + 160, () => cortina.remove());
      }, tiempos.salidaTrasCobertura);
    });
  }

  return <Link {...props} to={to} onClick={navegarConTransicion} />;
}

export function IrisLink(props: LinkProps) {
  return <EnlaceTransicion {...props} variante="iris" />;
}

export function WipeLink({ direccion, ...props }: LinkProps & { direccion: DireccionWipe }) {
  return <EnlaceTransicion {...props} variante="wipe" direccion={direccion} />;
}
