const fs = require("fs");
const os = require("os");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { createWorker } = require("tesseract.js");
const config = require("./config");
const { query, withTransaction } = require("./db");

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function normalizePlate(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function formatMoney(value) {
  return `${new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 }).format(Number(value || 0))} Gs.`;
}

function chatIdOf(msg) {
  return String(msg.chat?.id || msg.from?.id || "");
}

function isAllowed(chatId) {
  return config.telegram.allowedChatIds.includes(String(chatId));
}

function getSession(chatId) {
  const session = sessions.get(chatId);
  if (!session || Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(chatId);
    return null;
  }
  session.updatedAt = Date.now();
  return session;
}

function newSession(chatId) {
  const session = { step: "WAITING_PLATE", updatedAt: Date.now() };
  sessions.set(chatId, session);
  return session;
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function button(text, data) {
  return { text, callback_data: data };
}

function send(bot, chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, options);
}

async function answer(bot, callbackQuery, text) {
  try {
    await bot.answerCallbackQuery(callbackQuery.id, text ? { text } : undefined);
  } catch (error) {
    console.error("Telegram callback error:", error.message);
  }
}

async function recognizePlate(filePath) {
  const worker = await createWorker("eng");
  try {
    const result = await worker.recognize(filePath);
    const candidates = String(result.data.text || "")
      .split(/\s+/)
      .map(normalizePlate)
      .filter((value) => value.length >= 4 && value.length <= 10);
    return candidates.sort((a, b) => b.length - a.length)[0] || "";
  } finally {
    await worker.terminate();
  }
}

async function handlePhoto(bot, msg) {
  const chatId = chatIdOf(msg);
  if (!isAllowed(chatId)) return send(bot, chatId, `Chat no autorizado. Tu ID es ${chatId}.`);

  const session = newSession(chatId);
  await send(bot, chatId, "Estoy leyendo la chapa de la foto. Puede tardar unos segundos...");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lavadero-telegram-"));
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imagePath = await bot.downloadFile(photo.file_id, tempDir);
    const detected = await recognizePlate(imagePath);
    if (!detected) {
      session.step = "WAITING_PLATE";
      return send(bot, chatId, "No pude leer la chapa. Escribila manualmente, por favor.");
    }
    session.plate = detected;
    session.step = "CONFIRM_PLATE";
    await send(bot, chatId, `Detecte la chapa: ${detected}\n¿Es correcta?`, {
      reply_markup: keyboard([[button("Si, continuar", "plate:confirm"), button("Corregir", "plate:edit")]])
    });
  } catch (error) {
    console.error("Telegram OCR error:", error);
    session.step = "WAITING_PLATE";
    await send(bot, chatId, "No pude procesar la foto. Escribi la chapa manualmente o envia otra foto.");
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function continueWithPlate(bot, chatId, session) {
  const result = await query(
    `select c.*, g.nombre as grupo_nombre, coalesce(g.es_credito, false) as es_credito
     from clientes c
     left join grupo_cliente g on g.id = c.grupo_cliente_id
     where c.activo = true and c.chapa = $1`,
    [session.plate]
  );
  if (result.rows[0]) {
    session.client = result.rows[0];
    await send(
      bot,
      chatId,
      `Cliente encontrado:\nChapa: ${result.rows[0].chapa}\nAuto: ${result.rows[0].marca_modelo}\nGrupo: ${result.rows[0].grupo_nombre || "Sin grupo"}`
    );
    return askPersonal(bot, chatId, session);
  }

  session.newClient = { chapa: session.plate };
  session.step = "WAITING_NEW_MAKE";
  return send(bot, chatId, "No existe ese cliente. Escribi la marca y modelo del auto:");
}

async function askPersonal(bot, chatId, session) {
  const result = await query(`select id, nombre from personal where activo = true order by nombre`);
  if (!result.rows.length) return send(bot, chatId, "No hay personal activo cargado en el sistema.");
  session.step = "WAITING_PERSONAL";
  const rows = result.rows.map((item) => [button(item.nombre, `personal:${item.id}`)]);
  return send(bot, chatId, "¿Quien va a lavar el auto?", { reply_markup: keyboard(rows) });
}

async function askClientGroup(bot, chatId, session) {
  const result = await query(`select id, nombre from grupo_cliente where activo = true order by nombre`);
  session.step = "WAITING_CLIENT_GROUP";
  const rows = [[button("Sin grupo", "clientgroup:0")]];
  result.rows.forEach((item) => rows.push([button(item.nombre, `clientgroup:${item.id}`)]));
  return send(bot, chatId, "Selecciona un grupo de cliente (opcional):", { reply_markup: keyboard(rows) });
}

async function askServiceGroup(bot, chatId, session) {
  const result = await query(`select id, nombre from servicio_grupo where activo = true order by nombre`);
  if (!result.rows.length) return askServices(bot, chatId, session, null);
  session.step = "WAITING_SERVICE_GROUP";
  return send(bot, chatId, "Selecciona el grupo de servicio:", {
    reply_markup: keyboard(result.rows.map((item) => [button(item.nombre, `servicegroup:${item.id}`)]))
  });
}

async function askServices(bot, chatId, session, groupId) {
  const params = [];
  const filter = groupId ? "and s.servicio_grupo_id = $1" : "";
  if (groupId) params.push(groupId);
  const result = await query(
    `select s.id, s.nombre, s.precio_base
     from servicios s
     where s.activo = true ${filter}
     order by s.nombre`,
    params
  );
  if (!result.rows.length) return send(bot, chatId, "No hay servicios activos en ese grupo.");
  session.step = "WAITING_SERVICES";
  session.availableServices = result.rows;
  const rows = result.rows.map((item) => {
    const selected = session.serviceIds?.includes(Number(item.id));
    return [button(`${selected ? "[x]" : "[ ]"} ${item.nombre} - ${formatMoney(item.precio_base)}`, `service:${item.id}`)];
  });
  rows.push([button("Terminar seleccion", "services:done")]);
  return send(bot, chatId, "Selecciona uno o varios servicios:", { reply_markup: keyboard(rows) });
}

async function askPayment(bot, chatId, session) {
  if (session.client.es_credito) {
    const result = await query(`select id, nombre from formas_pago where activo = true and nombre = 'CREDITO' limit 1`);
    if (!result.rows[0]) throw new Error("No existe la forma de pago CREDITO.");
    session.formaPagoId = result.rows[0].id;
    return showSummary(bot, chatId, session);
  }
  const result = await query(
    `select id, nombre from formas_pago
     where activo = true and nombre not in ('ANULADO', 'CREDITO')
     order by nombre`
  );
  if (!result.rows.length) return send(bot, chatId, "No hay formas de pago activas.");
  session.step = "WAITING_PAYMENT";
  return send(bot, chatId, "Selecciona la forma de pago:", {
    reply_markup: keyboard(result.rows.map((item) => [button(item.nombre, `payment:${item.id}`)]))
  });
}

async function showSummary(bot, chatId, session) {
  const total = session.services.reduce((sum, item) => sum + Number(item.precio_base || 0), 0);
  session.total = total;
  session.step = "WAITING_CONFIRMATION";
  const pago = session.client.es_credito ? "CREDITO" : session.formaPagoNombre;
  const services = session.services.map((item) => `- ${item.nombre}: ${formatMoney(item.precio_base)}`).join("\n");
  return send(
    bot,
    chatId,
    `Resumen del lavado:\n\nChapa: ${session.client.chapa}\nAuto: ${session.client.marca_modelo}\nLavador: ${session.personalNombre}\nServicios:\n${services}\nTotal: ${formatMoney(total)}\nForma de pago: ${pago}`,
    { reply_markup: keyboard([[button("CONFIRMAR Y GUARDAR", "wash:confirm")], [button("CANCELAR", "wash:cancel")]]) }
  );
}

async function createLavado(session, chatId, from) {
  const creadoPor = `Telegram ${from.username ? `@${from.username}` : chatId}`;
  return withTransaction(async (client) => {
    let clienteId = session.client?.id;
    if (!clienteId) {
      const inserted = await client.query(
        `insert into clientes (chapa, marca_modelo, grupo_cliente_id, creado_por)
         values ($1, $2, nullif($3, '')::integer, $4)
         returning id`,
        [session.newClient.chapa, session.newClient.marcaModelo, session.newClient.grupoClienteId || "", creadoPor]
      );
      clienteId = inserted.rows[0].id;
    }

    const clienteResult = await client.query(`select * from clientes where id = $1 for update`, [clienteId]);
    const cliente = clienteResult.rows[0];
    if (!cliente) throw new Error("Cliente no encontrado.");
    const grupoClienteResult = cliente.grupo_cliente_id
      ? await client.query(`select coalesce(es_credito, false) as es_credito from grupo_cliente where id = $1`, [cliente.grupo_cliente_id])
      : { rows: [] };
    cliente.es_credito = Boolean(grupoClienteResult.rows[0]?.es_credito);

    const serviceIds = session.serviceIds.map(Number);
    const services = await client.query(
      `select id, nombre, precio_base from servicios where activo = true and id = any($1::int[]) order by nombre`,
      [serviceIds]
    );
    if (services.rows.length !== serviceIds.length) throw new Error("Uno de los servicios ya no esta disponible.");

    let forma;
    if (cliente.es_credito) {
      forma = await client.query(`select id, nombre from formas_pago where activo = true and nombre = 'CREDITO' limit 1`);
    } else {
      forma = await client.query(`select id, nombre from formas_pago where id = $1 and activo = true and nombre <> 'ANULADO'`, [session.formaPagoId]);
    }
    if (!forma.rows[0]) throw new Error("Forma de pago no encontrada.");

    const total = services.rows.reduce((sum, item) => sum + Number(item.precio_base || 0), 0);
    const comision = Math.round(total * 40) / 100;
    const saldo = Math.round(total * 60) / 100;
    let creditoId = null;
    if (cliente.es_credito) {
      await client.query(`lock table grupo_cliente_creditos in share row exclusive mode`);
      const open = await client.query(
        `select gcc.id from grupo_cliente_creditos gcc where gcc.grupo_cliente_id = $1 and gcc.estado = 'ABIERTO' limit 1`,
        [cliente.grupo_cliente_id]
      );
      if (open.rows[0]) creditoId = open.rows[0].id;
      else {
        const created = await client.query(
          `insert into grupo_cliente_creditos (grupo_cliente_id, estado, fecha_inicio, creado_por)
           values ($1, 'ABIERTO', current_date, $2) returning id`,
          [cliente.grupo_cliente_id, creadoPor]
        );
        creditoId = created.rows[0].id;
      }
    }

    const lavado = await client.query(
      `insert into lavados
       (cliente_id, personal_id, condicion, forma_pago_id, estado, total, comision_personal, saldo_lavadero, grupo_cliente_credito_id, creado_por)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [clienteId, session.personalId, cliente.es_credito ? "CREDITO" : "CONTADO", forma.rows[0].id, cliente.es_credito ? "CREDITO" : (forma.rows[0].nombre === "LAVADO" ? "EMITIDO" : "PAGADO"), total, comision, saldo, creditoId, creadoPor]
    );
    for (const item of services.rows) {
      await client.query(
        `insert into lavado_servicios (lavado_id, servicio_id, precio, creado_por) values ($1, $2, $3, $4)`,
        [lavado.rows[0].id, item.id, item.precio_base, creadoPor]
      );
    }
    await client.query(
      `insert into comisiones_diarias (fecha, personal_id, total_lavados_emitidos, total_servicios, total_comision_40, creado_por)
       values (current_date, $1, 1, $2, $3, $4)
       on conflict (fecha, personal_id) do update set
         total_lavados_emitidos = greatest(0, comisiones_diarias.total_lavados_emitidos + 1),
         total_servicios = greatest(0, comisiones_diarias.total_servicios + excluded.total_servicios),
         total_comision_40 = greatest(0, comisiones_diarias.total_comision_40 + excluded.total_comision_40)`,
      [session.personalId, total, comision, creadoPor]
    );
    return lavado.rows[0].id;
  });
}

async function handleText(bot, msg) {
  const chatId = chatIdOf(msg);
  const text = String(msg.text || "").trim();
  if (text === "/mi_id") return send(bot, chatId, `Tu ID de Telegram es: ${chatId}`);
  if (text === "/cancelar") {
    clearSession(chatId);
    return send(bot, chatId, "Operacion cancelada.");
  }
  if (!isAllowed(chatId)) return send(bot, chatId, `Chat no autorizado. Tu ID es ${chatId}.`);
  if (text === "/start" || text === "/nuevo") {
    newSession(chatId);
    return send(bot, chatId, "Envia una foto del auto para comenzar un nuevo lavado.");
  }

  const session = getSession(chatId);
  if (!session) return send(bot, chatId, "Envia una foto del auto o usa /nuevo para comenzar.");
  if (session.step === "WAITING_PLATE") {
    session.plate = normalizePlate(text);
    if (session.plate.length < 4) return send(bot, chatId, "La chapa parece demasiado corta. Escribila nuevamente.");
    return continueWithPlate(bot, chatId, session);
  }
  if (session.step === "WAITING_NEW_MAKE") {
    session.newClient.marcaModelo = text.toUpperCase();
    return askClientGroup(bot, chatId, session);
  }
  return send(bot, chatId, "Usa los botones del mensaje o escribe /cancelar para salir.");
}

async function handleCallback(bot, callbackQuery) {
  const chatId = String(callbackQuery.message?.chat?.id || "");
  await answer(bot, callbackQuery);
  if (!isAllowed(chatId)) return send(bot, chatId, `Chat no autorizado. Tu ID es ${chatId}.`);
  const session = getSession(chatId);
  if (!session) return send(bot, chatId, "La operacion vencio. Envia una nueva foto para comenzar.");
  const [action, rawValue] = String(callbackQuery.data || "").split(":");
  try {
    if (action === "plate" && rawValue === "confirm") return continueWithPlate(bot, chatId, session);
    if (action === "plate" && rawValue === "edit") {
      session.step = "WAITING_PLATE";
      return send(bot, chatId, "Escribi la chapa correcta:");
    }
    if (action === "clientgroup") {
      session.newClient.grupoClienteId = rawValue === "0" ? null : Number(rawValue);
      const created = await query(`select nombre, coalesce(es_credito, false) as es_credito from grupo_cliente where id = $1`, [session.newClient.grupoClienteId]);
      session.client = { ...session.newClient, marca_modelo: session.newClient.marcaModelo, grupo_nombre: created.rows[0]?.nombre || "Sin grupo", es_credito: Boolean(created.rows[0]?.es_credito) };
      await send(bot, chatId, `Cliente nuevo preparado: ${session.client.chapa} - ${session.client.marca_modelo}`);
      return askPersonal(bot, chatId, session);
    }
    if (action === "personal") {
      const result = await query(`select id, nombre from personal where id = $1 and activo = true`, [Number(rawValue)]);
      if (!result.rows[0]) throw new Error("Personal no encontrado.");
      session.personalId = result.rows[0].id;
      session.personalNombre = result.rows[0].nombre;
      return askServiceGroup(bot, chatId, session);
    }
    if (action === "servicegroup") {
      session.serviceGroupId = Number(rawValue);
      session.serviceIds = [];
      return askServices(bot, chatId, session, session.serviceGroupId);
    }
    if (action === "service") {
      const serviceId = Number(rawValue);
      session.serviceIds = session.serviceIds || [];
      session.serviceIds = session.serviceIds.includes(serviceId)
        ? session.serviceIds.filter((id) => id !== serviceId)
        : [...session.serviceIds, serviceId];
      return askServices(bot, chatId, session, session.serviceGroupId || null);
    }
    if (action === "services" && rawValue === "done") {
      if (!session.serviceIds?.length) return send(bot, chatId, "Selecciona al menos un servicio.");
      const result = await query(`select id, nombre, precio_base from servicios where activo = true and id = any($1::int[])`, [session.serviceIds]);
      session.services = result.rows;
      return askPayment(bot, chatId, session);
    }
    if (action === "payment") {
      const result = await query(`select id, nombre from formas_pago where id = $1 and activo = true and nombre not in ('ANULADO', 'CREDITO')`, [Number(rawValue)]);
      if (!result.rows[0]) throw new Error("Forma de pago no encontrada.");
      session.formaPagoId = result.rows[0].id;
      session.formaPagoNombre = result.rows[0].nombre;
      return showSummary(bot, chatId, session);
    }
    if (action === "wash" && rawValue === "cancel") {
      clearSession(chatId);
      return send(bot, chatId, "Operacion cancelada.");
    }
    if (action === "wash" && rawValue === "confirm") {
      const lavadoId = await createLavado(session, chatId, callbackQuery.from);
      clearSession(chatId);
      return send(bot, chatId, `Lavado #${lavadoId} registrado correctamente.`);
    }
  } catch (error) {
    console.error("Telegram flow error:", error);
    return send(bot, chatId, `No se pudo completar la operacion: ${error.message}`);
  }
}

function startTelegramBot() {
  if (!config.telegram.token) {
    console.log("Telegram desactivado: falta TELEGRAM_BOT_TOKEN en .env");
    return null;
  }
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  bot.on("photo", (msg) => handlePhoto(bot, msg).catch((error) => console.error("Telegram photo error:", error)));
  bot.on("message", (msg) => {
    if (msg.text) handleText(bot, msg).catch((error) => console.error("Telegram message error:", error));
  });
  bot.on("callback_query", (callbackQuery) => handleCallback(bot, callbackQuery).catch((error) => console.error("Telegram callback error:", error)));
  bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
  console.log("Telegram bot conectado en modo polling.");
  return bot;
}

module.exports = { startTelegramBot };
