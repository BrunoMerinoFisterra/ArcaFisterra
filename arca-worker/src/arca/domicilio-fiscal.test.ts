import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import type { NotificacionNueva } from '../../../arca-api/src/repo/tipos.js';
import { ArcaError } from './errors.js';
import {
  aFechaIsoDfe,
  cargarDetallesDfe,
  notificacionDesdeFila,
  resolverContribuyente,
} from './domicilio-fiscal.js';

interface RespuestaFalsa {
  ok: boolean;
  status?: number;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

function paginaDfeFalsa(
  responder: (url: string) => RespuestaFalsa,
): { page: Page; solicitudes: string[] } {
  const solicitudes: string[] = [];
  const page = {
    url: () => 'https://ve.cloud.afip.gob.ar/index.html#/',
    request: {
      get: async (url: string) => {
        solicitudes.push(url);
        const respuesta = responder(url);
        return {
          ok: () => respuesta.ok,
          status: () => respuesta.status ?? (respuesta.ok ? 200 : 500),
          json: async () => respuesta.json,
          body: async () => Buffer.from(respuesta.body ?? []),
          headers: () => respuesta.headers ?? {},
        };
      },
    },
    // Los mensajes de estas pruebas son texto plano. El navegador real ejecuta
    // cuerpoComoTexto dentro del DOM para quitar HTML de forma segura.
    evaluate: async (_funcion: unknown, valor: unknown) => valor,
  } as unknown as Page;
  return { page, solicitudes };
}

const CUIT = '30-71201119-6';

function notificacion(idComunicacion: string, leida: boolean): NotificacionNueva {
  return {
    contribuyenteCuit: CUIT,
    idComunicacion,
    fecha: '2026-08-05',
    organismo: 'ARCA',
    asunto: `Comunicación ${idComunicacion}`,
    leida,
  };
}

test('convierte la fila visible del DFE sin abrir la comunicación', () => {
  assert.deepEqual(
    notificacionDesdeFila({
      destinatario: '',
      idComunicacion: ' 659513833 ',
      fecha: ' 06/07/2026 ',
      organismo: ' ARCA ',
      asunto: ' Sistema de Cuentas Tributarias ',
      clases: ['no-leido'],
    }, CUIT),
    {
      contribuyenteCuit: CUIT,
      idComunicacion: '659513833',
      fecha: '2026-07-06',
      organismo: 'ARCA',
      asunto: 'Sistema de Cuentas Tributarias',
      leida: false,
    },
  );
});

test('distingue leido de no-leido por token de clase exacto', () => {
  const base = {
    destinatario: '',
    idComunicacion: '657238716',
    fecha: '22/06/2026',
    organismo: 'ARCA',
    asunto: 'Sistema de Cuentas Tributarias',
  };
  assert.equal(notificacionDesdeFila({ ...base, clases: ['leido'] }, CUIT).leida, true);
  assert.equal(notificacionDesdeFila({ ...base, clases: ['no-leido'] }, CUIT).leida, false);
});

const REPRESENTADOS = new Map([
  ['fisterra s r l', '30712011196'],
  ['reducto patagonico srl', '30709681725'],
]);

const fila = (destinatario: string) => ({
  destinatario,
  idComunicacion: '1',
  fecha: '22/06/2026',
  organismo: 'ARCA',
  asunto: 'x',
  clases: [],
});

test('etiqueta cada fila con el CUIT del representado que dice la grilla', () => {
  assert.equal(
    resolverContribuyente(fila('REDUCTO PATAGONICO SRL'), REPRESENTADOS, '30712011196'),
    '30709681725',
  );
  // ARCA no es consistente con puntos ni acentos entre el dropdown y la grilla.
  assert.equal(
    resolverContribuyente(fila('  Fisterra  S.R.L. '), REPRESENTADOS, '30709681725'),
    '30712011196',
  );
});

test('sin columna de representado, la fila es del titular', () => {
  // Es la bandeja propia: ahi la celda no existe y todo es de la cuenta.
  assert.equal(resolverContribuyente(fila(''), new Map(), '30712011196'), '30712011196');
});

test('corta si el representado no esta entre los del selector', () => {
  // El modo de falla que esto evita es silencioso y feo: guardar la
  // comunicacion de un contribuyente bajo la empresa de otro.
  assert.throws(
    () => resolverContribuyente(fila('EMPRESA QUE NO ESTABA SA'), REPRESENTADOS, '30712011196'),
    (error: unknown) =>
      error instanceof ArcaError && error.code === 'SELECTOR_NO_ENCONTRADO',
  );
});

test('rechaza fechas que no sean las publicadas por ARCA', () => {
  assert.equal(aFechaIsoDfe('04/08/2026'), '2026-08-04');
  assert.equal(aFechaIsoDfe('-'), null);
});

test('no abre una comunicación sin leer sin el opt-in explícito', async () => {
  const pendiente = notificacion('101', false);
  const { page, solicitudes } = paginaDfeFalsa(() => {
    throw new Error('no debía consultar ARCA');
  });

  const resultado = await cargarDetallesDfe(page, '30712011196', [pendiente]);

  assert.deepEqual(resultado, {
    completados: 0,
    abiertasEnArca: 0,
    pendientesDeReintento: 0,
  });
  assert.equal(pendiente.leida, false);
  assert.equal(pendiente.detalle, undefined);
  assert.deepEqual(solicitudes, []);
});

test('con autorización abre no leídas y no redescarga detalles existentes', async () => {
  const pendiente = notificacion('101', false);
  const yaLeida = notificacion('202', true);
  const existente = notificacion('303', true);
  const { page, solicitudes } = paginaDfeFalsa((url) => {
    if (url.endsWith('/101/501')) {
      return {
        ok: true,
        body: new TextEncoder().encode('archivo'),
        headers: { 'content-type': 'application/pdf; charset=binary' },
      };
    }
    const id = /\/communications\/(\d+)\?/.exec(url)?.[1];
    return {
      ok: true,
      json: {
        comunicacion: {
          mensaje: `Cuerpo ${id}`,
          adjuntos: id === '101'
            ? [{ adjunto: { idArchivo: 501, filename: 'aviso.pdf', contentSize: 7 } }]
            : [],
        },
      },
    };
  });

  const resultado = await cargarDetallesDfe(
    page,
    '30712011196',
    [pendiente, yaLeida, existente],
    {
      detallesExistentes: new Set(['303']),
      abrirNoLeidasAutorizadas: true,
    },
  );

  assert.deepEqual(resultado, {
    completados: 2,
    abiertasEnArca: 1,
    pendientesDeReintento: 0,
  });
  assert.equal(pendiente.leida, true);
  assert.equal(pendiente.detalle?.cuerpo, 'Cuerpo 101');
  assert.equal(pendiente.detalle?.adjuntos[0]?.nombre, 'aviso.pdf');
  assert.equal(pendiente.detalle?.adjuntos[0]?.mimeType, 'application/pdf');
  assert.equal(yaLeida.detalle?.cuerpo, 'Cuerpo 202');
  assert.equal(existente.detalle, undefined);
  assert.equal(solicitudes.some((url) => url.includes('/303')), false);
});

test('si el GET de detalle falla conserva la comunicación sin leer', async () => {
  const pendiente = notificacion('404', false);
  const { page } = paginaDfeFalsa(() => ({ ok: false, status: 503 }));

  const resultado = await cargarDetallesDfe(page, '30712011196', [pendiente], {
    abrirNoLeidasAutorizadas: true,
  });

  assert.deepEqual(resultado, {
    completados: 0,
    abiertasEnArca: 0,
    pendientesDeReintento: 1,
  });
  assert.equal(pendiente.leida, false);
  assert.equal(pendiente.detalle, undefined);
});

test('si falla un adjunto conserva la apertura y reintenta el detalle completo', async () => {
  const pendiente = notificacion('505', false);
  const { page } = paginaDfeFalsa((url) => {
    if (url.includes('/505?')) {
      return {
        ok: true,
        json: {
          comunicacion: {
            mensaje: 'Cuerpo disponible',
            adjuntos: [{ adjunto: { idArchivo: 9, filename: 'fallido.pdf' } }],
          },
        },
      };
    }
    return { ok: false, status: 502 };
  });

  const resultado = await cargarDetallesDfe(page, '30712011196', [pendiente], {
    abrirNoLeidasAutorizadas: true,
  });

  assert.deepEqual(resultado, {
    completados: 0,
    abiertasEnArca: 1,
    pendientesDeReintento: 1,
  });
  assert.equal(pendiente.leida, true);
  assert.equal(pendiente.detalle, undefined);
});
