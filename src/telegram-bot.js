const fs = require("fs");
const os = require("os");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
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

function twoColumns(buttons) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

function parseMoney(value) {
  const raw = String(value || "").trim().replace(/[^\d.,-]/g, "");
  if (!raw) return 0;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let normalized = raw;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    normalized = raw.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (lastDot >= 0 && raw.length - lastDot - 1 === 3) {
    normalized = raw.replace(/\./g, "");
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
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

async function recognizeVehicle(filePath) {
  if (!config.plateRecognizer.token) throw new Error("Falta PLATE_RECOGNIZER_TOKEN en .env.");
  const formData = new FormData();
  formData.append("upload", new Blob([await fs.promises.readFile(filePath)], { type: "image/jpeg" }), path.basename(filePath));
  formData.append("regions", "py");
  formData.append("mmc", "true");
  const response = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
    method: "POST",
    headers: { Authorization: `Token ${config.plateRecognizer.token}` },
    body: formData
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.detail || `Plate Recognizer respondio HTTP ${response.status}.`);
  const result = Array.isArray(body.results) ? body.results[0] : null;
  return {
    plate: normalizePlate(result?.plate),
    vehicle: {
      make: String(result?.vehicle?.make || "").trim(),
      model: String(result?.vehicle?.model || "").trim(),
      color: String(result?.vehicle?.color || "").trim()
    },
    score: Number(result?.score || 0)
  };
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
    const detected = await recognizeVehicle(imagePath);
    if (!detected.plate) {
      session.step = "WAITING_PLATE";
      return send(bot, chatId, "No pude leer la chapa. Escribila manualmente, por favor.");
    }
    session.plate = detected.plate;
    session.vehicleSuggestion = detected.vehicle;
    session.step = "CONFIRM_PLATE";
    const vehicleText = [detected.vehicle.make, detected.vehicle.model, detected.vehicle.color].filter(Boolean).join(" ");
    await send(bot, chatId, `Detecte la chapa: ${detected.plate}${vehicleText ? `\nVehiculo detectado: ${vehicleText}` : ""}\n¿Es correcta?`, {
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
  const suggestion = [session.vehicleSuggestion?.make, session.vehicleSuggestion?.model].filter(Boolean).join(" ");
  return send(bot, chatId, suggestion
    ? `No existe ese cliente. Detecte como marca/modelo: ${suggestion}\n¿Querés usar ese dato o escribirlo manualmente?`
    : "No existe ese cliente. Escribi la marca y modelo del auto:", suggestion
    ? { reply_markup: keyboard([[button(`Usar ${suggestion}`, "vehicle:use")], [button("Escribir manualmente", "vehicle:edit")]]) }
    : {});
}

async function askPersonal(bot, chatId, session) {
  const result = await query(`select id, nombre from personal where activo = true order by nombre`);
  if (!result.rows.length) return send(bot, chatId, "No hay personal activo cargado en el sistema.");
  session.step = "WAITING_PERSONAL";
  const rows = twoColumns(result.rows.map((item) => button(item.nombre, `personal:${item.id}`)));
  return send(bot, chatId, "¿Quien va a lavar el auto?", { reply_markup: keyboard(rows) });
}

async function askClientGroup(bot, chatId, session) {
  const result = await query(`select id, nombre from grupo_cliente where activo = true order by nombre`);
  session.step = "WAITING_CLIENT_GROUP";
  const rows = [[button("Sin grupo", "clientgroup:0")]];
  rows.push(...twoColumns(result.rows.map((item) => button(item.nombre, `clientgroup:${item.id}`))));
  return send(bot, chatId, "Selecciona un grupo de cliente (opcional):", { reply_markup: keyboard(rows) });
}

async function askServiceGroup(bot, chatId, session) {
  const result = await query(`select id, nombre from servicio_grupo where activo = true order by nombre`);
  if (!result.rows.length) return askServices(bot, chatId, session, null);
  session.step = "WAITING_SERVICE_GROUP";
  return send(bot, chatId, "Selecciona el grupo de servicio:", {
    reply_markup: keyboard(twoColumns(result.rows.map((item) => button(item.nombre, `servicegroup:${item.id}`))))
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
  session.step = "WAITING_SERVICE";
  session.availableServices = result.rows;
  const rows = twoColumns(result.rows.map((item) => button(`${item.nombre} - ${formatMoney(item.precio_base)}`, `service:${item.id}`)));
  rows.push([button("Otro servicio / precio manual", "service:custom")]);
  return send(bot, chatId, "Selecciona un servicio:", { reply_markup: keyboard(rows) });
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

    let serviceIds = session.serviceIds.map(Number);
    if (session.customService) {
      const custom = await client.query(
        `insert into servicios (servicio_grupo_id, nombre, precio_base, activo, creado_por)
         values (null, $1, $2, true, $3) returning id`,
        [session.customService.nombre, session.customService.precio, creadoPor]
      );
      serviceIds = [custom.rows[0].id];
    }
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
  if (session.step === "WAITING_CUSTOM_SERVICE_DESCRIPTION") {
    if (!text) return send(bot, chatId, "Escribi una descripcion para el servicio:");
    session.customService = { nombre: text.toUpperCase() };
    session.step = "WAITING_CUSTOM_SERVICE_PRICE";
    return send(bot, chatId, "Escribi el precio del servicio, por ejemplo: 25000");
  }
  if (session.step === "WAITING_CUSTOM_SERVICE_PRICE") {
    const price = parseMoney(text);
    if (price <= 0) return send(bot, chatId, "El precio debe ser mayor a cero. Escribilo nuevamente:");
    session.customService.precio = price;
    session.serviceIds = [];
    session.services = [{ id: null, nombre: session.customService.nombre, precio_base: price }];
    return askPayment(bot, chatId, session);
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
    if (action === "vehicle" && rawValue === "use") {
      const suggestion = [session.vehicleSuggestion?.make, session.vehicleSuggestion?.model].filter(Boolean).join(" ");
      if (!suggestion) return send(bot, chatId, "Escribi la marca y modelo del auto:");
      session.newClient.marcaModelo = suggestion.toUpperCase();
      return askClientGroup(bot, chatId, session);
    }
    if (action === "vehicle" && rawValue === "edit") {
      return send(bot, chatId, "Escribi la marca y modelo del auto:");
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
      if (rawValue === "custom") {
        session.step = "WAITING_CUSTOM_SERVICE_DESCRIPTION";
        return send(bot, chatId, "Escribi la descripcion del nuevo servicio:");
      }
      const serviceId = Number(rawValue);
      session.serviceIds = [serviceId];
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
