import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashearPassword } from '../crypto/password.js';

export const CLIENTE_DEMO_ID = 'cliente-demo-fisterra';
export const CLIENTE_DEMO_CUIT = '30-00000000-7';
export const CLIENTE_DEMO_RAZON_SOCIAL = 'Estancias del Sur S.A. · DEMO';
export const USUARIO_DEMO_EMAIL = 'demo@fisterra.com';
export const USUARIO_DEMO_PASSWORD = 'demo';

export interface ResultadoClienteDemo {
  clienteId: string;
  usuarioEmail: string;
  notificaciones: number;
  saldos: number;
  planes: number;
  vencimientos: number;
  comprobantes: number;
}

/**
 * Crea una cuenta completamente ficticia para capturas, videos y pruebas de UI.
 *
 * Es idempotente: cada ejecucion reemplaza solamente los datos del CUIT reservado
 * 30-00000000-7. No crea una credencial ARCA, por lo que la API no puede encolar
 * scraping para esta cuenta hasta que alguien configure un acceso deliberadamente.
 */
export async function crearORecrearClienteDemo(db: DatabaseSync): Promise<ResultadoClienteDemo> {
  const ahora = new Date();
  const calendario = calendarioArgentina(ahora);
  const passwordHash = await hashearPassword(USUARIO_DEMO_PASSWORD);
  const usuarioExistente = db
    .prepare('SELECT id FROM arca_users WHERE lower(email) = lower(?)')
    .get(USUARIO_DEMO_EMAIL) as { id: string } | undefined;
  const usuarioDemoId = usuarioExistente?.id ?? 'usuario-demo-fisterra';
  const clienteExistente = db
    .prepare('SELECT id FROM arca_clientes WHERE id = ? OR cuit = ?')
    .get(CLIENTE_DEMO_ID, CLIENTE_DEMO_CUIT) as { id: string } | undefined;
  const clienteId = clienteExistente?.id ?? CLIENTE_DEMO_ID;

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (usuarioExistente) {
      db.prepare(
        `UPDATE arca_users
            SET nombre = ?, rol = 'user', password_hash = ?, activo = 1,
                limite_clientes = 1
          WHERE id = ?`,
      ).run('Demo Fisterra', passwordHash, usuarioDemoId);
    } else {
      db.prepare(
        `INSERT INTO arca_users
           (id, email, nombre, rol, password_hash, activo, limite_clientes)
         VALUES (?, ?, 'Demo Fisterra', 'user', ?, 1, 1)`,
      ).run(usuarioDemoId, USUARIO_DEMO_EMAIL, passwordHash);
    }

    if (clienteExistente) {
      db.prepare(
        `UPDATE arca_clientes
            SET cuit = ?, razon_social = ?, estado_credencial = 'SIN_CARGAR',
                estado_sync = 'OK', ultimo_sync = ?, detalle_sync = NULL,
                credencial_cargada_en = NULL
          WHERE id = ?`,
      ).run(CLIENTE_DEMO_CUIT, CLIENTE_DEMO_RAZON_SOCIAL, ahora.toISOString(), clienteId);
    } else {
      db.prepare(
        `INSERT INTO arca_clientes
           (id, cuit, razon_social, estado_credencial, estado_sync, ultimo_sync,
            detalle_sync, credencial_cargada_en)
         VALUES (?, ?, ?, 'SIN_CARGAR', 'OK', ?, NULL, NULL)`,
      ).run(clienteId, CLIENTE_DEMO_CUIT, CLIENTE_DEMO_RAZON_SOCIAL, ahora.toISOString());
    }

    // La cuenta demo ve solamente al cliente ficticio. Los administradores
    // tambien lo reciben para poder gestionarlo desde la sesion habitual.
    db.prepare('DELETE FROM arca_user_clientes WHERE usuario_id = ?').run(usuarioDemoId);
    db.prepare(
      'INSERT OR IGNORE INTO arca_user_clientes (usuario_id, cliente_id) VALUES (?, ?)',
    ).run(usuarioDemoId, clienteId);
    db.prepare(
      `INSERT OR IGNORE INTO arca_user_clientes (usuario_id, cliente_id)
       SELECT id, ? FROM arca_users WHERE rol = 'admin' AND activo = 1`,
    ).run(clienteId);

    // Nunca dejar una credencial asociada al CUIT reservado de demostracion.
    db.prepare('DELETE FROM arca_credenciales WHERE cliente_id = ?').run(clienteId);
    limpiarDatosDemo(db, clienteId);

    const notificaciones = insertarNotificaciones(db, clienteId, calendario);
    const saldos = insertarSaldos(db, clienteId, calendario);
    const planes = insertarPlanes(db, clienteId, calendario);
    const vencimientos = insertarVencimientos(db, clienteId, calendario);
    const comprobantes = insertarComprobantes(db, clienteId, calendario);

    db.exec('COMMIT');
    return {
      clienteId,
      usuarioEmail: USUARIO_DEMO_EMAIL,
      notificaciones,
      saldos,
      planes,
      vencimientos,
      comprobantes,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function limpiarDatosDemo(db: DatabaseSync, clienteId: string): void {
  // Adjuntos y cuotas se eliminan por CASCADE.
  for (const tabla of [
    'arca_notificaciones',
    'arca_saldos',
    'arca_planes',
    'arca_vencimientos',
    'arca_comprobantes',
    'arca_sync_jobs',
  ]) {
    db.prepare(`DELETE FROM ${tabla} WHERE cliente_id = ?`).run(clienteId);
  }
}

interface CalendarioDemo {
  anio: number;
  mes: number;
  dia: number;
  hoy: string;
  fechaRelativa: (dias: number) => string;
  fechaDelMes: (mes: number, dia: number) => string;
  periodoAnterior: string;
}

function calendarioArgentina(ahora: Date): CalendarioDemo {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(ahora)
      .filter((parte) => parte.type !== 'literal')
      .map((parte) => [parte.type, Number(parte.value)]),
  ) as Record<string, number>;
  const anio = partes['year'] ?? ahora.getUTCFullYear();
  const mes = partes['month'] ?? ahora.getUTCMonth() + 1;
  const dia = partes['day'] ?? ahora.getUTCDate();
  const base = new Date(Date.UTC(anio, mes - 1, dia, 12));
  const fechaRelativa = (dias: number) => {
    const fecha = new Date(base);
    fecha.setUTCDate(fecha.getUTCDate() + dias);
    return fecha.toISOString().slice(0, 10);
  };
  const fechaDelMes = (mesObjetivo: number, diaObjetivo: number) => {
    const ultimoDia = new Date(Date.UTC(anio, mesObjetivo, 0)).getUTCDate();
    return `${anio}-${String(mesObjetivo).padStart(2, '0')}-${String(Math.min(diaObjetivo, ultimoDia)).padStart(2, '0')}`;
  };
  const mesAnterior = mes === 1 ? 12 : mes - 1;
  const anioAnterior = mes === 1 ? anio - 1 : anio;
  return {
    anio,
    mes,
    dia,
    hoy: fechaRelativa(0),
    fechaRelativa,
    fechaDelMes,
    periodoAnterior: `${String(mesAnterior).padStart(2, '0')}/${anioAnterior}`,
  };
}

function insertarNotificaciones(
  db: DatabaseSync,
  clienteId: string,
  calendario: CalendarioDemo,
): number {
  const insertar = db.prepare(
    `INSERT INTO arca_notificaciones
       (id, cliente_id, id_comunicacion, fecha, organismo, asunto, leida,
        vista_app_en, leido_app_en, cuerpo)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const filas = [
    {
      id: 'demo-notificacion-1', dias: -1, organismo: 'ARCA', leida: 0,
      asunto: `Recordatorio de vencimiento - IVA ${calendario.periodoAnterior}`,
      cuerpo:
        `Se recuerda que la declaración jurada y el pago del Impuesto al Valor Agregado ` +
        `correspondiente al período ${calendario.periodoAnterior} se encuentran próximos a vencer. ` +
        `Verifique la información presentada en el Sistema de Cuentas Tributarias.\n\n` +
        `Este contenido es completamente ficticio y se utiliza solamente para la demostración de Fisterra.`,
    },
    {
      id: 'demo-notificacion-2', dias: -3, organismo: 'ARCA', leida: 0,
      asunto: 'Control sistémico - Documentación disponible',
      cuerpo:
        `Se pone a disposición el detalle de inconsistencias detectadas por controles automáticos. ` +
        `Consulte el archivo adjunto y revise los períodos informados antes de la fecha indicada.\n\n` +
        `No requiere ninguna acción real: es una comunicación creada para la demo.`,
    },
    {
      id: 'demo-notificacion-3', dias: -7, organismo: 'ARCA', leida: 1,
      asunto: 'Constancia de presentación - Formulario 931',
      cuerpo:
        `La presentación del Formulario 931 fue registrada correctamente. ` +
        `La constancia de ejemplo se encuentra adjunta a esta comunicación.`,
    },
    {
      id: 'demo-notificacion-4', dias: -12, organismo: 'ARCA', leida: 0,
      asunto: 'Aviso sobre plan de facilidades vigente',
      cuerpo:
        `El plan W-DEMO-10482 se encuentra vigente. La próxima cuota operará el ` +
        `${formatearFechaDemo(calendario.fechaRelativa(10))}. Revise que el medio de pago informado se encuentre activo.`,
    },
    {
      id: 'demo-notificacion-5', dias: -20, organismo: 'ARCA', leida: 1,
      asunto: 'Novedades del Sistema de Cuentas Tributarias',
      cuerpo:
        `Se actualizaron los saldos y vencimientos de la cuenta tributaria. ` +
        `Ingrese al servicio para consultar el detalle por impuesto, concepto y período.`,
    },
    {
      id: 'demo-notificacion-6', dias: -28, organismo: 'Ministerio de Trabajo', leida: 1,
      asunto: 'Comunicación informativa para empleadores',
      cuerpo:
        `Información general sobre obligaciones laborales del mes en curso. ` +
        `Este mensaje no genera vencimientos ni requiere respuesta.`,
    },
  ];
  for (const [indice, fila] of filas.entries()) {
    insertar.run(
      fila.id,
      clienteId,
      `DEMO-${calendario.anio}-${String(indice + 1).padStart(3, '0')}`,
      calendario.fechaRelativa(fila.dias),
      fila.organismo,
      fila.asunto,
      fila.leida,
      fila.cuerpo,
    );
  }

  insertarAdjunto(
    db,
    'demo-adjunto-1',
    'demo-notificacion-2',
    'control-sistemico-demo.csv',
    'text/csv',
    'Período;Impuesto;Observación\n07/2026;IVA;Diferencia informativa de demostración\n06/2026;SUSS;Control sin efecto fiscal real\n',
  );
  insertarAdjunto(
    db,
    'demo-adjunto-2',
    'demo-notificacion-3',
    'constancia-presentacion-demo.txt',
    'text/plain',
    `CONSTANCIA FICTICIA\nCUIT: ${CLIENTE_DEMO_CUIT}\nFormulario: F.931\nFecha: ${calendario.hoy}\nSin validez fiscal.`,
  );
  return filas.length;
}

function insertarAdjunto(
  db: DatabaseSync,
  id: string,
  notificacionId: string,
  nombre: string,
  mimeType: string,
  texto: string,
): void {
  const contenido = Buffer.from(texto, 'utf8');
  db.prepare(
    `INSERT INTO arca_notificacion_adjuntos
       (id, notificacion_id, id_archivo, nombre, mime_type, tamano, sha256, contenido)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    notificacionId,
    `archivo-${id}`,
    nombre,
    mimeType,
    contenido.byteLength,
    createHash('sha256').update(contenido).digest('hex'),
    contenido,
  );
}

function insertarSaldos(db: DatabaseSync, clienteId: string, calendario: CalendarioDemo): number {
  const insertar = db.prepare(
    `INSERT INTO arca_saldos
       (cliente_id, establecimiento, impuesto, concepto, subconcepto, periodo,
        anticipo_cuota, fecha_vencimiento, saldo, interes_resarcitorio, interes_punitorio)
     VALUES (?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const filas = [
    ['30 - IVA', '19 - DECLARACIÓN JURADA', '19 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', calendario.fechaRelativa(-4), -650_000, -18_720.4, 0],
    ['10 - GANANCIAS SOCIEDADES', '191 - ANTICIPOS', '191 - ANTICIPOS', String(calendario.anio), '6', calendario.fechaRelativa(-2), -430_500, 0, 0],
    ['301 - SUSS', '19 - DECLARACIÓN JURADA', '19 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', calendario.fechaRelativa(-6), -215_000, -9_430, 0],
    ['353 - RETENCIONES CONTRIB. SEG. SOCIAL', '736 - DECLARACIÓN JURADA', '736 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', calendario.fechaRelativa(-1), -92_000, 0, 0],
  ] as const;
  for (const fila of filas) insertar.run(clienteId, ...fila);
  return filas.length;
}

function insertarPlanes(db: DatabaseSync, clienteId: string, calendario: CalendarioDemo): number {
  const insertarPlan = db.prepare(
    `INSERT INTO arca_planes
       (id, cliente_id, numero, concepto, fecha_presentacion, fecha_consolidacion,
        tipo_plan, monto_consolidado, estado, situacion, cuotas_totales, cuotas_pagas,
        cuotas_impagas, monto_cuota, proximo_vencimiento, total_pagado, leido_app_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  insertarPlan.run(
    'demo-plan-1', clienteId, 'W-DEMO-10482', 'RG 5321 - Plan Deuda General',
    calendario.fechaRelativa(-120), calendario.fechaRelativa(-118), '1295', 2_867_400,
    'Aceptada', 'Vigente', 12, 7, 1, 238_950, calendario.fechaRelativa(10), 1_672_650,
  );
  insertarPlan.run(
    'demo-plan-2', clienteId, 'W-DEMO-08731', 'RG 5321 - Impuestos Anuales',
    calendario.fechaRelativa(-260), calendario.fechaRelativa(-258), '1295', 984_000,
    'Aceptada', 'Plan cancelado', 6, 6, 0, 164_000, null, 984_000,
  );

  const insertarCuota = db.prepare(
    `INSERT INTO arca_plan_cuotas
       (id, plan_id, numero, variante, capital, interes_financiero,
        interes_resarcitorio, total, fecha_vencimiento, pago, estado)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let numero = 1; numero <= 12; numero += 1) {
    const pagada = numero <= 7;
    const impaga = numero === 8;
    const vencimiento = calendario.fechaRelativa((numero - 8) * 30 - 5);
    insertarCuota.run(
      `demo-plan-1-cuota-${numero}`,
      'demo-plan-1',
      numero,
      210_000,
      28_950,
      impaga ? 7_240 : 0,
      impaga ? 246_190 : 238_950,
      vencimiento,
      pagada ? calendario.fechaRelativa((numero - 8) * 30 - 7) : '',
      pagada ? 'Cuota paga' : impaga ? 'Cuota impaga' : 'A vencer',
    );
  }
  for (let numero = 1; numero <= 6; numero += 1) {
    insertarCuota.run(
      `demo-plan-2-cuota-${numero}`,
      'demo-plan-2',
      numero,
      145_000,
      19_000,
      0,
      164_000,
      calendario.fechaRelativa(-300 + numero * 30),
      calendario.fechaRelativa(-302 + numero * 30),
      'Cuota paga',
    );
  }
  return 2;
}

function insertarVencimientos(
  db: DatabaseSync,
  clienteId: string,
  calendario: CalendarioDemo,
): number {
  const insertar = db.prepare(
    `INSERT INTO arca_vencimientos
       (id, cliente_id, impuesto, concepto, subconcepto, periodo,
        anticipo_cuota, fecha, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const filas = [
    ['demo-vencimiento-1', '30 - IVA', '19 - DECLARACIÓN JURADA', '19 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', 3, 'Presentación y pago'],
    ['demo-vencimiento-2', '301 - SUSS', '19 - DECLARACIÓN JURADA', '19 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', 7, 'Presentación y pago'],
    ['demo-vencimiento-3', '10 - GANANCIAS SOCIEDADES', '191 - ANTICIPOS', '191 - ANTICIPOS', String(calendario.anio), '7', 12, 'Pago de anticipo'],
    ['demo-vencimiento-4', '217 - SICORE', '19 - DECLARACIÓN JURADA', '19 - DECLARACIÓN JURADA', calendario.periodoAnterior, '0', 20, 'Presentación'],
    ['demo-vencimiento-5', '30 - IVA', '191 - ANTICIPOS', '191 - ANTICIPOS', `${String(calendario.mes).padStart(2, '0')}/${calendario.anio}`, '0', 35, 'Pago'],
  ] as const;
  for (const [id, impuesto, concepto, subconcepto, periodo, cuota, dias, detalle] of filas) {
    insertar.run(id, clienteId, impuesto, concepto, subconcepto, periodo, cuota, calendario.fechaRelativa(dias), detalle);
  }
  return filas.length;
}

function insertarComprobantes(
  db: DatabaseSync,
  clienteId: string,
  calendario: CalendarioDemo,
): number {
  const insertar = db.prepare(
    `INSERT INTO arca_comprobantes
       (id, cliente_id, tipo, fecha, codigo_comprobante, tipo_comprobante,
        punto_venta, numero, contraparte, cuit_contraparte, neto, iva, total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const clientes = ['Comercial Andina S.A.', 'Logística del Valle S.R.L.', 'Mercado Austral S.A.', 'Insumos Patagónicos S.R.L.'];
  const proveedores = ['Energía del Sur S.A.', 'Transportes Cordillera S.R.L.', 'Servicios del Neuquén S.A.', 'Tecnología Federal S.R.L.'];
  type FilaComprobante = readonly [
    string, 'EMITIDO' | 'RECIBIDO', string, number, string, number, number,
    string, string, number, number, number,
  ];
  let cantidad = 0;
  for (let mes = 1; mes <= calendario.mes; mes += 1) {
    const diaMaximo = mes === calendario.mes ? Math.max(1, calendario.dia - 1) : 24;
    const dia = (preferido: number) => Math.min(preferido, diaMaximo);
    const netoEmitido1 = 720_000 + mes * 58_500;
    const netoEmitido2 = 360_000 + mes * 31_250;
    const netoRecibido1 = 295_000 + mes * 22_400;
    const netoRecibido2 = 180_000 + mes * 17_750;
    const filas: FilaComprobante[] = [
      [`demo-comp-${mes}-e1`, 'EMITIDO', calendario.fechaDelMes(mes, dia(8)), 1, 'Factura A', 5, 20_000 + mes * 10 + 1, clientes[(mes - 1) % clientes.length]!, cuitFicticio(mes), netoEmitido1, redondear(netoEmitido1 * 0.21), redondear(netoEmitido1 * 1.21)],
      [`demo-comp-${mes}-e2`, 'EMITIDO', calendario.fechaDelMes(mes, dia(19)), 1, 'Factura A', 5, 20_000 + mes * 10 + 2, clientes[mes % clientes.length]!, cuitFicticio(mes + 20), netoEmitido2, redondear(netoEmitido2 * 0.21), redondear(netoEmitido2 * 1.21)],
      [`demo-comp-${mes}-r1`, 'RECIBIDO', calendario.fechaDelMes(mes, dia(11)), 1, 'Factura A', 12, 880_000 + mes * 10 + 1, proveedores[(mes - 1) % proveedores.length]!, cuitFicticio(mes + 40), netoRecibido1, redondear(netoRecibido1 * 0.21), redondear(netoRecibido1 * 1.21)],
      [`demo-comp-${mes}-r2`, 'RECIBIDO', calendario.fechaDelMes(mes, dia(23)), 1, 'Factura A', 7, 330_000 + mes * 10 + 2, proveedores[mes % proveedores.length]!, cuitFicticio(mes + 60), netoRecibido2, redondear(netoRecibido2 * 0.21), redondear(netoRecibido2 * 1.21)],
    ];
    for (const fila of filas) {
      insertar.run(
        fila[0], clienteId, fila[1], fila[2], fila[3], fila[4], fila[5], fila[6],
        fila[7], fila[8], fila[9], fila[10], fila[11],
      );
      cantidad += 1;
    }
    if (mes === 3 || mes === 7) {
      const neto = -(75_000 + mes * 5_000);
      insertar.run(
        `demo-comp-${mes}-nc`, clienteId, 'RECIBIDO', calendario.fechaDelMes(mes, dia(26)),
        3, 'Nota de Crédito A', 12, 990_000 + mes, proveedores[0]!, cuitFicticio(90),
        neto, redondear(neto * 0.21), redondear(neto * 1.21),
      );
      cantidad += 1;
    }
  }
  return cantidad;
}

function cuitFicticio(numero: number): string {
  const base = `30${String(numero).padStart(8, '0').slice(-8)}`;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((total, peso, indice) => total + peso * Number(base[indice]), 0);
  const resto = suma % 11;
  const digito = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return `${base.slice(0, 2)}-${base.slice(2)}-${digito}`;
}

function redondear(numero: number): number {
  return Math.round(numero * 100) / 100;
}

function formatearFechaDemo(fechaIso: string): string {
  const [anio, mes, dia] = fechaIso.split('-');
  return `${dia}/${mes}/${anio}`;
}
