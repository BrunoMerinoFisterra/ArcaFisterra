import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Config } from '../config.js';
import { validarCuit } from '../dominio/cuit.js';
import { hashearPassword } from '../crypto/password.js';
import { crearRepositorioMemoria } from '../repo/memoria.js';
import { crearRepositorioSqlite } from '../repo/sqlite.js';
import type { Repositorio } from '../repo/tipos.js';
import { crearApp } from './app.js';

/**
 * Aislamiento multi-tenant y no-filtración de credenciales.
 *
 * Es lo que más importa testear de esta API: una fuga acá expone los datos
 * fiscales de un contribuyente a otro estudio. El plan lo pide explícitamente
 * — "probarlo, no asumirlo".
 *
 * Todo corre contra LOS DOS repositorios. Ese es el punto de tener una
 * interfaz: si el aislamiento vale en memoria pero se cae en SQL, el test lo
 * dice. Cuando exista `mssql.ts` se agrega a MOTORES y queda cubierto sin
 * escribir un test más.
 *
 * En los datos de demo, `ayudante` (u2) sólo tiene asignados c1 y c2.
 */

const config: Config = {
  puerto: 0,
  adminInicial: null,
  origenPermitido: '*',
  jwtSecret: randomBytes(48).toString('base64'),
  claveMaestra: randomBytes(32),
  repositorio: 'memoria',
  sqlitePath: ':memory:',
  sembrarDemo: true,
  produccion: false,
  // Apagada: estos tests prueban las rutas HTTP, no el planificador. Si se
  // activara, encolaría jobs por su cuenta y ensuciaría las aserciones de cola.
  syncNocturna: {
    activa: false,
    horaDesde: 2,
    horaHasta: 5,
    minimoHorasEntreIntentos: 12,
    intervaloMinutos: 15,
  },
};

type CrearRepo = () => Promise<Repositorio>;

const MOTORES: Array<[string, CrearRepo]> = [
  ['memoria', () => crearRepositorioMemoria()],
  ['sqlite', async () => crearRepositorioSqlite({ archivo: ':memory:' })],
];

async function levantar(crearRepo: CrearRepo) {
  const repo = await crearRepo();
  const server = crearApp(repo, config).listen(0);
  await new Promise((r) => server.once('listening', r));
  const dir = server.address();
  if (!dir || typeof dir === 'string') throw new Error('sin puerto');
  const base = `http://127.0.0.1:${dir.port}`;

  const loginConPassword = async (email: string, password: string) => {
    const r = await fetch(`${base}/sesion/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(r.status, 200, `login de ${email}`);
    return ((await r.json()) as { token: string }).token;
  };
  const login = (email: string) => loginConPassword(email, 'demo');

  const get = (ruta: string, token?: string) =>
    fetch(`${base}${ruta}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

  const enviar = (ruta: string, metodo: string, token: string, cuerpo?: unknown) =>
    fetch(`${base}${ruta}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${token}`,
        ...(cuerpo ? { 'content-type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });

  const cerrar = async () => {
    await new Promise((r) => server.close(r));
    (repo as { cerrar?: () => void }).cerrar?.();
  };

  return { base, repo, login, loginConPassword, get, enviar, cerrar };
}

for (const [motor, crearRepo] of MOTORES) {
  describe(`repositorio ${motor}`, () => {
    test('sin token no se accede a nada', async () => {
      const s = await levantar(crearRepo);
      try {
        assert.equal((await s.get('/clientes')).status, 401);
        assert.equal((await s.get('/clientes/c1')).status, 401);
        assert.equal((await s.get('/usuarios')).status, 401);
      } finally {
        await s.cerrar();
      }
    });

    test('un token inventado se rechaza', async () => {
      const s = await levantar(crearRepo);
      try {
        assert.equal((await s.get('/clientes', 'no.es.un.jwt')).status, 401);
      } finally {
        await s.cerrar();
      }
    });

    test('cada usuario ve sólo los clientes que tiene asignados', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const ayudante = await s.login('ayudante@fisterra.com');

        const deAdmin = (await (await s.get('/clientes', admin)).json()) as unknown[];
        const deAyudante = (await (await s.get('/clientes', ayudante)).json()) as unknown[];

        assert.equal(deAdmin.length, 6);
        assert.equal(deAyudante.length, 2);
      } finally {
        await s.cerrar();
      }
    });

    test('pegarle directo al id de un cliente ajeno da 404, no sus datos', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');

        assert.equal((await s.get('/clientes/c1', ayudante)).status, 200);

        // c3 a c6 no los tiene asignados. 404 y no 403: un 403 confirmaría
        // que el id existe.
        for (const id of ['c3', 'c4', 'c5', 'c6']) {
          const r = await s.get(`/clientes/${id}`, ayudante);
          assert.equal(r.status, 404, `cliente ajeno ${id}`);
          const cuerpo = await r.text();
          assert.ok(!cuerpo.includes('Textil'), 'no debe filtrar la razón social');
          assert.ok(!cuerpo.includes('69874521'), 'no debe filtrar el CUIT');
        }
      } finally {
        await s.cerrar();
      }
    });

    test('un usuario común gestiona pero no puede rotar sus clientes', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');
        const alta = await s.enviar('/clientes', 'POST', ayudante, {
          cuit: '30-00000000-7',
          razonSocial: 'Cliente del ayudante S.A.',
        });
        assert.equal(alta.status, 201);
        const cliente = (await alta.json()) as { id: string };

        const credencial = await s.enviar(`/clientes/${cliente.id}/credencial`, 'POST', ayudante, {
          usuarioCuit: '30-00000000-7',
          clave: 'Clave-ficticia',
        });
        assert.equal(credencial.status, 200);
        assert.equal((await s.enviar(`/clientes/${cliente.id}`, 'DELETE', ayudante)).status, 403);
        assert.equal((await s.get(`/clientes/${cliente.id}`, ayudante)).status, 200);

        // La baja se hace exclusivamente desde la gestión administrativa.
        const admin = await s.login('bruno@fisterra.com');
        assert.equal(
          (await s.enviar(`/usuarios/u2/clientes/${cliente.id}`, 'DELETE', admin)).status,
          204,
        );
        assert.equal((await s.get(`/clientes/${cliente.id}`, ayudante)).status, 404);

        // Si estaba compartido, sólo se quita de la cuenta indicada.
        assert.equal((await s.enviar('/clientes/c1', 'DELETE', ayudante)).status, 403);
        assert.equal((await s.enviar('/usuarios/u2/clientes/c1', 'DELETE', admin)).status, 204);
        assert.equal((await s.get('/clientes/c1', ayudante)).status, 404);
        assert.equal((await s.get('/clientes/c1', admin)).status, 200);
      } finally {
        await s.cerrar();
      }
    });

    test('la razón social del contribuyente se resuelve y se puede cargar a mano', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');

        const detalle = (await (await s.get('/clientes/c1', admin)).json()) as {
          cliente: { cuit: string; razonSocial: string };
          contribuyentes: Record<string, string>;
        };
        const cuitDigitos = detalle.cliente.cuit.replace(/\D/g, '');

        // Si el CUIT agrupado ya es un cliente del panel, el nombre sale solo:
        // no hay que cargar nada a mano.
        assert.equal(detalle.contribuyentes[cuitDigitos], detalle.cliente.razonSocial);

        // Y uno que no es cliente se carga a mano. 30-70987654-2 es un CUIT
        // válido de la semilla de otro cliente; alcanza para probar el alta.
        const alta = await s.enviar('/contribuyentes/27-23456789-1', 'PUT', admin, {
          nombre: 'Estudio Contable de Prueba',
        });
        assert.equal(alta.status, 200);
        assert.deepEqual(await alta.json(), {
          cuit: '27-23456789-1',
          nombre: 'Estudio Contable de Prueba',
        });

        // Un CUIT mal tipeado deja un nombre huérfano que nadie va a notar,
        // porque el grupo se sigue mostrando sin nombre. Se rechaza en el alta.
        assert.equal(
          (await s.enviar('/contribuyentes/27-23456789-9', 'PUT', admin, { nombre: 'Cualquiera' }))
            .status,
          400,
        );
        assert.equal(
          (await s.enviar('/contribuyentes/27-23456789-1', 'PUT', admin, { nombre: 'x' })).status,
          400,
        );

        assert.equal((await s.get('/contribuyentes/27-23456789-1')).status, 401);
      } finally {
        await s.cerrar();
      }
    });

    test('cada uno cambia su propia contraseña, incluidos los administradores', async () => {
      const s = await levantar(crearRepo);
      const loginCrudo = (email: string, password: string) =>
        fetch(`${s.base}/sesion/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      try {
        const ayudante = await s.login('ayudante@fisterra.com');

        // Sin la contraseña actual no se cambia: una sesión robada no alcanza
        // para dejar afuera al dueño de la cuenta.
        assert.equal(
          (
            await s.enviar('/sesion/password', 'PATCH', ayudante, {
              passwordActual: 'no-es-la-suya',
              passwordNueva: 'clave-nueva-1',
            })
          ).status,
          403,
        );
        assert.equal((await loginCrudo('ayudante@fisterra.com', 'demo')).status, 200);

        assert.equal(
          (
            await s.enviar('/sesion/password', 'PATCH', ayudante, {
              passwordActual: 'demo',
              passwordNueva: 'clave-nueva-1',
            })
          ).status,
          204,
        );

        // La nueva sirve; la vieja deja de servir.
        await s.loginConPassword('ayudante@fisterra.com', 'clave-nueva-1');
        assert.equal((await loginCrudo('ayudante@fisterra.com', 'demo')).status, 401);

        // Lo que antes era imposible: PATCH /usuarios/:id rechaza las cuentas
        // admin, así que un administrador no tenía forma de cambiar su clave.
        const admin = await s.login('bruno@fisterra.com');
        assert.equal(
          (
            await s.enviar('/sesion/password', 'PATCH', admin, {
              passwordActual: 'demo',
              passwordNueva: 'clave-nueva-admin',
            })
          ).status,
          204,
        );
        await s.loginConPassword('bruno@fisterra.com', 'clave-nueva-admin');

        // Una contraseña corta se rechaza aunque la actual sea correcta.
        const otro = await s.loginConPassword('ayudante@fisterra.com', 'clave-nueva-1');
        assert.equal(
          (
            await s.enviar('/sesion/password', 'PATCH', otro, {
              passwordActual: 'clave-nueva-1',
              passwordNueva: 'corta',
            })
          ).status,
          400,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('el admin asigna un cliente ya cargado a otra cuenta', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const ayudante = await s.login('ayudante@fisterra.com');

        // En la semilla, ayudante (u2) tiene c1 y c2, pero no c3.
        assert.equal((await s.get('/clientes/c3', ayudante)).status, 404);

        // Un usuario común no puede asignarse clientes a sí mismo.
        assert.equal((await s.enviar('/usuarios/u2/clientes/c3', 'POST', ayudante)).status, 403);

        assert.equal((await s.enviar('/usuarios/u2/clientes/c3', 'POST', admin)).status, 201);

        // Lo que importa: ahora llega a los datos fiscales, no sólo a la lista.
        assert.equal((await s.get('/clientes/c3', ayudante)).status, 200);

        // Repetirla no duplica la asignación; avisa que ya estaba.
        assert.equal((await s.enviar('/usuarios/u2/clientes/c3', 'POST', admin)).status, 409);

        assert.equal((await s.enviar('/usuarios/u2/clientes/no-existe', 'POST', admin)).status, 404);
        assert.equal((await s.enviar('/usuarios/no-existe/clientes/c3', 'POST', admin)).status, 404);

        // Compartido: quitárselo a una cuenta no se lo quita a la otra.
        assert.equal((await s.enviar('/usuarios/u2/clientes/c3', 'DELETE', admin)).status, 204);
        assert.equal((await s.get('/clientes/c3', ayudante)).status, 404);
        assert.equal((await s.get('/clientes/c3', admin)).status, 200);
      } finally {
        await s.cerrar();
      }
    });

    test('escribir un CUIT ajeno no da acceso: hay que probar la clave fiscal', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');

        // En la semilla, ayudante (u2) tiene c1 y c2, pero no c3.
        assert.equal((await s.get('/clientes/c3', ayudante)).status, 404);

        // El alta no es la via: avisa que ya esta cargada, con un codigo que
        // el front usa para ofrecer el pedido de acceso.
        const alta = await s.enviar('/clientes', 'POST', ayudante, {
          cuit: '27-28456789-2',
          razonSocial: 'La quiero igual',
        });
        assert.equal(alta.status, 409);
        assert.equal((await alta.json() as { codigo?: string }).codigo, 'CUIT_YA_CARGADO');

        const pedido = await s.enviar('/clientes/solicitudes', 'POST', ayudante, {
          cuit: '27-28456789-2',
          usuarioCuit: '20-12345678-6',
          clave: 'la-mia',
        });
        assert.equal(pedido.status, 202);

        // LO QUE IMPORTA: pedirlo no otorga nada. Sin esta linea, escribir un
        // CUIT —que es publico— alcanzaria para leer la carpeta fiscal ajena.
        assert.equal((await s.get('/clientes/c3', ayudante)).status, 404);

        const solicitudes = (await (await s.get('/clientes/solicitudes', ayudante)).json()) as
          Array<{ id: string; estado: string; cuit: string }>;
        assert.equal(solicitudes.length, 1);
        assert.equal(solicitudes[0]!.estado, 'PENDIENTE');

        // Un pedido repetido no dispara un segundo login contra ARCA.
        assert.equal(
          (
            await s.enviar('/clientes/solicitudes', 'POST', ayudante, {
              cuit: '27-28456789-2',
              usuarioCuit: '20-12345678-6',
              clave: 'la-mia',
            })
          ).status,
          409,
        );

        // Un CUIT valido pero no cargado no revela nada mas que eso.
        assert.equal(
          (
            await s.enviar('/clientes/solicitudes', 'POST', ayudante, {
              cuit: '33-69345023-9',
              usuarioCuit: '20-12345678-6',
              clave: 'la-mia',
            })
          ).status,
          404,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('el veredicto del worker otorga el acceso, y rechazarlo no daña a la empresa', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');
        const admin = await s.login('bruno@fisterra.com');
        const antes = (await (await s.get('/clientes/c3', admin)).json()) as {
          cliente: { estadoCredencial: string; estadoSync: string };
        };

        assert.equal(
          (
            await s.enviar('/clientes/solicitudes', 'POST', ayudante, {
              cuit: '27-28456789-2',
              usuarioCuit: '20-12345678-6',
              clave: 'la-que-no-va',
            })
          ).status,
          202,
        );

        // El worker toma el job y ARCA le dice que no.
        const ahora = new Date();
        const rechazado = await s.repo.tomarProximoJob(
          'worker-test',
          ahora.toISOString(),
          new Date(ahora.getTime() + 60_000).toISOString(),
        );
        assert.ok(rechazado?.solicitudId, 'el job de verificacion lleva la solicitud');
        await s.repo.finalizarJob(
          rechazado.id,
          { estado: 'ERROR', detalle: 'ARCA no la incluye.', estadoCredencial: 'INVALIDA' },
          'worker-test',
        );

        assert.equal((await s.get('/clientes/c3', ayudante)).status, 404);

        // LO QUE IMPORTA: la empresa de la otra oficina queda intacta. Si el
        // rechazo cayera en el UPDATE de cliente, una clave equivocada de un
        // tercero dejaria la credencial marcada como invalida y le cortaria
        // las sincronizaciones a quien si la tenia.
        const despues = (await (await s.get('/clientes/c3', admin)).json()) as {
          cliente: { estadoCredencial: string; estadoSync: string };
        };
        assert.equal(despues.cliente.estadoCredencial, antes.cliente.estadoCredencial);
        assert.equal(despues.cliente.estadoSync, antes.cliente.estadoSync);

        // Segundo intento, esta vez ARCA confirma.
        assert.equal(
          (
            await s.enviar('/clientes/solicitudes', 'POST', ayudante, {
              cuit: '27-28456789-2',
              usuarioCuit: '20-12345678-6',
              clave: 'la-buena',
            })
          ).status,
          202,
        );
        const luego = new Date();
        const aprobado = await s.repo.tomarProximoJob(
          'worker-test',
          luego.toISOString(),
          new Date(luego.getTime() + 60_000).toISOString(),
        );
        assert.ok(aprobado?.solicitudId);
        await s.repo.finalizarJob(aprobado.id, { estado: 'DONE' }, 'worker-test');

        assert.equal((await s.get('/clientes/c3', ayudante)).status, 200);
        // Compartida, no mudada: la oficina original la conserva.
        assert.equal((await s.get('/clientes/c3', admin)).status, 200);

        // La clave adjunta es de un solo uso y no sobrevive al veredicto.
        assert.equal(await s.repo.solicitudParaVerificar(aprobado.solicitudId!), null);
      } finally {
        await s.cerrar();
      }
    });

    test('asignar respeta el cupo, igual que el alta', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const alta = await s.enviar('/usuarios', 'POST', admin, {
          nombre: 'Cuenta Acotada',
          email: 'acotada@fisterra.com',
          password: 'secreto-demo',
          limiteClientes: 1,
        });
        assert.equal(alta.status, 201);
        const cuenta = (await alta.json()) as { id: string };

        assert.equal((await s.enviar(`/usuarios/${cuenta.id}/clientes/c1`, 'POST', admin)).status, 201);

        // El cupo ya está consumido: sin este chequeo, asignar sería la vía
        // para saltear el límite que el alta de clientes sí controla.
        assert.equal((await s.enviar(`/usuarios/${cuenta.id}/clientes/c2`, 'POST', admin)).status, 409);
      } finally {
        await s.cerrar();
      }
    });

    test('no crea un admin inicial si la base ya tiene usuarios', async () => {
      const s = await levantar(crearRepo);
      try {
        // La semilla ya trae u1 (admin) y u2. Con la base poblada las variables
        // de entorno no pueden fabricar un administrador: si pudieran, serían
        // una puerta trasera para agregarse un admin a un sistema en uso.
        assert.equal(
          await s.repo.crearAdminInicial({
            email: 'intruso@fisterra.com',
            nombre: 'Intruso',
            passwordHash: await hashearPassword('la-que-quiera'),
          }),
          null,
        );

        // Ni creó la cuenta nueva, ni tocó las que ya estaban.
        const emails = (await s.repo.listarUsuarios()).map((usuario) => usuario.email);
        assert.ok(!emails.includes('intruso@fisterra.com'));
        await s.login('bruno@fisterra.com');
      } finally {
        await s.cerrar();
      }
    });

    test('el admin crea, limita, pausa y reactiva cuentas de usuario', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const ayudante = await s.login('ayudante@fisterra.com');
        assert.equal((await s.get('/usuarios', ayudante)).status, 403);

        const altaUsuario = await s.enviar('/usuarios', 'POST', admin, {
          nombre: 'Cuenta Nueva',
          email: 'cuenta.nueva@fisterra.com',
          password: 'secreto-demo',
          limiteClientes: 1,
        });
        assert.equal(altaUsuario.status, 201);
        const cuenta = (await altaUsuario.json()) as {
          id: string;
          limiteClientes: number;
          clientesAsignados: number;
        };
        assert.equal(cuenta.limiteClientes, 1);
        assert.equal(cuenta.clientesAsignados, 0);

        const tokenCuenta = await s.loginConPassword(
          'cuenta.nueva@fisterra.com',
          'secreto-demo',
        );
        const primerCliente = await s.enviar('/clientes', 'POST', tokenCuenta, {
          cuit: '30-00000000-7',
          razonSocial: 'Primero S.A.',
        });
        assert.equal(primerCliente.status, 201);
        const primero = (await primerCliente.json()) as { id: string };
        const sinCupo = await s.enviar('/clientes', 'POST', tokenCuenta, {
          cuit: '30-00000001-5',
          razonSocial: 'Segundo S.A.',
        });
        assert.equal(sinCupo.status, 409);
        assert.match(await sinCupo.text(), /límite de 1/i);

        const ampliar = await s.enviar(`/usuarios/${cuenta.id}`, 'PATCH', admin, {
          limiteClientes: 2,
        });
        assert.equal(ampliar.status, 200);
        const segundoCliente = await s.enviar('/clientes', 'POST', tokenCuenta, {
          cuit: '30-00000001-5',
          razonSocial: 'Segundo S.A.',
        });
        assert.equal(segundoCliente.status, 201);
        const segundo = (await segundoCliente.json()) as { id: string };

        const reducir = await s.enviar(`/usuarios/${cuenta.id}`, 'PATCH', admin, {
          limiteClientes: 1,
        });
        assert.equal(reducir.status, 200);

        // Al quedar fuera de cupo, toda la información fiscal se bloquea,
        // incluso con un token que ya estaba abierto.
        const tableroBloqueado = await s.get('/clientes', tokenCuenta);
        assert.equal(tableroBloqueado.status, 409);
        assert.match(await tableroBloqueado.text(), /2 clientes activos.*cupo de 1/i);
        assert.equal((await s.get(`/clientes/${primero.id}`, tokenCuenta)).status, 409);
        assert.equal(
          (await s.enviar(`/clientes/${primero.id}/credencial`, 'POST', tokenCuenta, {
            usuarioCuit: '30-00000000-7',
            clave: 'no-debe-guardarse',
          })).status,
          409,
        );

        // La cuenta sólo conserva su lista básica: tampoco puede usar la baja
        // para rotar empresas y reutilizar el cupo.
        const administracion = await s.get('/clientes/administracion', tokenCuenta);
        assert.equal(administracion.status, 200);
        const estadoCupo = (await administracion.json()) as {
          clientes: Array<{ id: string }>;
          cantidadClientes: number;
          limiteClientes: number;
          excedido: boolean;
        };
        assert.equal(estadoCupo.cantidadClientes, 2);
        assert.equal(estadoCupo.limiteClientes, 1);
        assert.equal(estadoCupo.excedido, true);
        assert.equal(estadoCupo.clientes.length, 2);

        assert.equal((await s.enviar(`/clientes/${segundo.id}`, 'DELETE', tokenCuenta)).status, 403);
        const usuariosGestion = (await (await s.get('/usuarios', admin)).json()) as Array<{
          id: string;
          clientes: Array<{ id: string; cuit: string; razonSocial: string }>;
        }>;
        const cuentaGestion = usuariosGestion.find((usuario) => usuario.id === cuenta.id);
        assert.equal(cuentaGestion?.clientes.length, 2);
        assert.equal(cuentaGestion?.clientes.some((cliente) => cliente.id === segundo.id), true);
        assert.equal(
          (await s.enviar(`/usuarios/${cuenta.id}/clientes/${segundo.id}`, 'DELETE', admin)).status,
          204,
        );
        assert.equal((await s.get('/clientes', tokenCuenta)).status, 200);
        assert.equal((await s.get(`/clientes/${primero.id}`, tokenCuenta)).status, 200);

        assert.equal(
          (await s.enviar(`/usuarios/${cuenta.id}`, 'PATCH', admin, { activo: false })).status,
          200,
        );
        // La pausa invalida incluso el token que ya estaba abierto.
        assert.equal((await s.get('/clientes', tokenCuenta)).status, 401);

        const loginPausado = await fetch(`${s.base}/sesion/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'cuenta.nueva@fisterra.com', password: 'secreto-demo' }),
        });
        assert.equal(loginPausado.status, 401);

        assert.equal(
          (await s.enviar(`/usuarios/${cuenta.id}`, 'PATCH', admin, { activo: true })).status,
          200,
        );
        await s.loginConPassword('cuenta.nueva@fisterra.com', 'secreto-demo');
      } finally {
        await s.cerrar();
      }
    });

    test('ninguna respuesta incluye la clave fiscal ni nada cifrado', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const guardar = await s.enviar('/clientes/c1/credencial', 'POST', admin, {
          usuarioCuit: '30-71234567-1',
          clave: 'SUPER-SECRETO-12345',
        });
        assert.equal(guardar.status, 200);

        for (const ruta of ['/clientes', '/clientes/c1', '/usuarios']) {
          const cuerpo = await (await s.get(ruta, admin)).text();
          assert.ok(!cuerpo.includes('SUPER-SECRETO-12345'), `${ruta} filtra la clave`);
          assert.ok(!cuerpo.includes('ciphertext'), `${ruta} expone el ciphertext`);
          assert.ok(!cuerpo.includes('dekEnvuelta'), `${ruta} expone la DEK`);
        }
      } finally {
        await s.cerrar();
      }
    });

    test('vista y adjuntos del DFE respetan el cliente autenticado', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const ayudante = await s.login('ayudante@fisterra.com');
        const contenido = new TextEncoder().encode('contenido adjunto');
        await s.repo.guardarNotificaciones('c1', [{
          contribuyenteCuit: '30-71234567-1',
          idComunicacion: 'DFE-HTTP-1',
          fecha: '2026-08-05',
          organismo: 'ARCA',
          asunto: 'Prueba HTTP',
          leida: false,
          detalle: {
            cuerpo: 'Detalle local',
            adjuntos: [{
              idArchivo: 'archivo-1',
              nombre: 'prueba fiscal.pdf',
              mimeType: 'application/pdf',
              tamano: contenido.byteLength,
              sha256: 'sha-http',
              contenido,
            }],
          },
        }]);
        const notificacion = (await s.repo.notificacionesDe('c1')).find(
          (candidata) => candidata.idComunicacion === 'DFE-HTTP-1',
        );
        assert.ok(notificacion);

        const vista = await s.enviar(
          `/clientes/c1/notificaciones/${notificacion.id}/vista`,
          'POST',
          ayudante,
        );
        assert.equal(vista.status, 200);
        assert.equal(((await vista.json()) as { estado: string }).estado, 'VISTA');

        const descarga = await s.get(
          `/clientes/c1/notificaciones/${notificacion.id}/adjuntos/${notificacion.adjuntos[0]!.id}`,
          admin,
        );
        assert.equal(descarga.status, 200);
        assert.equal(descarga.headers.get('content-type'), 'application/pdf');
        assert.deepEqual(new Uint8Array(await descarga.arrayBuffer()), contenido);

        assert.equal(
          (
            await s.enviar(
              `/clientes/c3/notificaciones/${notificacion.id}/vista`,
              'POST',
              ayudante,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await s.get(
              `/clientes/c2/notificaciones/${notificacion.id}/adjuntos/${notificacion.adjuntos[0]!.id}`,
              admin,
            )
          ).status,
          404,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('la lectura local de notificaciones y planes es reversible y aislada', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const ayudante = await s.login('ayudante@fisterra.com');
        const notificacion = (await s.repo.notificacionesDe('c1'))[0];
        const plan = (await s.repo.planesDe('c1'))[0];
        assert.ok(notificacion);
        assert.ok(plan);
        assert.equal(notificacion.leidoAppEn, null);
        assert.equal(plan.leidoAppEn, null);

        const notificacionLeida = await s.enviar(
          `/clientes/c1/notificaciones/${notificacion.id}/lectura`,
          'PATCH',
          ayudante,
          { leido: true },
        );
        assert.equal(notificacionLeida.status, 200);
        assert.ok(((await notificacionLeida.json()) as { leidoAppEn: string }).leidoAppEn);

        const planLeido = await s.enviar(
          `/clientes/c1/planes/${plan.id}/lectura`,
          'PATCH',
          admin,
          { leido: true },
        );
        assert.equal(planLeido.status, 200);
        assert.ok(((await planLeido.json()) as { leidoAppEn: string }).leidoAppEn);

        const planNoLeido = await s.enviar(
          `/clientes/c1/planes/${plan.id}/lectura`,
          'PATCH',
          admin,
          { leido: false },
        );
        assert.equal(planNoLeido.status, 200);
        assert.equal(((await planNoLeido.json()) as { leidoAppEn: null }).leidoAppEn, null);

        assert.equal(
          (
            await s.enviar(
              `/clientes/c3/notificaciones/${notificacion.id}/lectura`,
              'PATCH',
              ayudante,
              { leido: true },
            )
          ).status,
          404,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('la credencial guardada se puede recuperar y descifrar', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        await s.enviar('/clientes/c1/credencial', 'POST', admin, {
          usuarioCuit: '30-71234567-1',
          clave: 'Cl4ve-Fiscal',
        });

        // Esto es lo que hará el worker: leer el cifrado y descifrarlo.
        const guardada = await s.repo.leerCredencialCifrada('c1');
        assert.ok(guardada, 'debería haberse guardado');
        const { descifrarAccesoArca } = await import('../crypto/envelope.js');
        assert.deepEqual(descifrarAccesoArca(config.claveMaestra, guardada, 'CUIT-LEGACY'), {
          usuarioCuit: '30712345671',
          clave: 'Cl4ve-Fiscal',
        });
      } finally {
        await s.cerrar();
      }
    });

    test('se puede cargar el acceso ARCA en el modo local', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const r = await s.enviar('/clientes/c6/credencial', 'POST', admin, {
          usuarioCuit: '20-25478963-2',
          clave: 'lo-que-sea',
        });
        assert.equal(r.status, 200);
      } finally {
        await s.cerrar();
      }
    });

    test('dar de baja un cliente se lleva su credencial', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const alta = await s.enviar('/clientes', 'POST', admin, {
          cuit: '30-00000000-7',
          razonSocial: 'Cliente descartable S.A.',
        });
        assert.equal(alta.status, 201);
        const cliente = (await alta.json()) as { id: string };
        await s.enviar(`/clientes/${cliente.id}/credencial`, 'POST', admin, {
          usuarioCuit: '30-00000000-7',
          clave: 'algo',
        });
        assert.ok(await s.repo.leerCredencialCifrada(cliente.id));

        assert.equal((await s.enviar(`/clientes/${cliente.id}`, 'DELETE', admin)).status, 204);
        assert.equal(
          await s.repo.leerCredencialCifrada(cliente.id),
          null,
          'quedó una clave huérfana',
        );
      } finally {
        await s.cerrar();
      }
    });

    test('el login rechaza password incorrecta igual que un email inexistente', async () => {
      const s = await levantar(crearRepo);
      try {
        const pedir = async (email: string, password: string) => {
          const r = await fetch(`${s.base}/sesion/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          return { status: r.status, cuerpo: await r.text() };
        };

        const malPass = await pedir('bruno@fisterra.com', 'incorrecta');
        const noExiste = await pedir('nadie@fisterra.com', 'incorrecta');

        assert.equal(malPass.status, 401);
        assert.equal(noExiste.status, 401);
        assert.equal(malPass.cuerpo, noExiste.cuerpo, 'los mensajes deben ser idénticos');
      } finally {
        await s.cerrar();
      }
    });

    test('rechaza un CUIT con dígito verificador inválido', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const r = await s.enviar('/clientes', 'POST', admin, {
          cuit: '30-71234567-0',
          razonSocial: 'CUIT Trucho S.A.',
        });
        assert.equal(r.status, 400);
      } finally {
        await s.cerrar();
      }
    });

    test('todos los CUIT sembrados pasan la validación de la propia API', async () => {
      // Los datos de demo entran directo al repositorio, sin pasar por el alta,
      // así que nada impide sembrar un CUIT con dígito verificador inválido.
      // Cuando pasó, el seed traía 11 de 12 mal: alguien copiando un CUIT de
      // demo para probar el alta recibía un rechazo que parecía un bug de la app.
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const clientes = (await (await s.get('/clientes', admin)).json()) as Array<{
          cliente: { cuit: string; razonSocial: string };
        }>;

        for (const { cliente } of clientes) {
          assert.equal(
            validarCuit(cliente.cuit),
            null,
            `${cliente.razonSocial} tiene un CUIT inválido: ${cliente.cuit}`,
          );
        }
      } finally {
        await s.cerrar();
      }
    });

    test('sincronizar el mismo período dos veces no duplica comprobantes', async () => {
      // Verificación #3 del plan. Es la garantía de todo el sync: sin esto,
      // cada corrida infla los totales y el contador ve números falsos.
      const s = await levantar(crearRepo);
      try {
        const comprobante = {
          tipo: 'RECIBIDO' as const,
          fecha: '2026-07-15',
          codigoComprobante: 1,
          tipoComprobante: 'Factura A',
          puntoVenta: 9,
          numero: 12_345,
          contraparte: 'Proveedor Testigo S.A.',
          cuitContraparte: '30-71000111-8',
          neto: 100_000,
          iva: 21_000,
          total: 121_000,
        };
        const lote = [{ ...comprobante, contribuyenteCuit: '30-71234567-1' }];

        const antes = (await s.repo.comprobantesDe('c1')).length;

        const primera = await s.repo.guardarComprobantes('c1', lote);
        assert.deepEqual(primera, { insertados: 1, repetidos: 0 });

        const segunda = await s.repo.guardarComprobantes('c1', lote);
        assert.deepEqual(segunda, { insertados: 0, repetidos: 1 }, 'la segunda corrida duplicó');

        assert.equal((await s.repo.comprobantesDe('c1')).length, antes + 1);

        // La misma numeración, pero de OTRO contribuyente de la misma clave
        // fiscal, es un comprobante distinto. Sin el CUIT en la unicidad, este
        // se perdía pisado por el anterior y nadie se enteraba.
        const otroContribuyente = await s.repo.guardarComprobantes('c1', [
          { ...comprobante, contribuyenteCuit: '30-70987654-2' },
        ]);
        assert.deepEqual(
          otroContribuyente,
          { insertados: 1, repetidos: 0 },
          'dos contribuyentes con la misma numeración se pisaron entre sí',
        );
        assert.equal((await s.repo.comprobantesDe('c1')).length, antes + 2);
      } finally {
        await s.cerrar();
      }
    });

    test('un cliente no puede tener dos jobs activos del mismo módulo', async () => {
      const s = await levantar(crearRepo);
      try {
        const primero = await s.repo.encolarSync('c1', 'mis-comprobantes');
        const repetido = await s.repo.encolarSync('c1', 'mis-comprobantes');
        assert.equal(repetido.id, primero.id, 'debería devolver el job activo existente');

        const activos = (await s.repo.jobsDe('c1')).filter(
          (j) => j.estado === 'PENDING' || j.estado === 'RUNNING',
        );
        assert.equal(activos.length, 1);

        const ahora = new Date().toISOString();
        const tomado = await s.repo.tomarProximoJob(
          'worker-prueba',
          ahora,
          new Date(Date.now() + 60_000).toISOString(),
        );
        assert.equal(tomado?.id, primero.id);
        assert.equal(tomado?.estado, 'RUNNING');
        assert.equal((await s.repo.clienteParaSync('c1'))?.estadoSync, 'SINCRONIZANDO');

        await s.repo.finalizarJob(primero.id, { estado: 'DONE' });
        assert.equal((await s.repo.clienteParaSync('c1'))?.estadoSync, 'OK');

        const siguiente = await s.repo.encolarSync('c1', 'mis-comprobantes');
        assert.notEqual(siguiente.id, primero.id, 'después de terminar se puede encolar otro');

        await s.repo.tomarProximoJob(
          'worker-prueba',
          new Date().toISOString(),
          new Date(Date.now() + 500).toISOString(),
        );
        const recuperados = await s.repo.recuperarJobsInterrumpidos(
          new Date(Date.now() + 1_000).toISOString(),
          new Date(Date.now() - 60_000).toISOString(),
        );
        assert.equal(recuperados, 1);
        assert.equal((await s.repo.clienteParaSync('c1'))?.estadoSync, 'ERROR');

        const despuesDelCorte = await s.repo.encolarSync('c1', 'mis-comprobantes');
        assert.notEqual(despuesDelCorte.id, siguiente.id);
      } finally {
        await s.cerrar();
      }
    });

    test('la sincronización completa informa progreso y bloquea jobs superpuestos', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const respuesta = await s.enviar('/clientes/c1/sincronizar-completa', 'POST', admin);
        assert.equal(respuesta.status, 202);
        const completo = (await respuesta.json()) as {
          id: string;
          modulo: string;
          progresoActual: number;
          progresoTotal: number;
          pasoActual: string;
        };
        assert.equal(completo.modulo, 'sincronizacion-completa');
        assert.equal(completo.progresoActual, 0);
        assert.equal(completo.progresoTotal, 4);

        const individual = await s.repo.encolarSync('c1', 'mis-comprobantes');
        assert.equal(individual.id, completo.id, 'no debe superponer otra sesión del cliente');

        const tomado = await s.repo.tomarProximoJob(
          'worker-prueba',
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
        );
        assert.equal(tomado?.id, completo.id);
        await s.repo.actualizarProgresoJob(completo.id, {
          actual: 2,
          total: 4,
          paso: 'Mis Facilidades',
        });
        const ejecutando = (await s.repo.jobsDe('c1')).find((job) => job.id === completo.id);
        assert.equal(ejecutando?.progresoActual, 2);
        assert.equal(ejecutando?.pasoActual, 'Mis Facilidades');

        await s.repo.finalizarJob(completo.id, { estado: 'DONE' });
        const terminado = (await s.repo.jobsDe('c1')).find((job) => job.id === completo.id);
        assert.equal(terminado?.progresoActual, 4);
        assert.equal(terminado?.pasoActual, 'Completado');
      } finally {
        await s.cerrar();
      }
    });

    test('dos workers no pueden usar simultaneamente la misma cuenta ARCA', async () => {
      const s = await levantar(crearRepo);
      try {
        const primero = await s.repo.encolarSync('c1', 'mis-comprobantes');
        const segundo = await s.repo.encolarSync('c2', 'mis-comprobantes');
        const ahora = new Date().toISOString();
        const lease = new Date(Date.now() + 60_000).toISOString();
        assert.equal((await s.repo.tomarProximoJob('worker-1', ahora, lease))?.id, primero.id);
        assert.equal((await s.repo.tomarProximoJob('worker-2', ahora, lease))?.id, segundo.id);

        const claveAnonima = 'hmac-cuenta-compartida';
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(primero.id, 'worker-1', claveAnonima, ahora, lease),
          true,
        );
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(segundo.id, 'worker-2', claveAnonima, ahora, lease),
          false,
        );

        await s.repo.reencolarJob(segundo.id, 'worker-2', ahora, 'Esperando cuenta ARCA');
        assert.equal(
          (await s.repo.jobsDe('c2')).find((job) => job.id === segundo.id)?.estado,
          'PENDING',
        );

        await s.repo.finalizarJob(primero.id, { estado: 'DONE' }, 'worker-1');
        assert.equal((await s.repo.tomarProximoJob('worker-2', ahora, lease))?.id, segundo.id);
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(segundo.id, 'worker-2', claveAnonima, ahora, lease),
          true,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('un worker sin propiedad no puede renovar ni cerrar un job ajeno', async () => {
      const s = await levantar(crearRepo);
      try {
        const job = await s.repo.encolarSync('c1', 'mis-comprobantes');
        const ahora = new Date().toISOString();
        const lease = new Date(Date.now() + 60_000).toISOString();
        await s.repo.tomarProximoJob('worker-dueno', ahora, lease);

        assert.equal(await s.repo.renovarLeaseJob(job.id, 'worker-ajeno', lease), false);
        await assert.rejects(
          s.repo.finalizarJob(job.id, { estado: 'DONE' }, 'worker-ajeno'),
          /no se pudo cerrar|no es propietario/,
        );
        await s.repo.finalizarJob(job.id, { estado: 'DONE' }, 'worker-dueno');
      } finally {
        await s.cerrar();
      }
    });

    test('un lease vencido libera la cuenta ARCA para otro worker', async () => {
      const s = await levantar(crearRepo);
      try {
        const primero = await s.repo.encolarSync('c1', 'mis-comprobantes');
        const segundo = await s.repo.encolarSync('c2', 'mis-comprobantes');
        const base = Date.now();
        const ahora = new Date(base).toISOString();
        const leaseCorto = new Date(base + 500).toISOString();
        const leaseLargo = new Date(base + 60_000).toISOString();
        await s.repo.tomarProximoJob('worker-caido', ahora, leaseCorto);
        await s.repo.tomarProximoJob('worker-vivo', ahora, leaseLargo);
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(
            primero.id,
            'worker-caido',
            'cuenta-recuperable',
            ahora,
            leaseCorto,
          ),
          true,
        );
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(
            segundo.id,
            'worker-vivo',
            'cuenta-recuperable',
            ahora,
            leaseLargo,
          ),
          false,
        );

        const despues = new Date(base + 1_000).toISOString();
        assert.equal(
          await s.repo.recuperarJobsInterrumpidos(
            despues,
            new Date(base - 60_000).toISOString(),
          ),
          1,
        );
        assert.equal(
          await s.repo.adquirirBloqueoCuenta(
            segundo.id,
            'worker-vivo',
            'cuenta-recuperable',
            despues,
            leaseLargo,
          ),
          true,
        );
      } finally {
        await s.cerrar();
      }
    });

    test('filtrar por empresa acepta el CUIT como lo devuelve el panel', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');

        // El panel entrega el CUIT con guiones; la ruta lo normaliza a digitos.
        // Comparar los dos strings crudos no matchea nunca, y ese 404 se ve en
        // la pantalla como "No existe ese cliente" — que manda a buscar el
        // problema al lado equivocado.
        const empresas = (await (await s.get('/clientes/c1/empresas', admin)).json()) as Array<{
          cuit: string;
        }>;
        assert.ok(empresas.length > 0, 'la cuenta deberia tener al menos su titular');
        const cuit = empresas[0]!.cuit;

        const conGuiones = await s.get(`/clientes/c1?empresa=${encodeURIComponent(cuit)}`, admin);
        assert.equal(conGuiones.status, 200, 'con el CUIT tal cual lo da el panel');

        const sinGuiones = await s.get(
          `/clientes/c1?empresa=${cuit.replace(/\D/g, '')}`,
          admin,
        );
        assert.equal(sinGuiones.status, 200, 'y tambien en digitos');
      } finally {
        await s.cerrar();
      }
    });

    test('no se puede espiar una empresa que no es de esa cuenta', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        // 404 y no 403: confirmar que el CUIT existe bajo otra cuenta ya seria
        // filtrar, igual que en `clienteVisible`.
        const r = await s.get('/clientes/c1?empresa=30-70987654-2', admin);
        assert.equal(r.status, 404);
      } finally {
        await s.cerrar();
      }
    });

    test('renombrar una cuenta ajena da 404 y no la toca', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');
        const admin = await s.login('bruno@fisterra.com');

        // c3 no esta asignada al ayudante. 404 y no 403, igual que todo lo que
        // pasa por `clienteVisible`: confirmar que el id existe ya seria filtrar.
        const ajena = await s.enviar('/clientes/c3', 'PATCH', ayudante, {
          razonSocial: 'Secuestrada S.A.',
        });
        assert.equal(ajena.status, 404);

        // Y no alcanzo a escribir: el UPDATE lleva el aislamiento adentro, no
        // depende de que la ruta lo haya chequeado antes.
        const c3 = (await (await s.get('/clientes/c3', admin)).json()) as {
          cliente: { razonSocial: string };
        };
        assert.notEqual(c3.cliente.razonSocial, 'Secuestrada S.A.');

        // La propia si, y sin ser admin: renombrar no es un dato sensible ni
        // consume cupo, igual que nombrar un contribuyente.
        const propia = await s.enviar('/clientes/c1', 'PATCH', ayudante, {
          razonSocial: 'Molinos del Sur S.A.U.',
        });
        assert.equal(propia.status, 200);
        assert.equal(
          ((await propia.json()) as { razonSocial: string }).razonSocial,
          'Molinos del Sur S.A.U.',
        );

        const vacia = await s.enviar('/clientes/c1', 'PATCH', ayudante, { razonSocial: '   ' });
        assert.equal(vacia.status, 400);
      } finally {
        await s.cerrar();
      }
    });

    test('una cuenta comun no puede repartir permisos de admin', async () => {
      const s = await levantar(crearRepo);
      try {
        const ayudante = await s.login('ayudante@fisterra.com');
        // Si esto se afloja, cualquier cuenta se asciende sola y el cupo, el
        // aislamiento por usuario y el 404 de `clienteVisible` dejan de valer.
        assert.equal(
          (await s.enviar('/usuarios/u2/rol', 'PATCH', ayudante, { rol: 'admin' })).status,
          403,
        );
        assert.equal((await s.repo.listarUsuarios()).find((u) => u.id === 'u2')?.rol, 'user');
      } finally {
        await s.cerrar();
      }
    });

    test('promover deja la cuenta sin tope de clientes', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        const r = await s.enviar('/usuarios/u2/rol', 'PATCH', admin, { rol: 'admin' });
        assert.equal(r.status, 200);

        const cuerpo = (await r.json()) as { rol: string; limiteClientes: number | null };
        assert.equal(cuerpo.rol, 'admin');
        // `null` es lo que el tipo reserva para admins. Si quedara un numero,
        // el middleware de cupo le seguiria bloqueando el acceso fiscal.
        assert.equal(cuerpo.limiteClientes, null);
      } finally {
        await s.cerrar();
      }
    });

    test('bajar a usuario exige un cupo en el mismo pedido', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        await s.enviar('/usuarios/u2/rol', 'PATCH', admin, { rol: 'admin' });

        // Sin `limiteClientes` no hay default: quedaria en null, que es acceso
        // fiscal sin tope para una cuenta que ya no es administradora.
        assert.equal(
          (await s.enviar('/usuarios/u2/rol', 'PATCH', admin, { rol: 'user' })).status,
          400,
        );
        const r = await s.enviar('/usuarios/u2/rol', 'PATCH', admin, {
          rol: 'user',
          limiteClientes: 3,
        });
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as { limiteClientes: number }).limiteClientes, 3);
      } finally {
        await s.cerrar();
      }
    });

    test('nadie se cambia el rol a si mismo', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        // Quien se degrada pierde en el mismo movimiento el permiso para
        // revertirlo, y es el error facil de cometer estando en la propia fila.
        assert.equal(
          (
            await s.enviar('/usuarios/u1/rol', 'PATCH', admin, {
              rol: 'user',
              limiteClientes: 5,
            })
          ).status,
          409,
        );
        assert.equal((await s.repo.listarUsuarios()).find((u) => u.id === 'u1')?.rol, 'admin');
      } finally {
        await s.cerrar();
      }
    });

    test('el ultimo admin no se puede degradar', async () => {
      const s = await levantar(crearRepo);
      try {
        // Contra el repositorio y no por HTTP a proposito: la ruta ya frena la
        // autodegradacion, asi que este guard existe para la carrera de dos
        // admins degradandose mutuamente a la vez. Sin el, el sistema queda sin
        // ninguno y de ahi no se vuelve: `crearAdminInicial` se niega a correr
        // con la tabla poblada.
        assert.deepEqual(await s.repo.cambiarRolUsuario('u1', { rol: 'user', limiteClientes: 5 }), {
          ok: false,
          motivo: 'ULTIMO_ADMIN',
        });
        assert.equal((await s.repo.listarUsuarios()).find((u) => u.id === 'u1')?.rol, 'admin');

        // Con dos, degradar a uno si corresponde.
        await s.repo.cambiarRolUsuario('u2', { rol: 'admin' });
        const bajada = await s.repo.cambiarRolUsuario('u1', { rol: 'user', limiteClientes: 5 });
        assert.equal(bajada.ok, true);
      } finally {
        await s.cerrar();
      }
    });

    test('cambiar el rol de una cuenta inexistente da 404', async () => {
      const s = await levantar(crearRepo);
      try {
        const admin = await s.login('bruno@fisterra.com');
        assert.equal(
          (await s.enviar('/usuarios/no-existe/rol', 'PATCH', admin, { rol: 'admin' })).status,
          404,
        );
      } finally {
        await s.cerrar();
      }
    });
  });
}

describe('admin inicial sobre una base vacía', () => {
  const vacia = async () => crearRepositorioSqlite({ archivo: ':memory:', sembrar: false });

  test('crea el primer administrador y con eso ya se puede entrar', async () => {
    const s = await levantar(vacia);
    try {
      // El arranque en frío de una instalación real: SEMBRAR_DEMO=0 deja la
      // tabla vacía, y POST /usuarios exige ser admin. Sin esto no entra nadie.
      assert.equal((await s.repo.listarUsuarios()).length, 0);

      const creado = await s.repo.crearAdminInicial({
        email: 'titular@estudio.com',
        nombre: 'Titular',
        passwordHash: await hashearPassword('la-clave-del-env'),
      });
      if (!creado) throw new Error('no creó el admin inicial');
      assert.equal(creado.rol, 'admin');
      assert.equal(creado.limiteClientes, null);

      // Entra, y entra COMO ADMIN: llega a la gestión de usuarios.
      const token = await s.loginConPassword('titular@estudio.com', 'la-clave-del-env');
      assert.equal((await s.get('/usuarios', token)).status, 200);

      // Un segundo arranque con las variables todavía puestas no duplica la
      // cuenta ni le pisa la contraseña. Es el caso real: el .env del servidor
      // las conserva para siempre y el servicio reinicia solo.
      assert.equal(
        await s.repo.crearAdminInicial({
          email: 'otro@estudio.com',
          nombre: 'Otro',
          passwordHash: await hashearPassword('otra-clave'),
        }),
        null,
      );
      assert.equal((await s.repo.listarUsuarios()).length, 1);
      await s.loginConPassword('titular@estudio.com', 'la-clave-del-env');
    } finally {
      await s.cerrar();
    }
  });
});
