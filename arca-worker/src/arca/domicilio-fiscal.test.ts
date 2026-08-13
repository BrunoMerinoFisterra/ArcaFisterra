import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import type { NotificacionNueva } from '../../../arca-api/src/repo/tipos.js';
import {
  aFechaIsoDfe,
  cargarDetallesDfe,
  notificacionDesdeFila,
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

function notificacion(idComunicacion: string, leida: boolean): NotificacionNueva {
  return {
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
      idComunicacion: ' 659513833 ',
      fecha: ' 06/07/2026 ',
      organismo: ' ARCA ',
      asunto: ' Sistema de Cuentas Tributarias ',
      clases: ['no-leido'],
    }),
    {
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
    idComunicacion: '657238716',
    fecha: '22/06/2026',
    organismo: 'ARCA',
    asunto: 'Sistema de Cuentas Tributarias',
  };
  assert.equal(notificacionDesdeFila({ ...base, clases: ['leido'] }).leida, true);
  assert.equal(notificacionDesdeFila({ ...base, clases: ['no-leido'] }).leida, false);
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
