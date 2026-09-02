/**
 * Taxonomia de fallas del portal ARCA.
 *
 * Este es el entregable central de la Fase 0: cada modo de falla necesita un
 * codigo propio porque la reaccion correcta es distinta en cada caso. Meterlos
 * todos en un Error generico es lo que hace que un scraper reintente contra una
 * clave incorrecta y termine bloqueando la cuenta del cliente.
 */

export type ArcaErrorCode =
  | 'CLAVE_INCORRECTA'
  | 'CLAVE_BLOQUEADA'
  | 'CLAVE_VENCIDA'
  | 'CAPTCHA_PRESENTE'
  | 'SEGUNDO_FACTOR'
  | 'SERVICIO_NO_ADHERIDO'
  | 'REPRESENTADO_NO_DISPONIBLE'
  | 'PORTAL_NO_DISPONIBLE'
  | 'TIMEOUT'
  | 'SELECTOR_NO_ENCONTRADO'
  | 'DESCONOCIDO';

/** Que debe hacer el worker cuando ve este error. */
export type Reaccion =
  /** Frenar y marcar la credencial. Reintentar bloquea la cuenta del cliente. */
  | 'FRENAR_MARCAR_CREDENCIAL'
  /** Pausar el job y pedir intervencion humana. Nunca automatizar el bypass. */
  | 'NECESITA_HUMANO'
  /** Falla transitoria: backoff exponencial y reintento. */
  | 'REINTENTAR'
  /** El portal cambio. Reintentar no ayuda, hay que arreglar los selectores. */
  | 'REVISAR_SELECTORES';

interface Definicion {
  reaccion: Reaccion;
  /** Mensaje para mostrar en la UI del tablero, dirigido al contador. */
  mensaje: string;
}

export const ARCA_ERRORES: Record<ArcaErrorCode, Definicion> = {
  CLAVE_INCORRECTA: {
    reaccion: 'FRENAR_MARCAR_CREDENCIAL',
    mensaje: 'La clave fiscal guardada es incorrecta. Actualizala antes de volver a sincronizar.',
  },
  CLAVE_BLOQUEADA: {
    reaccion: 'FRENAR_MARCAR_CREDENCIAL',
    mensaje: 'ARCA bloqueo la clave fiscal. El contribuyente tiene que desbloquearla en el portal.',
  },
  CLAVE_VENCIDA: {
    reaccion: 'NECESITA_HUMANO',
    mensaje: 'ARCA exige cambiar la clave fiscal. Cambiala en el portal y actualizala aca.',
  },
  CAPTCHA_PRESENTE: {
    reaccion: 'NECESITA_HUMANO',
    mensaje: 'ARCA pidio un CAPTCHA. Hay que ingresar manualmente esta vez.',
  },
  SEGUNDO_FACTOR: {
    reaccion: 'NECESITA_HUMANO',
    mensaje: 'La cuenta tiene segundo factor activo. La sincronizacion automatica no puede continuar.',
  },
  SERVICIO_NO_ADHERIDO: {
    reaccion: 'NECESITA_HUMANO',
    mensaje: 'El servicio no esta adherido a esta clave fiscal. Adherilo desde Administrador de Relaciones.',
  },
  REPRESENTADO_NO_DISPONIBLE: {
    reaccion: 'NECESITA_HUMANO',
    mensaje:
      'El usuario ARCA no tiene disponible al CUIT del cliente en el servicio solicitado. Revisá la representación fiscal.',
  },
  PORTAL_NO_DISPONIBLE: {
    reaccion: 'REINTENTAR',
    mensaje: 'El portal de ARCA no responde. Se reintenta automaticamente.',
  },
  TIMEOUT: {
    reaccion: 'REINTENTAR',
    mensaje: 'El portal de ARCA tardo demasiado. Se reintenta automaticamente.',
  },
  SELECTOR_NO_ENCONTRADO: {
    reaccion: 'REVISAR_SELECTORES',
    mensaje: 'El portal de ARCA cambio y la sincronizacion necesita ajuste. Revisar.',
  },
  DESCONOCIDO: {
    reaccion: 'REVISAR_SELECTORES',
    mensaje: 'Error no identificado al sincronizar con ARCA. Revisar los artifacts del job.',
  },
};

export class ArcaError extends Error {
  readonly code: ArcaErrorCode;
  readonly reaccion: Reaccion;
  readonly mensajeUsuario: string;
  /** Texto crudo que vio el scraper. Sirve para afinar la deteccion despues. */
  readonly detalle?: string;

  constructor(code: ArcaErrorCode, detalle?: string) {
    const def = ARCA_ERRORES[code];
    super(`[${code}] ${def.mensaje}${detalle ? ` — ${detalle}` : ''}`);
    this.name = 'ArcaError';
    this.code = code;
    this.reaccion = def.reaccion;
    this.mensajeUsuario = def.mensaje;
    this.detalle = detalle;
  }
}

/**
 * Frases observadas en el portal, mapeadas a su codigo.
 *
 * Se comparan en minusculas y sin acentos (ver normalizar) porque ARCA no es
 * consistente con la tildacion entre pantallas. Ampliar esta tabla a medida que
 * el spike encuentre variantes nuevas: es la parte que mas se va a mover.
 */
const FRASES: ReadonlyArray<readonly [string, ArcaErrorCode]> = [
  ['clave o usuario incorrecto', 'CLAVE_INCORRECTA'],
  ['usuario o clave incorrecto', 'CLAVE_INCORRECTA'],
  ['la clave ingresada es incorrecta', 'CLAVE_INCORRECTA'],
  ['datos de acceso incorrectos', 'CLAVE_INCORRECTA'],
  ['numero de cuit incorrecto', 'CLAVE_INCORRECTA'],
  // El cartel real del login rotula el campo "CUIL/CUIT", asi que la frase de
  // arriba NO matchea: el `cuil/` queda en el medio. Sin esta entrada el error
  // cae en DESCONOCIDO, la credencial sigue figurando OK y el panel deja
  // reintentar un login que ya sabemos que no va a entrar.
  ['numero de cuil/cuit incorrecto', 'CLAVE_INCORRECTA'],

  ['se encuentra bloqueada', 'CLAVE_BLOQUEADA'],
  ['clave bloqueada', 'CLAVE_BLOQUEADA'],
  ['supero la cantidad de intentos', 'CLAVE_BLOQUEADA'],

  ['debe cambiar su clave', 'CLAVE_VENCIDA'],
  ['su clave ha expirado', 'CLAVE_VENCIDA'],
  ['clave vencida', 'CLAVE_VENCIDA'],
  ['blanqueo de clave', 'CLAVE_VENCIDA'],

  ['codigo de seguridad', 'SEGUNDO_FACTOR'],
  ['segundo factor', 'SEGUNDO_FACTOR'],
  ['token de seguridad', 'SEGUNDO_FACTOR'],

  // Cuidado con las frases genericas aca: "administrador de relaciones" NO
  // sirve como marcador, porque es el nombre de un servicio que el portal
  // linkea en su home. Usarla daba falso positivo en TODO login exitoso.
  ['no se encuentra habilitado', 'SERVICIO_NO_ADHERIDO'],
  ['no posee el servicio', 'SERVICIO_NO_ADHERIDO'],
  ['no tiene habilitado el servicio', 'SERVICIO_NO_ADHERIDO'],
  ['debe habilitar el servicio', 'SERVICIO_NO_ADHERIDO'],

  ['servicio no disponible', 'PORTAL_NO_DISPONIBLE'],
  ['en este momento no podemos', 'PORTAL_NO_DISPONIBLE'],
  ['fuera de servicio', 'PORTAL_NO_DISPONIBLE'],
  ['tareas de mantenimiento', 'PORTAL_NO_DISPONIBLE'],
];

/**
 * ¿Esta falla corta toda la sincronizacion, o es sólo de ese modulo?
 *
 * Corta lo que invalida la sesion o la credencial. Seguir con una clave
 * incorrecta es la via rapida a que ARCA bloquee la cuenta del contribuyente,
 * y seguir con un CAPTCHA o un segundo factor delante es gastar logins al
 * pedo: los modulos que faltan van a chocar contra la misma pantalla.
 *
 * El resto —representado no disponible, servicio no adherido, selectores,
 * timeouts— habla de UN servicio y no dice nada de los siguientes. Una empresa
 * puede tener delegado Cuentas Tributarias y no Mis Facilidades: cortar ahi
 * dejaba sin sincronizar tambien a los modulos posteriores, que si andaban.
 */
export function cortaLaCorrida(error: unknown): boolean {
  if (!(error instanceof ArcaError)) return false;
  return (
    error.reaccion === 'FRENAR_MARCAR_CREDENCIAL' ||
    error.code === 'CLAVE_VENCIDA' ||
    error.code === 'CAPTCHA_PRESENTE' ||
    error.code === 'SEGUNDO_FACTOR'
  );
}

/** Minusculas y sin acentos, para comparar contra FRASES. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Busca un modo de falla conocido en el texto visible de la pagina.
 * Devuelve null si no reconoce nada — que no es lo mismo que "todo bien":
 * el llamador decide si eso significa exito o DESCONOCIDO.
 */
export function detectarError(textoPagina: string): ArcaError | null {
  const texto = normalizar(textoPagina);
  for (const [frase, code] of FRASES) {
    if (texto.includes(frase)) {
      return new ArcaError(code, `frase detectada: "${frase}"`);
    }
  }
  return null;
}
