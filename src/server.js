const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const multer = require("multer");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const config = require("./config");
const { query, withTransaction } = require("./db");
const { startTelegramBot } = require("./telegram-bot");

const app = express();
const servicioGrupoUploadsDir = path.join(__dirname, "..", "public", "uploads", "servicio-grupos");
const formasPagoUploadsDir = path.join(__dirname, "..", "public", "uploads", "formas-pago");
fs.mkdirSync(servicioGrupoUploadsDir, { recursive: true });
fs.mkdirSync(formasPagoUploadsDir, { recursive: true });

function publicUploadFolder(field) {
  return field.uploadFolder || "servicio-grupos";
}

function uploadDirForFolder(folder) {
  return path.join(__dirname, "..", "public", "uploads", folder);
}

function safeUploadFilename(originalName) {
  const parsed = path.parse(originalName || "imagen.png");
  const baseName = (parsed.name || "imagen")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imagen";
  return `${baseName}.png`;
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = req.crudImageFolder || "servicio-grupos";
      const targetDir = uploadDirForFolder(folder);
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      cb(null, safeUploadFilename(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (file.mimetype === "image/png" || extension === ".png") return cb(null, true);
    cb(new Error("La imagen debe ser un archivo PNG."));
  }
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/chart.js", express.static(path.join(__dirname, "..", "node_modules", "chart.js", "dist")));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);

app.use(async (req, res, next) => {
  try {
    const authorization = {
      roll: null,
      roleActive: true,
      items: new Map(),
      eventos: new Map()
    };

    if (req.session.user) {
      const [rollResult, permissionsResult] = await Promise.all([
        query(
          `select ur.roll, ur.activo as role_active
           from usuarios u
           left join usuario_roll ur on ur.id = u.usuario_roll_id
           where u.id = $1`,
          [req.session.user.id]
        ),
        query(
          `select ure.codigo_evento,
                  uri.activo as item_activo,
                  coalesce(ure.activo, true) as evento_activo
           from usuario_roll_item uri
           join usuarios u on u.usuario_roll_id = uri.usuario_roll_id
           join usuario_roll_evento ure on ure.id = uri.usuario_roll_evento_id
           where u.id = $1`,
          [req.session.user.id]
        )
      ]);

      authorization.roll = rollResult.rows[0]?.roll || null;
      authorization.roleActive = rollResult.rows[0]?.roll ? rollResult.rows[0].role_active === true : true;
      permissionsResult.rows.forEach((permission) => {
        const itemAllowed = permission.item_activo === true && permission.evento_activo === true;
        if (permission.codigo_evento) {
          authorization.items.set(permission.codigo_evento, itemAllowed);
          authorization.eventos.set(permission.codigo_evento, permission.evento_activo === true);
        }
      });
    }

    req.authorization = authorization;
    next();
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.userRoll = req.authorization?.roll || null;
  res.locals.canItem = (codigo) => permissionAllowed(req.authorization?.items, codigo);
  res.locals.canEvent = (codigo) => permissionAllowed(req.authorization?.eventos, codigo);
  res.locals.appVersion = config.version;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.formatMoney = formatMoney;
  res.locals.formatDate = formatDate;
  res.locals.formatDateInput = formatDateInput;
  res.locals.formatDateTime = formatDateTime;
  res.locals.formatDateTimeShort = formatDateTimeShort;
  res.locals.formatTime = formatTime;
  res.locals.paymentIconLabel = paymentIconLabel;
  res.locals.facturaSendEstadoLabel = facturaSendEstadoLabel;
  next();
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function userErrorMessage(error) {
  if (error && error.code === "23505") {
    const uniqueMessages = {
      servicios_nombre_key: "Ya existe un servicio con ese nombre.",
      servicios_grupo_nombre_key: "Ya existe un servicio con ese nombre dentro del mismo grupo.",
      servicio_grupo_nombre_key: "Ya existe un grupo de servicio con ese nombre.",
      clientes_chapa_key: "Ya existe un cliente con esa chapa.",
      personal_nombre_key: "Ya existe un personal con ese nombre.",
      grupo_cliente_nombre_key: "Ya existe un grupo de cliente con ese nombre.",
      formas_pago_nombre_key: "Ya existe una forma de pago con ese nombre.",
      gasto_tipo_nombre_key: "Ya existe un tipo de gasto con ese nombre.",
      usuarios_login_key: "Ya existe un usuario con ese login.",
      usuario_roll_roll_key: "Ya existe ese rol.",
      usuario_roll_evento_codigo_key: "Ya existe ese evento para el rol seleccionado."
    };
    return uniqueMessages[error.constraint] || "Ya existe un registro con esos datos.";
  }
  return error.message;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (req.authorization && req.authorization.roleActive === false) {
    return req.session.destroy(() => res.redirect("/login"));
  }
  next();
}

function permissionAllowed(permissions, code) {
  if (!permissions || !permissions.has(code)) return true;
  return permissions.get(code) === true;
}

function requirePermission(type, code) {
  return (req, res, next) => {
    const permissions = req.authorization?.[type];
    if (permissionAllowed(permissions, code)) return next();
    return res.status(403).render("error", {
      title: "Acceso bloqueado",
      message: `No tiene permiso para realizar esta acción (${code}).`
    });
  };
}

function requireItem(code) {
  return requirePermission("items", code);
}

function requireEvent(code) {
  return requirePermission("eventos", code);
}

function currentUser(req) {
  return req.session.user ? req.session.user.nombre : "Sistema";
}

function toMoney(value) {
  const raw = String(value || "0").trim().replace(/[^\d.,-]/g, "");
  let normalized = raw;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSeparator = lastDot > lastComma ? "." : ",";
    const thousandsSeparator = decimalSeparator === "." ? "," : ".";
    normalized = raw.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
  } else if (lastDot >= 0) {
    const decimals = raw.length - lastDot - 1;
    normalized = decimals === 3 ? raw.replace(/\./g, "") : raw;
  } else if (lastComma >= 0) {
    const decimals = raw.length - lastComma - 1;
    normalized = decimals === 3 ? raw.replace(/,/g, "") : raw.replace(",", ".");
  }

  const number = Number(normalized || 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function toUpperOrNull(value) {
  const text = String(value || "").trim().toUpperCase();
  return text || null;
}

function normalizeRucInput(value) {
  const text = String(value || "").trim().replace(/\s+/g, "").replace(/[.,]/g, "");
  if (/^\d{2,9}$/.test(text) && text.length > 8) {
    return `${text.slice(0, -1)}-${text.slice(-1)}`;
  }
  return text;
}

function isBasicRuc(value) {
  return /^\d{1,8}(?:-\d)?$/.test(value);
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-PY", {
    style: "currency",
    currency: "PYG",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function dateParts(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      day: value.getDate(),
      month: value.getMonth() + 1,
      year: value.getFullYear(),
      hour: value.getHours(),
      minute: value.getMinutes()
    };
  }

  const text = String(value).trim();
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    return {
      day: Number(dateOnlyMatch[3]),
      month: Number(dateOnlyMatch[2]),
      year: Number(dateOnlyMatch[1]),
      hour: 0,
      minute: 0
    };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: date.getDate(),
    month: date.getMonth() + 1,
    year: date.getFullYear(),
    hour: date.getHours(),
    minute: date.getMinutes()
  };
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${padDatePart(parts.day)}-${padDatePart(parts.month)}-${parts.year} ${padDatePart(parts.hour)}:${padDatePart(parts.minute)}`;
}

function formatDateTimeShort(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${padDatePart(parts.day)}/${padDatePart(parts.month)}/${String(parts.year).slice(-2)} ${padDatePart(parts.hour)}:${padDatePart(parts.minute)}`;
}

function formatDate(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${padDatePart(parts.day)}-${padDatePart(parts.month)}-${parts.year}`;
}

function formatDateInput(value) {
  const parts = dateParts(value);
  if (!parts) return todayIso();
  return `${parts.year}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`;
}

function formatTime(value) {
  const parts = dateParts(value);
  if (!parts) return "";
  return `${padDatePart(parts.hour)}:${padDatePart(parts.minute)}`;
}

function paymentIconLabel(iconName) {
  const icons = {
    "car-wash": "AUTO",
    "dollar-broken": "$/",
    dollar: "$",
    bank: "BANK",
    card: "CARD",
    cross: "X"
  };
  return icons[iconName] || "PAGO";
}

function estadoPorFormaPago(nombreFormaPago) {
  if (nombreFormaPago === "LAVADO") return "EMITIDO";
  if (nombreFormaPago === "CREDITO") return "CREDITO";
  return "PAGADO";
}

function formasPagoOrderSql(alias) {
  const prefix = alias ? `${alias}.` : "";
  return `case ${prefix}nombre
    when 'LAVADO' then 1
    when 'CREDITO' then 2
    when 'EFECTIVO' then 3
    when 'TRANSFERENCIA' then 4
    when 'TARJETA_DEBITO' then 5
    when 'TARJETA_CREDITO' then 6
    when 'ANULADO' then 7
    else 99
  end, ${prefix}nombre`;
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function safeDownloadName(value) {
  return String(value || "reporte")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "reporte";
}

function encryptionKey() {
  if (!config.sessionSecret || config.sessionSecret.length < 8) {
    throw new Error("Configure SESSION_SECRET para guardar credenciales.");
  }
  return crypto.createHash("sha256").update(config.sessionSecret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const [ivText, tagText, encryptedText] = String(value || "").split(":");
  if (!ivText || !tagText || !encryptedText) throw new Error("Credencial invalida.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return `${"*".repeat(Math.max(8, Math.min(16, text.length - 4)))}${text.slice(-4)}`;
}

function facturaSendBearer(value) {
  const apiKey = String(value || "").trim();
  return apiKey.startsWith("api_key_") ? apiKey : `api_key_${apiKey}`;
}

function normalizeBaseUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("URL de FacturaSend invalida.");
  return url;
}

function jsonOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function facturaSendEstadoLabel(value) {
  const labels = {
    "-1": "Borrador",
    0: "Generado",
    1: "En lote",
    2: "Aprobado",
    3: "Aprobado obs.",
    4: "Rechazado",
    98: "Inexistente",
    99: "Cancelado"
  };
  if (value === undefined || value === null || value === "") return "Generado";
  return labels[String(value)] || String(value);
}

function normalizeFacturaSendConfig(row) {
  if (!row) return null;
  let apiKey = "";
  try {
    apiKey = decryptSecret(row.api_key_encrypted);
  } catch (error) {
    throw new Error("No se pudo leer la API Key guardada.");
  }
  return {
    ...row,
    api_key: apiKey,
    api_key_masked: maskSecret(apiKey),
    base_url: normalizeBaseUrl(row.base_url),
    params: jsonOrEmpty(row.params),
    ambiente: jsonOrEmpty(row.ambiente),
    config_set_api: jsonOrEmpty(row.config_set_api),
    kude_params: jsonOrEmpty(row.kude_params)
  };
}

async function getFacturaSendConfig() {
  const result = await query(
    `select *
     from facturasend_config
     where activo = true
     order by id desc
     limit 1`
  );
  return normalizeFacturaSendConfig(result.rows[0]);
}

async function facturaSendRequest(configRow, method, endpoint, body) {
  const response = await fetch(`${configRow.base_url}/${encodeURIComponent(configRow.tenant)}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${facturaSendBearer(configRow.api_key)}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    const message = typeof payload === "string" ? payload : (payload.error || payload.message || "FacturaSend rechazo la solicitud.");
    const error = new Error(message);
    error.responsePayload = payload;
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function splitRuc(ruc) {
  const [numero, dv] = String(ruc || "").split("-");
  return { numero: numero || "", dv: dv || "" };
}

function facturaSendClientCode(factura) {
  const raw = factura.cliente_id ? String(factura.cliente_id) : String(factura.id);
  return raw.padStart(3, "0").slice(-15);
}

function facturaSendErrorMessage(response) {
  if (!response) return "FacturaSend no devolvio respuesta.";
  if (response.error) return response.error;
  if (Array.isArray(response.errores) && response.errores[0]) return response.errores[0].error || "FacturaSend devolvio errores.";
  return "FacturaSend no pudo generar el documento electronico.";
}

function buildFacturaSendPayload(factura, items) {
  if (!factura.cliente_nombre) throw new Error("La factura necesita nombre del cliente.");
  if (!factura.cliente_ruc) throw new Error("La factura necesita RUC del cliente.");
  if (!items.length) throw new Error("La factura necesita al menos un item.");
  const rucParts = splitRuc(factura.cliente_ruc);
  return [{
    tipoDocumento: 1,
    establecimiento: 1,
    punto: "001",
    numero: Number(factura.id),
    descripcion: `Factura lavadero #${factura.id}`,
    observacion: "Generado desde sistema Lavadero",
    fecha: `${formatDateInput(factura.fecha_emision)}T12:00:00`,
    tipoEmision: 1,
    tipoTransaccion: 1,
    tipoImpuesto: 1,
    moneda: "PYG",
    cliente: {
      contribuyente: true,
      ruc: factura.cliente_ruc,
      razonSocial: factura.cliente_nombre,
      nombreFantasia: factura.cliente_nombre,
      tipoOperacion: 1,
      direccion: factura.cliente_direccion || "SIN DIRECCION",
      numeroCasa: "0",
      ciudad: 1,
      ciudadDescripcion: "ASUNCION (DISTRITO)",
      pais: "PRY",
      paisDescripcion: "Paraguay",
      tipoContribuyente: 1,
      documentoTipo: 1,
      documentoNumero: rucParts.numero,
      codigo: facturaSendClientCode(factura)
    },
    factura: {
      presencia: 1
    },
    condicion: {
      tipo: 1,
      entregas: [{
        tipo: 1,
        monto: String(Math.round(Number(factura.total || 0))),
        moneda: "PYG",
        monedaDescripcion: "Guarani",
        cambio: 0
      }]
    },
    items: items.map((item, index) => ({
      codigo: item.servicio_id ? String(item.servicio_id) : `ITEM-${index + 1}`,
      descripcion: item.descripcion,
      unidadMedida: 77,
      cantidad: Number(item.cantidad || 1),
      precioUnitario: Math.round(Number(item.precio_unitario || 0)),
      cambio: 0,
      ivaTipo: 1,
      ivaBase: 100,
      iva: 10
    }))
  }];
}

function ensurePdfSpace(doc, neededHeight) {
  if (doc.y + neededHeight <= doc.page.height - doc.page.margins.bottom) return;
  doc.addPage();
}

function drawPdfRow(doc, columns, values, options = {}) {
  const startY = doc.y;
  const fontSize = options.fontSize || 9;
  const padding = options.padding || 6;
  const lineGap = 2;
  doc.font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);

  const heights = columns.map((column, index) => {
    const text = String(values[index] || "");
    return doc.heightOfString(text, {
      width: column.width - padding * 2,
      lineGap
    }) + padding * 2;
  });
  const rowHeight = Math.max(options.minHeight || 24, ...heights);
  ensurePdfSpace(doc, rowHeight);

  const y = doc.y;
  if (options.background) {
    doc.rect(columns[0].x, y, columns.reduce((total, column) => total + column.width, 0), rowHeight)
      .fillColor(options.background)
      .fill();
  }
  columns.forEach((column, index) => {
    const x = column.x;
    doc.rect(x, y, column.width, rowHeight).strokeColor(options.borderColor || "#dce1e8").stroke();
    doc.fillColor(options.color || "#17202a").text(String(values[index] || ""), x + padding, y + padding, {
      width: column.width - padding * 2,
      lineGap,
      align: column.align || "left"
    });
  });
  doc.y = y + rowHeight;
  return doc.y - startY;
}

function drawPdfInfoCard(doc, x, y, width, title, value, color = "#17202a") {
  doc.roundedRect(x, y, width, 40, 6).fillColor("#f6f7f9").fill();
  doc.roundedRect(x, y, width, 40, 6).strokeColor("#dce1e8").stroke();
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#687385").text(String(title || "").toUpperCase(), x + 8, y + 7, {
    width: width - 20
  });
  doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(String(value || ""), x + 8, y + 22, {
    width: width - 16,
    ellipsis: true
  });
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function splitCommission(total, count) {
  const amount = Math.round(Number(total || 0) * 100);
  const base = Math.floor(amount / count);
  const remainder = amount - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index === 0 ? remainder : 0)) / 100);
}

function redirectLavadosWithForm(req, res, message) {
  req.session.lavadoForm = req.body;
  setFlash(req, "error", message);
  return res.redirect("/lavados");
}

async function getActiveMasterData() {
  const [clientes, personal, servicios, formasPago, grupos, servicioGrupos] = await Promise.all([
    query(`select c.*, g.nombre as grupo_nombre
           from clientes c
           left join grupo_cliente g on g.id = c.grupo_cliente_id
           where c.activo = true
           order by c.id desc
           limit 100`),
    query(`select * from personal where activo = true order by nombre`),
    query(
      `select s.*, sg.nombre as grupo_nombre, sg.imagen as grupo_imagen
       from servicios s
       left join servicio_grupo sg on sg.id = s.servicio_grupo_id
       where s.activo = true
       order by sg.nombre nulls last, s.nombre`
    ),
    query(`select * from formas_pago where activo = true order by ${formasPagoOrderSql()}`),
    query(`select * from grupo_cliente where activo = true order by nombre`),
    query(`select * from servicio_grupo where activo = true order by nombre`)
  ]);
  return {
    clientes: clientes.rows,
    personal: personal.rows,
    servicios: servicios.rows,
    formasPago: formasPago.rows,
    grupos: grupos.rows,
    servicioGrupos: servicioGrupos.rows
  };
}

async function applyCommission(client, lavado, sign, creadoPor) {
  const fechaResult = await client.query(`select creado_en::date as fecha from lavados where id = $1`, [lavado.id]);
  const fecha = fechaResult.rows[0].fecha;
  const relations = await client.query(
    `select personal_id, comision from lavado_personal where lavado_id = $1 order by id`,
    [lavado.id]
  );
  if (!relations.rows.length) return;
  const serviceShares = splitCommission(lavado.total, relations.rows.length);
  const count = sign > 0 ? 1 : -1;
  for (const [index, relation] of relations.rows.entries()) {
    await client.query(
      `insert into comisiones_diarias
         (fecha, personal_id, total_lavados_emitidos, total_servicios, total_comision_40, creado_por)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (fecha, personal_id) do update set
         total_lavados_emitidos = greatest(0, comisiones_diarias.total_lavados_emitidos + excluded.total_lavados_emitidos),
         total_servicios = greatest(0, comisiones_diarias.total_servicios + excluded.total_servicios),
         total_comision_40 = greatest(0, comisiones_diarias.total_comision_40 + excluded.total_comision_40)`,
      [fecha, relation.personal_id, count, serviceShares[index] * sign, Number(relation.comision) * sign, creadoPor]
    );
  }
}

async function applyVale(client, vale, sign, creadoPor) {
  const monto = Number(vale.monto || 0) * sign;
  await client.query(
    `insert into comisiones_diarias
       (fecha, personal_id, total_lavados_emitidos, total_servicios, total_comision_40, total_vales, creado_por)
     values ($1, $2, 0, 0, 0, $3, $4)
     on conflict (fecha, personal_id) do update set
       total_vales = greatest(0, comisiones_diarias.total_vales + excluded.total_vales)`,
    [vale.fecha_pago, vale.personal_id, monto, creadoPor]
  );
}

async function ensureOpenGrupoCredito(client, grupoClienteId, creadoPor) {
  await client.query(`lock table grupo_cliente_creditos in share row exclusive mode`);
  const open = await client.query(
    `select id
     from grupo_cliente_creditos
     where grupo_cliente_id = $1
       and estado = 'ABIERTO'
     limit 1`,
    [grupoClienteId]
  );
  if (open.rows[0]) return open.rows[0].id;

  const created = await client.query(
    `insert into grupo_cliente_creditos (grupo_cliente_id, estado, fecha_inicio, creado_por)
     values ($1, 'ABIERTO', current_date, $2)
     returning id`,
    [grupoClienteId, creadoPor]
  );
  return created.rows[0].id;
}

async function getGrupoCreditoDetail(creditoId) {
  const credito = await query(
    `select gcc.*, g.nombre as grupo_nombre, fp.nombre as forma_pago,
            fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color,
            count(l.id) filter (where l.estado <> 'ANULADO') as lavados_count,
            coalesce(sum(l.total) filter (where l.estado <> 'ANULADO'), 0) as total
     from grupo_cliente_creditos gcc
     join grupo_cliente g on g.id = gcc.grupo_cliente_id
     left join formas_pago fp on fp.id = gcc.forma_pago_id
     left join lavados l on l.grupo_cliente_credito_id = gcc.id
     where gcc.id = $1
     group by gcc.id, g.nombre, fp.nombre, fp.icono_ruta, fp.color`,
    [creditoId]
  );
  if (!credito.rows[0]) return null;

  const lavados = await query(
    `select l.*, c.chapa, c.marca_modelo, c.ruc, c.nombre as cliente_nombre,
            coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
            coalesce((select string_agg(s2.nombre || ' (Gs. ' || replace(to_char(round(ls2.precio), 'FM999,999,999,999'), ',', '.') || ')', ', ' order by ls2.id)
                      from lavado_servicios ls2
                      join servicios s2 on s2.id = ls2.servicio_id
                      where ls2.lavado_id = l.id), '') as servicios
     from lavados l
     join clientes c on c.id = l.cliente_id
     left join lavado_personal lp on lp.lavado_id = l.id
     left join personal p on p.id = lp.personal_id
     where l.grupo_cliente_credito_id = $1
       and l.estado <> 'ANULADO'
     group by l.id, c.chapa, c.marca_modelo, c.ruc, c.nombre
     order by l.creado_en, l.id`,
    [creditoId]
  );

  return { credito: credito.rows[0], lavados: lavados.rows };
}

function emptyCajaResumen() {
  return {
    ingresos: 0,
    egresos: 0,
    neto: 0,
    efectivoIngresos: 0,
    efectivoEgresos: 0,
    efectivoAContar: 0
  };
}

function addCajaForma(formas, forma, tipo, monto) {
  const formaId = String(forma.forma_pago_id || forma.id || "");
  if (!formaId) return;
  if (!formas[formaId]) {
    formas[formaId] = {
      forma_pago_id: formaId,
      forma_pago: forma.forma_pago || forma.nombre || "",
      forma_pago_icono: forma.forma_pago_icono || forma.icono_ruta || "",
      forma_pago_color: forma.forma_pago_color || forma.color || "",
      ingresos: 0,
      egresos: 0,
      neto: 0
    };
  }
  formas[formaId][tipo] += monto;
  formas[formaId].neto = formas[formaId].ingresos - formas[formaId].egresos;
}

async function getCajaDia(fecha) {
  const [lavadosResult, creditosResult, gastosResult, valesResult] = await Promise.all([
    query(
      `select l.*, c.chapa, c.marca_modelo, c.nombre as cliente_nombre,
              coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
              fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
       from lavados l
       join clientes c on c.id = l.cliente_id
       left join lavado_personal lp on lp.lavado_id = l.id
       left join personal p on p.id = lp.personal_id
       join formas_pago fp on fp.id = l.forma_pago_id
       where l.creado_en::date = $1
         and l.estado <> 'ANULADO'
         and l.condicion = 'CONTADO'
         and l.grupo_cliente_credito_id is null
       group by l.id, c.chapa, c.marca_modelo, c.nombre, fp.nombre, fp.icono_ruta, fp.color
       order by l.id desc`,
      [fecha]
    ),
    query(
      `select gcc.*, g.nombre as grupo_nombre,
              fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color,
              count(l.id) filter (where l.estado <> 'ANULADO') as lavados_count,
              coalesce(sum(l.total) filter (where l.estado <> 'ANULADO'), 0) as total
       from grupo_cliente_creditos gcc
       join grupo_cliente g on g.id = gcc.grupo_cliente_id
       join formas_pago fp on fp.id = gcc.forma_pago_id
       left join lavados l on l.grupo_cliente_credito_id = gcc.id
       where gcc.estado = 'PAGADO'
         and gcc.pagado_en::date = $1
       group by gcc.id, g.nombre, fp.nombre, fp.icono_ruta, fp.color
       order by gcc.pagado_en desc, gcc.id desc`,
      [fecha]
    ),
    query(
      `select g.*, gt.nombre as gasto_tipo_nombre,
              fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
       from gastos g
       join gasto_tipo gt on gt.id = g.gasto_tipo_id
       join formas_pago fp on fp.id = g.forma_pago_id
       where g.fecha_gasto = $1
         and g.estado <> 'ANULADO'
       order by g.id desc`,
      [fecha]
    ),
    query(
      `select v.*, p.nombre as personal_nombre,
              fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
       from vales_personal v
       join personal p on p.id = v.personal_id
       join formas_pago fp on fp.id = v.forma_pago_id
       where v.fecha_pago = $1
         and v.estado <> 'ANULADO'
       order by v.id desc`,
      [fecha]
    )
  ]);

  const resumen = emptyCajaResumen();
  const formas = {};

  lavadosResult.rows.forEach((lavado) => {
    const monto = Number(lavado.total || 0);
    resumen.ingresos += monto;
    addCajaForma(formas, lavado, "ingresos", monto);
  });

  creditosResult.rows.forEach((credito) => {
    const monto = Number(credito.total || 0);
    resumen.ingresos += monto;
    addCajaForma(formas, credito, "ingresos", monto);
  });

  gastosResult.rows.forEach((gasto) => {
    const monto = Number(gasto.monto || 0);
    resumen.egresos += monto;
    addCajaForma(formas, gasto, "egresos", monto);
  });

  valesResult.rows.forEach((vale) => {
    const monto = Number(vale.monto || 0);
    resumen.egresos += monto;
    addCajaForma(formas, vale, "egresos", monto);
  });

  Object.values(formas).forEach((forma) => {
    if (String(forma.forma_pago || "").toUpperCase() === "EFECTIVO") {
      resumen.efectivoIngresos += forma.ingresos;
      resumen.efectivoEgresos += forma.egresos;
    }
  });
  resumen.neto = resumen.ingresos - resumen.egresos;
  resumen.efectivoAContar = resumen.efectivoIngresos - resumen.efectivoEgresos;

  return {
    resumen,
    formas: Object.values(formas).sort((a, b) => a.forma_pago.localeCompare(b.forma_pago)),
    lavados: lavadosResult.rows,
    creditos: creditosResult.rows,
    gastos: gastosResult.rows,
    vales: valesResult.rows
  };
}

function facturaIva10(total) {
  return Math.round(Number(total || 0) / 11);
}

function normalizeFacturaItem(item, creadoPor) {
  const cantidad = Math.max(0, Number(String(item.cantidad || "1").replace(",", ".")) || 0);
  const precioUnitario = toMoney(item.precio_unitario);
  const total = Math.round(cantidad * precioUnitario);
  return {
    servicio_id: item.servicio_id ? Number(item.servicio_id) : null,
    descripcion: String(item.descripcion || "").trim().toUpperCase(),
    cantidad,
    precio_unitario: precioUnitario,
    exenta: 0,
    iva_5: 0,
    iva_10: facturaIva10(total),
    total,
    creado_por: creadoPor
  };
}

function normalizeFacturaItems(body, creadoPor) {
  const servicioIds = normalizeArray(body.servicio_id);
  const descripciones = normalizeArray(body.descripcion);
  const cantidades = normalizeArray(body.cantidad);
  const precios = normalizeArray(body.precio_unitario);
  const maxRows = Math.max(servicioIds.length, descripciones.length, cantidades.length, precios.length);
  if (maxRows > 9) throw new Error("La factura permite hasta 9 items.");

  const items = [];
  for (let index = 0; index < maxRows; index += 1) {
    const item = normalizeFacturaItem({
      servicio_id: servicioIds[index] || "",
      descripcion: descripciones[index] || "",
      cantidad: cantidades[index] || "1",
      precio_unitario: precios[index] || "0"
    }, creadoPor);
    if (!item.descripcion && !item.servicio_id && !item.total) continue;
    if (!item.descripcion) throw new Error("Cada item debe tener descripcion.");
    if (item.cantidad <= 0) throw new Error("Cada item debe tener cantidad mayor a cero.");
    if (item.precio_unitario <= 0) throw new Error("Cada item debe tener precio mayor a cero.");
    items.push(item);
  }
  if (!items.length) throw new Error("Ingrese al menos un item.");
  return items;
}

function facturaTotals(items) {
  const total = items.reduce((sum, item) => sum + Number(item.total || 0), 0);
  return {
    subtotal: total,
    iva_10: facturaIva10(total),
    total
  };
}

async function getFacturaServicios() {
  const result = await query(
    `select s.id, s.nombre, s.precio_base, sg.nombre as grupo_nombre
     from servicios s
     left join servicio_grupo sg on sg.id = s.servicio_grupo_id
     where s.activo = true
     order by sg.nombre nulls last, s.nombre`
  );
  return result.rows;
}

async function getFacturaById(id) {
  const factura = await query(`select * from facturas where id = $1`, [id]);
  if (!factura.rows[0]) return null;
  const items = await query(
    `select fi.*, s.nombre as servicio_nombre
     from factura_items fi
     left join servicios s on s.id = fi.servicio_id
     where fi.factura_id = $1
     order by fi.id`,
    [id]
  );
  return { factura: factura.rows[0], items: items.rows };
}

async function buildFacturaFromLavado(lavadoId) {
  const lavado = await query(
    `select l.*, c.id as cliente_id, c.nombre as cliente_nombre, c.ruc as cliente_ruc,
            c.direccion as cliente_direccion, c.chapa, c.marca_modelo
     from lavados l
     join clientes c on c.id = l.cliente_id
     where l.id = $1`,
    [lavadoId]
  );
  if (!lavado.rows[0]) throw new Error("Lavado no encontrado.");
  const servicios = await query(
    `select ls.servicio_id, s.nombre as descripcion, 1 as cantidad, ls.precio as precio_unitario
     from lavado_servicios ls
     join servicios s on s.id = ls.servicio_id
     where ls.lavado_id = $1
     order by ls.id`,
    [lavadoId]
  );
  const creadoPor = "Sistema";
  const items = servicios.rows.map((item) => normalizeFacturaItem(item, creadoPor));
  const totals = facturaTotals(items);
  return {
    factura: {
      id: null,
      numero: "",
      fecha_emision: todayIso(),
      cliente_id: lavado.rows[0].cliente_id,
      lavado_id: lavado.rows[0].id,
      cliente_nombre: lavado.rows[0].cliente_nombre || lavado.rows[0].marca_modelo || "SIN NOMBRE",
      cliente_ruc: lavado.rows[0].cliente_ruc || "",
      cliente_direccion: lavado.rows[0].cliente_direccion || "",
      condicion: "CONTADO",
      origen: "LAVADO",
      ...totals
    },
    items
  };
}

async function saveFactura(req, facturaId) {
  const creadoPor = currentUser(req);
  const items = normalizeFacturaItems(req.body, creadoPor);
  const totals = facturaTotals(items);
  const clienteId = req.body.cliente_id ? Number(req.body.cliente_id) : null;
  const lavadoId = req.body.lavado_id ? Number(req.body.lavado_id) : null;
  const origen = req.body.origen === "LAVADO" ? "LAVADO" : "LIBRE";
  const clienteNombre = String(req.body.cliente_nombre || "").trim().toUpperCase();
  if (!clienteNombre) throw new Error("Ingrese nombre del cliente.");
  const clienteRuc = String(req.body.cliente_ruc || "").trim().toUpperCase();
  if (!clienteRuc) throw new Error("Ingrese RUC del cliente.");

  return withTransaction(async (client) => {
    let savedId = facturaId ? Number(facturaId) : null;
    if (savedId) {
      await client.query(
        `update facturas
         set numero = $1,
             fecha_emision = $2,
             cliente_id = $3,
             lavado_id = $4,
             cliente_nombre = $5,
             cliente_ruc = $6,
             cliente_direccion = $7,
             subtotal = $8,
             iva_10 = $9,
             total = $10,
             origen = $11
         where id = $12`,
        [
          String(req.body.numero || "").trim() || null,
          req.body.fecha_emision || todayIso(),
          clienteId,
          lavadoId,
          clienteNombre,
          clienteRuc,
          toUpperOrNull(req.body.cliente_direccion),
          totals.subtotal,
          totals.iva_10,
          totals.total,
          origen,
          savedId
        ]
      );
      await client.query(`delete from factura_items where factura_id = $1`, [savedId]);
    } else {
      const created = await client.query(
        `insert into facturas
           (numero, fecha_emision, cliente_id, lavado_id, cliente_nombre, cliente_ruc,
            cliente_direccion, subtotal, iva_10, total, origen, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          String(req.body.numero || "").trim() || null,
          req.body.fecha_emision || todayIso(),
          clienteId,
          lavadoId,
          clienteNombre,
          clienteRuc,
          toUpperOrNull(req.body.cliente_direccion),
          totals.subtotal,
          totals.iva_10,
          totals.total,
          origen,
          creadoPor
        ]
      );
      savedId = created.rows[0].id;
    }

    for (const item of items) {
      await client.query(
        `insert into factura_items
           (factura_id, servicio_id, descripcion, cantidad, precio_unitario, exenta, iva_5, iva_10, total, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          savedId,
          item.servicio_id,
          item.descripcion,
          item.cantidad,
          item.precio_unitario,
          item.exenta,
          item.iva_5,
          item.iva_10,
          item.total,
          creadoPor
        ]
      );
    }
    return savedId;
  });
}

function numeroALetras(value) {
  const units = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
  const teens = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
  const tens = ["", "", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const hundreds = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];
  function underThousand(number) {
    if (number === 0) return "";
    if (number === 100) return "CIEN";
    const h = Math.floor(number / 100);
    const r = number % 100;
    const parts = [];
    if (h) parts.push(hundreds[h]);
    if (r >= 10 && r < 20) parts.push(teens[r - 10]);
    else if (r >= 20) {
      const t = Math.floor(r / 10);
      const u = r % 10;
      parts.push(u ? `${tens[t]} Y ${units[u]}` : tens[t]);
    } else if (r) parts.push(units[r]);
    return parts.join(" ");
  }
  const number = Math.max(0, Math.round(Number(value || 0)));
  if (!number) return "CERO GUARANIES";
  const millions = Math.floor(number / 1000000);
  const thousands = Math.floor((number % 1000000) / 1000);
  const rest = number % 1000;
  const parts = [];
  if (millions) parts.push(millions === 1 ? "UN MILLON" : `${underThousand(millions)} MILLONES`);
  if (thousands) parts.push(thousands === 1 ? "MIL" : `${underThousand(thousands)} MIL`);
  if (rest) parts.push(underThousand(rest));
  return `${parts.join(" ")} GUARANIES`;
}

function plainNumber(value) {
  return new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { title: "Ingreso" });
});

app.post("/login", async (req, res, next) => {
  try {
    const result = await query(
      `select u.*, ur.roll
       from usuarios u
       left join usuario_roll ur on ur.id = u.usuario_roll_id
       where u.login = $1
         and u.activo = true
         and (ur.id is null or ur.activo = true)`,
      [req.body.login]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password || "", user.password_hash))) {
      setFlash(req, "error", "Usuario o clave incorrectos.");
      return res.redirect("/login");
    }
    req.session.user = { id: user.id, login: user.login, nombre: user.nombre, roll: user.roll || null };
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const [caja, resumen, comisiones, ultimos] = await Promise.all([
      getCajaDia(fecha),
      query(
        `select
          count(*) filter (where estado = 'EMITIDO') as emitidos,
          count(*) filter (where estado = 'PAGADO') as pagados,
          count(*) filter (where estado = 'ANULADO') as anulados,
          count(*) filter (where estado = 'CREDITO') as creditos,
          coalesce(sum(total) filter (where estado <> 'ANULADO'), 0) as total,
          coalesce(sum(comision_personal) filter (where estado <> 'ANULADO'), 0) as comision,
          coalesce(sum(saldo_lavadero) filter (where estado <> 'ANULADO'), 0) as saldo
         from lavados
         where creado_en::date = $1`,
        [fecha]
      ),
      query(
        `select cd.*, p.nombre as personal_nombre
         from comisiones_diarias cd
         join personal p on p.id = cd.personal_id
         where cd.fecha = $1
         order by p.nombre`,
        [fecha]
      ),
      query(
        `select l.*, c.chapa, c.marca_modelo,
                coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from lavados l
         join clientes c on c.id = l.cliente_id
         left join lavado_personal lp on lp.lavado_id = l.id
         left join personal p on p.id = lp.personal_id
         join formas_pago fp on fp.id = l.forma_pago_id
         where l.creado_en::date = $1
         group by l.id, c.chapa, c.marca_modelo, fp.nombre, fp.icono_ruta, fp.color
         order by l.id desc
         limit 8`,
        [fecha]
      )
    ]);
    res.render("dashboard", {
      title: "Inicio",
      fecha,
      caja,
      resumen: resumen.rows[0],
      comisiones: comisiones.rows,
      ultimos: ultimos.rows
    });
  } catch (error) {
    next(error);
  }
});

app.get("/caja", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const caja = await getCajaDia(fecha);
    res.render("caja", { title: "Caja", fecha, caja });
  } catch (error) {
    next(error);
  }
});

app.get("/analisis-lavados", requireAuth, async (req, res, next) => {
  try {
    let fechaInicio = req.query.fecha_inicio || todayIso();
    let fechaFin = req.query.fecha_fin || fechaInicio;
    if (fechaFin < fechaInicio) {
      const fechaTemp = fechaInicio;
      fechaInicio = fechaFin;
      fechaFin = fechaTemp;
    }
    const params = [fechaInicio, fechaFin];
    const [
      metricsResult,
      dailyResult,
      paymentsResult,
      servicesResult,
      serviceGroupsResult,
      clientGroupsResult,
      personalResult,
      latestResult
    ] = await Promise.all([
      query(
        `select
           count(*) filter (where l.estado <> 'ANULADO')::int as lavados,
           coalesce(sum(l.total) filter (where l.estado <> 'ANULADO'), 0) as total_servicios,
           coalesce(sum(l.comision_personal) filter (where l.estado <> 'ANULADO'), 0) as comision,
           coalesce(sum(l.saldo_lavadero) filter (where l.estado <> 'ANULADO'), 0) as saldo_lavadero,
           count(*) filter (where l.estado = 'CREDITO')::int as creditos_pendientes,
           count(*) filter (where l.estado = 'ANULADO')::int as anulados,
           (select count(*)::int from clientes c where c.creado_en::date between $1 and $2) as clientes_nuevos
         from lavados l
         where l.creado_en::date between $1 and $2`,
        params
      ),
      query(
        `select l.creado_en::date as fecha,
                count(*)::int as lavados,
                coalesce(sum(l.total), 0) as total_servicios,
                coalesce(sum(l.comision_personal), 0) as comision
         from lavados l
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by l.creado_en::date
         order by fecha`,
        params
      ),
      query(
        `select fp.nombre,
                fp.icono_ruta,
                fp.color,
                count(l.id)::int as cantidad,
                coalesce(sum(l.total), 0) as total
         from lavados l
         join formas_pago fp on fp.id = l.forma_pago_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by fp.id, fp.nombre, fp.icono_ruta, fp.color
         order by total desc, cantidad desc, fp.nombre`,
        params
      ),
      query(
        `select s.nombre,
                count(ls.id)::int as cantidad,
                coalesce(sum(ls.precio), 0) as total
         from lavado_servicios ls
         join lavados l on l.id = ls.lavado_id
         join servicios s on s.id = ls.servicio_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by s.id, s.nombre
         order by cantidad desc, total desc, s.nombre
         limit 12`,
        params
      ),
      query(
        `select coalesce(sg.nombre, 'Sin grupo') as nombre,
                count(ls.id)::int as cantidad,
                coalesce(sum(ls.precio), 0) as total
         from lavado_servicios ls
         join lavados l on l.id = ls.lavado_id
         join servicios s on s.id = ls.servicio_id
         left join servicio_grupo sg on sg.id = s.servicio_grupo_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by coalesce(sg.nombre, 'Sin grupo')
         order by cantidad desc, total desc, nombre`,
        params
      ),
      query(
        `select coalesce(gc.nombre, 'Sin grupo') as nombre,
                count(l.id)::int as cantidad,
                coalesce(sum(l.total), 0) as total
         from lavados l
         join clientes c on c.id = l.cliente_id
         left join grupo_cliente gc on gc.id = c.grupo_cliente_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by coalesce(gc.nombre, 'Sin grupo')
         order by total desc, cantidad desc, nombre`,
        params
      ),
      query(
        `with reparto as (
           select l.id as lavado_id, l.total, lp.personal_id,
                  count(*) over (partition by lp.lavado_id) as cantidad,
                  row_number() over (partition by lp.lavado_id order by lp.id) as posicion,
                  lp.comision
           from lavados l
           join lavado_personal lp on lp.lavado_id = l.id
           where l.creado_en::date between $1 and $2
             and l.estado <> 'ANULADO'
         )
         select p.nombre,
                count(r.lavado_id)::int as lavados,
                coalesce(sum((floor(round(r.total * 100) / r.cantidad) + case when r.posicion = 1 then mod(round(r.total * 100), r.cantidad) else 0 end) / 100.0), 0) as total_servicios,
                coalesce(sum(r.comision), 0) as comision
         from reparto r
         join personal p on p.id = r.personal_id
         group by p.id, p.nombre
         order by lavados desc, total_servicios desc, p.nombre`,
        params
      ),
      query(
        `select l.*, c.chapa, c.marca_modelo, c.nombre as cliente_nombre,
                coalesce(gc.nombre, 'Sin grupo') as grupo_cliente_nombre,
                coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from lavados l
         join clientes c on c.id = l.cliente_id
         left join grupo_cliente gc on gc.id = c.grupo_cliente_id
         left join lavado_personal lp on lp.lavado_id = l.id
         left join personal p on p.id = lp.personal_id
         join formas_pago fp on fp.id = l.forma_pago_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
         group by l.id, c.chapa, c.marca_modelo, c.nombre, gc.nombre, fp.nombre, fp.icono_ruta, fp.color
         order by l.creado_en desc, l.id desc
         limit 100`,
        params
      )
    ]);
    const metrics = metricsResult.rows[0] || {};
    metrics.lavados = Number(metrics.lavados || 0);
    metrics.total_servicios = Number(metrics.total_servicios || 0);
    metrics.comision = Number(metrics.comision || 0);
    metrics.saldo_lavadero = Number(metrics.saldo_lavadero || 0);
    metrics.clientes_nuevos = Number(metrics.clientes_nuevos || 0);
    metrics.creditos_pendientes = Number(metrics.creditos_pendientes || 0);
    metrics.anulados = Number(metrics.anulados || 0);
    metrics.ticket_promedio = metrics.lavados ? Math.round(metrics.total_servicios / metrics.lavados) : 0;

    const chartData = {
      daily: dailyResult.rows.map((item) => ({
        label: formatDate(item.fecha),
        lavados: Number(item.lavados || 0),
        total: Number(item.total_servicios || 0),
        comision: Number(item.comision || 0)
      })),
      payments: paymentsResult.rows.map((item) => ({
        label: item.nombre,
        value: Number(item.total || 0),
        cantidad: Number(item.cantidad || 0),
        color: item.color || "#0f766e"
      })),
      services: servicesResult.rows.map((item) => ({ label: item.nombre, value: Number(item.cantidad || 0), total: Number(item.total || 0) })),
      serviceGroups: serviceGroupsResult.rows.map((item) => ({ label: item.nombre, value: Number(item.cantidad || 0), total: Number(item.total || 0) })),
      clientGroups: clientGroupsResult.rows.map((item) => ({ label: item.nombre, value: Number(item.total || 0), cantidad: Number(item.cantidad || 0) })),
      personal: personalResult.rows.map((item) => ({ label: item.nombre, value: Number(item.lavados || 0), total: Number(item.total_servicios || 0) }))
    };

    res.render("analisis_lavados", {
      title: "Analisis general de lavados",
      fechaInicio,
      fechaFin,
      metrics,
      daily: dailyResult.rows,
      payments: paymentsResult.rows,
      services: servicesResult.rows,
      serviceGroups: serviceGroupsResult.rows,
      clientGroups: clientGroupsResult.rows,
      personalRanking: personalResult.rows,
      latestLavados: latestResult.rows,
      chartData
    });
  } catch (error) {
    next(error);
  }
});

app.get("/lavados", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const formData = req.session.lavadoForm || {};
    delete req.session.lavadoForm;
    const data = await getActiveMasterData();
    const lavados = await query(
      `select l.*, c.chapa, c.marca_modelo,
              coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
              count(*) filter (where l.estado = 'EMITIDO') over (partition by c.chapa, l.creado_en::date) as duplicado_emitido_dia,
              fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
       from lavados l
       join clientes c on c.id = l.cliente_id
       left join lavado_personal lp on lp.lavado_id = l.id
       left join personal p on p.id = lp.personal_id
       join formas_pago fp on fp.id = l.forma_pago_id
       where l.creado_en::date = $1
       group by l.id, c.chapa, c.marca_modelo, fp.nombre, fp.icono_ruta, fp.color
       order by ${formasPagoOrderSql("fp")}, l.id desc
       limit 100`,
      [fecha]
    );
    res.render("lavados/index", { title: "Lavados", ...data, lavados: lavados.rows, formData, fecha });
  } catch (error) {
    next(error);
  }
});

app.get("/clientes/buscar", requireAuth, async (req, res, next) => {
  try {
    const term = String(req.query.q || "").trim();
    const params = term ? [`%${term}%`] : [];
    const result = await query(
      `select c.*, g.nombre as grupo_nombre
       from clientes c
       left join grupo_cliente g on g.id = c.grupo_cliente_id
       where c.activo = true
         ${term ? `and (
           c.chapa ilike $1
           or c.marca_modelo ilike $1
           or coalesce(c.nombre, '') ilike $1
           or coalesce(c.ruc, '') ilike $1
           or coalesce(c.telefono, '') ilike $1
           or coalesce(c.email, '') ilike $1
         )` : ""}
       order by c.id desc
       limit 100`,
      params
    );
    res.json({
      clientes: result.rows.map((cliente) => ({
        id: cliente.id,
        chapa: cliente.chapa || "",
        marca_modelo: cliente.marca_modelo || "",
        ruc: cliente.ruc || "",
        nombre: cliente.nombre || "",
        telefono: cliente.telefono || "",
        direccion: cliente.direccion || "",
        email: cliente.email || "",
        grupo_cliente_id: cliente.grupo_cliente_id || "",
        grupo_nombre: cliente.grupo_nombre || ""
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/facturas/ruc", requireAuth, async (req, res) => {
  const ruc = normalizeRucInput(req.query.ruc);
  if (!ruc || !isBasicRuc(ruc)) {
    return res.status(400).json({ found: false, message: "Ingrese un RUC valido." });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetch(`https://turuc.com.py/api/contribuyente?ruc=${encodeURIComponent(ruc)}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = String(payload.message || "");
      if (response.status === 404 || message.toLowerCase().includes("no se encontraron")) {
        return res.json({ found: false, message: "RUC no existe." });
      }
      return res.status(502).json({ found: false, message: "No se pudo consultar el RUC." });
    }

    const contribuyente = payload && payload.data;
    if (!contribuyente || !contribuyente.razonSocial) {
      return res.json({ found: false, message: "RUC no existe." });
    }

    res.json({
      found: true,
      ruc: contribuyente.ruc || ruc,
      nombre: contribuyente.razonSocial,
      estado: contribuyente.estado || ""
    });
  } catch (error) {
    res.status(502).json({ found: false, message: "No se pudo consultar el RUC." });
  }
});

app.get("/facturasend/config", requireAuth, async (req, res, next) => {
  try {
    const configRow = await getFacturaSendConfig();
    res.render("facturasend/config", {
      title: "Configuracion electronica",
      configRow,
      defaultPath: "C:\\Users\\Digno\\Downloads\\facturasend-config.json"
    });
  } catch (error) {
    next(error);
  }
});

app.post("/facturasend/config/import", requireAuth, async (req, res) => {
  try {
    const manualUrl = String(req.body.base_url || "").trim();
    const manualTenant = String(req.body.tenant || "").trim();
    const manualApiKey = String(req.body.api_key || "").trim();
    const rawJson = String(req.body.config_json || "").trim()
      || (String(req.body.config_path || "").trim() ? fs.readFileSync(String(req.body.config_path || "").trim(), "utf8") : "");
    const imported = rawJson ? JSON.parse(rawJson) : {};
    const proxy = imported.proxy || {};
    const baseUrl = manualUrl || proxy.url;
    const tenant = manualTenant || proxy.tenant;
    const apiKey = manualApiKey || proxy.apiKey;
    if (!baseUrl || !tenant || !apiKey) {
      throw new Error("Ingrese URL, tenant y API Key, o importe un JSON con proxy.url, proxy.tenant y proxy.apiKey.");
    }

    await withTransaction(async (client) => {
      await client.query(`update facturasend_config set activo = false where activo = true`);
      await client.query(
        `insert into facturasend_config
           (base_url, tenant, api_key_encrypted, params, ambiente, config_set_api, kude_params, activo, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [
          normalizeBaseUrl(baseUrl),
          String(tenant).trim(),
          encryptSecret(apiKey),
          jsonOrEmpty(imported.params),
          jsonOrEmpty(imported.ambiente),
          jsonOrEmpty(imported.configSetApi),
          jsonOrEmpty(imported.kudeParams),
          currentUser(req)
        ]
      );
    });
    setFlash(req, "success", "Configuracion electronica importada.");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
  }
  res.redirect("/facturasend/config");
});

app.post("/facturasend/config/test", requireAuth, async (req, res) => {
  try {
    const configRow = await getFacturaSendConfig();
    if (!configRow) throw new Error("Importe primero la configuracion de FacturaSend.");
    const response = await facturaSendRequest(configRow, "GET", "/test");
    setFlash(req, "success", `FacturaSend respondio: ${String(response).slice(0, 120)}`);
  } catch (error) {
    setFlash(req, "error", `No se pudo conectar: ${userErrorMessage(error)}`);
  }
  res.redirect("/facturasend/config");
});

app.post("/facturas/:id/electronica/emitir", requireAuth, async (req, res) => {
  try {
    const configRow = await getFacturaSendConfig();
    if (!configRow) throw new Error("Importe primero la configuracion de FacturaSend.");
    const data = await getFacturaById(req.params.id);
    if (!data) throw new Error("Factura no encontrada.");
    if (data.factura.electronica_cdc) throw new Error("Esta factura ya tiene CDC electronico.");

    const payload = buildFacturaSendPayload(data.factura, data.items);
    const response = await facturaSendRequest(configRow, "POST", "/lote/create?draft=true&xml=true&qr=true&tax=true", payload);
    if (response.success === false) {
      await query(
        `update facturas
         set tipo_factura = 'ELECTRONICA',
             electronica_estado = 'Error',
             electronica_respuesta = $1,
             electronica_enviado_en = now()
         where id = $2`,
        [response, req.params.id]
      );
      throw new Error(facturaSendErrorMessage(response));
    }
    const result = response.result || {};
    const de = Array.isArray(result.deList) ? (result.deList[0] || {}) : {};
    const estado = de.estado || facturaSendEstadoLabel(-1);

    await query(
      `update facturas
       set tipo_factura = 'ELECTRONICA',
           electronica_estado = $1,
           electronica_lote_id = $2,
           electronica_cdc = $3,
           electronica_numero = $4,
           electronica_facturasend_id = $5,
           electronica_respuesta = $6,
           electronica_enviado_en = now()
       where id = $7`,
      [
        estado,
        result.loteId ? String(result.loteId) : null,
        de.cdc || null,
        de.numero || null,
        de.id ? String(de.id) : null,
        response,
        req.params.id
      ]
    );
    setFlash(req, "success", `Factura electronica generada${de.cdc ? ` con CDC ${de.cdc}` : ""}.`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
  }
  res.redirect(`/facturas/${req.params.id}/editar`);
});

app.post("/facturas/:id/electronica/estado", requireAuth, async (req, res) => {
  try {
    const configRow = await getFacturaSendConfig();
    if (!configRow) throw new Error("Importe primero la configuracion de FacturaSend.");
    const data = await getFacturaById(req.params.id);
    if (!data) throw new Error("Factura no encontrada.");
    const factura = data.factura;
    if (!factura.electronica_cdc) throw new Error("La factura no tiene CDC electronico.");

    const response = factura.electronica_facturasend_id
      ? await facturaSendRequest(configRow, "POST", `/de/estado/${encodeURIComponent(factura.electronica_facturasend_id)}/${encodeURIComponent(factura.electronica_cdc)}`, {})
      : await facturaSendRequest(configRow, "GET", `/de/cdc/${encodeURIComponent(factura.electronica_cdc)}`);
    const result = response.result || {};
    const estado = facturaSendEstadoLabel(result.situacion ?? result.estado ?? factura.electronica_estado);

    await query(
      `update facturas
       set electronica_estado = $1,
           electronica_lote_id = coalesce($2, electronica_lote_id),
           electronica_facturasend_id = coalesce($3, electronica_facturasend_id),
           electronica_respuesta = $4
       where id = $5`,
      [
        estado,
        result.lote_id ? String(result.lote_id) : null,
        result.id ? String(result.id) : null,
        response,
        req.params.id
      ]
    );
    setFlash(req, "success", `Estado electronico actualizado: ${estado}.`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
  }
  res.redirect(`/facturas/${req.params.id}/editar`);
});

app.get("/facturas/:id/electronica/kude", requireAuth, async (req, res, next) => {
  try {
    const configRow = await getFacturaSendConfig();
    if (!configRow) throw new Error("Importe primero la configuracion de FacturaSend.");
    const data = await getFacturaById(req.params.id);
    if (!data) return res.status(404).render("error", { title: "No encontrado", message: "Factura no encontrada." });
    const factura = data.factura;
    if (!factura.electronica_cdc) throw new Error("La factura no tiene CDC electronico.");

    const response = await facturaSendRequest(configRow, "POST", "/de/pdf", {
      cdcList: [{ cdc: factura.electronica_cdc }],
      type: "base64",
      format: "ticket",
      config: configRow.kude_params
    });
    const base64Pdf = typeof response === "string" ? response : (response.base64 || response.pdf || response.data || response.result);
    if (!base64Pdf) throw new Error("FacturaSend no devolvio el PDF KuDE.");
    const pdf = Buffer.from(String(base64Pdf).replace(/^data:application\/pdf;base64,/, ""), "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="kude-${safeDownloadName(factura.electronica_numero || factura.id)}.pdf"`);
    res.end(pdf);
  } catch (error) {
    next(error);
  }
});

app.get("/facturas", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || "";
    const params = [];
    const where = fecha ? "where f.fecha_emision = $1" : "";
    if (fecha) params.push(fecha);
    const facturas = await query(
      `select f.*, c.chapa, c.marca_modelo
       from facturas f
       left join clientes c on c.id = f.cliente_id
       ${where}
       order by f.fecha_emision desc, f.id desc
       limit 200`,
      params
    );
    const configRow = await getFacturaSendConfig();
    res.render("facturas/index", { title: "Facturas", facturas: facturas.rows, fecha, hasFacturaSendConfig: Boolean(configRow) });
  } catch (error) {
    next(error);
  }
});

app.get("/facturas/nueva", requireAuth, async (req, res, next) => {
  try {
    const lavadoId = req.query.lavado_id;
    const data = lavadoId
      ? await buildFacturaFromLavado(lavadoId)
      : {
          factura: {
            numero: "",
            fecha_emision: todayIso(),
            cliente_id: null,
            lavado_id: null,
            cliente_nombre: "",
            cliente_ruc: "",
            cliente_direccion: "",
            condicion: "CONTADO",
            origen: "LIBRE",
            subtotal: 0,
            iva_10: 0,
            total: 0
          },
          items: [{ servicio_id: null, descripcion: "", cantidad: 1, precio_unitario: 0, total: 0, iva_10: 0 }]
        };
    const [servicios, configRow] = await Promise.all([getFacturaServicios(), getFacturaSendConfig()]);
    res.render("facturas/form", {
      title: lavadoId ? "Facturar lavado" : "Nueva factura",
      factura: data.factura,
      items: data.items,
      servicios,
      hasFacturaSendConfig: Boolean(configRow)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/facturas", requireAuth, async (req, res) => {
  try {
    const facturaId = await saveFactura(req);
    setFlash(req, "success", "Factura guardada correctamente.");
    res.redirect(`/facturas/${facturaId}/editar`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(req.body.lavado_id ? `/facturas/nueva?lavado_id=${req.body.lavado_id}` : "/facturas/nueva");
  }
});

app.get("/facturas/:id/editar", requireAuth, async (req, res, next) => {
  try {
    const data = await getFacturaById(req.params.id);
    if (!data) return res.status(404).render("error", { title: "No encontrado", message: "Factura no encontrada." });
    const [servicios, configRow] = await Promise.all([getFacturaServicios(), getFacturaSendConfig()]);
    res.render("facturas/form", {
      title: `Factura #${req.params.id}`,
      factura: data.factura,
      items: data.items,
      servicios,
      hasFacturaSendConfig: Boolean(configRow)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/facturas/:id", requireAuth, async (req, res) => {
  try {
    const facturaId = await saveFactura(req, req.params.id);
    setFlash(req, "success", "Factura actualizada correctamente.");
    res.redirect(`/facturas/${facturaId}/editar`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/facturas/${req.params.id}/editar`);
  }
});

app.get("/facturas/:id/pdf", requireAuth, async (req, res, next) => {
  try {
    const data = await getFacturaById(req.params.id);
    if (!data) return res.status(404).render("error", { title: "No encontrado", message: "Factura no encontrada." });
    const { factura, items } = data;
    const filename = `factura-${safeDownloadName(factura.numero || factura.id)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    const doc = new PDFDocument({ size: [612, 1008], margin: 0 });
    doc.pipe(res);
    const ox = 10;
    const oy = 10;
    const detailHeight = 305;
    const text = (value, x, y, width, options = {}) => {
      doc.font(options.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(options.size || 8)
        .fillColor("#000")
        .text(String(value || ""), ox + x, oy + y + (options.offsetY || 0), {
          width,
          align: options.align || "left",
          lineBreak: false
        });
    };
    const drawFacturaArea = (offsetY) => {
      text(formatDateInput(factura.fecha_emision), 48, 84, 100, { bold: true, offsetY });
      text("CONTADO", 454, 67, 100, { bold: true, align: "center", offsetY });
      text(factura.cliente_nombre, 107, 112, 238, { bold: true, offsetY });
      text(factura.cliente_direccion || "", 391, 112, 168, { offsetY });
      text(factura.cliente_ruc || "", 64, 98, 100, { bold: true, offsetY });
      text(factura.numero || "", 195, 86, 100, { offsetY });

      items.slice(0, 9).forEach((item, index) => {
        const y = 143 + index * 12;
        text(plainNumber(item.cantidad), 11 + 0, y, 48, { bold: true, align: "center", offsetY });
        text(item.descripcion, 11 + 56, y, 251, { bold: true, offsetY });
        text(plainNumber(item.precio_unitario), 11 + 307, y, 58, { bold: true, align: "right", offsetY });
        text(plainNumber(item.total), 11 + 490, y, 63, { bold: true, align: "right", offsetY });
      });

      text(numeroALetras(factura.total), 84, 260, 357, { bold: true, offsetY });
      text(plainNumber(factura.total), 501, 261, 63, { bold: true, align: "right", offsetY });
      text("0", 101, 275, 39, { bold: true, align: "right", offsetY });
      text(plainNumber(factura.iva_10), 157, 275, 42, { bold: true, align: "right", offsetY });
      text(plainNumber(factura.iva_10), 224, 275, 49, { bold: true, align: "right", offsetY });
    };

    [0, detailHeight, detailHeight * 2].forEach(drawFacturaArea);
    doc.end();
  } catch (error) {
    next(error);
  }
});

app.post("/lavados", requireAuth, async (req, res, next) => {
  try {
    const servicioIds = normalizeArray(req.body.servicio_id).map(Number).filter(Boolean);
    const precios = normalizeArray(req.body.precio);
    if (!servicioIds.length) {
      return redirectLavadosWithForm(req, res, "Seleccione al menos un servicio.");
    }
    const personalIds = [...new Set(normalizeArray(req.body.personal_id).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!personalIds.length) return redirectLavadosWithForm(req, res, "Seleccione al menos un personal.");

    const creadoPor = currentUser(req);
    const lavadoId = await withTransaction(async (client) => {
      let clienteId = Number(req.body.cliente_id || 0);
      if (!clienteId) {
        const nuevaChapa = String(req.body.nueva_chapa || "").trim().toUpperCase();
        const nuevoMarcaModelo = String(req.body.nuevo_marca_modelo || "").trim().toUpperCase();
        if (!nuevaChapa || !nuevoMarcaModelo) {
          throw new Error("Para crear cliente rapido ingrese chapa y marca/modelo.");
        }
        const clienteResult = await client.query(
          `insert into clientes (chapa, marca_modelo, ruc, nombre, direccion, telefono, email, grupo_cliente_id, creado_por)
           values ($1, $2, $3, $4, $5, $6, $7, nullif($8, '')::integer, $9)
           returning id`,
          [
            nuevaChapa,
            nuevoMarcaModelo,
            toUpperOrNull(req.body.nuevo_ruc),
            toUpperOrNull(req.body.nuevo_nombre),
            toUpperOrNull(req.body.nuevo_direccion),
            toUpperOrNull(req.body.nuevo_telefono),
            String(req.body.nuevo_email || "").trim() || null,
            req.body.nuevo_grupo_cliente_id || "",
            creadoPor
          ]
        );
        clienteId = clienteResult.rows[0].id;
      }

      const cliente = await client.query(
        `select c.*, coalesce(g.es_credito, false) as es_credito
         from clientes c
         left join grupo_cliente g on g.id = c.grupo_cliente_id
         where c.id = $1`,
        [clienteId]
      );
      if (!cliente.rows[0]) throw new Error("Cliente no encontrado.");

      const condicion = cliente.rows[0].es_credito ? "CREDITO" : "CONTADO";
      const formaDefault = condicion === "CREDITO" ? "CREDITO" : "LAVADO";
      const forma = await client.query(`select id from formas_pago where nombre = $1 and activo = true`, [formaDefault]);
      if (!forma.rows[0]) throw new Error(`No existe forma de pago ${formaDefault}.`);
      const grupoCreditoId = condicion === "CREDITO" && cliente.rows[0].grupo_cliente_id
        ? await ensureOpenGrupoCredito(client, cliente.rows[0].grupo_cliente_id, creadoPor)
        : null;

      let total = 0;
      const selected = servicioIds.map((servicioId, index) => {
        const precio = toMoney(precios[index]);
        total += precio;
        return { servicioId, precio };
      });
      const comision = Math.round(total * 40) / 100;
      const saldo = Math.round(total * 60) / 100;

      const lavadoResult = await client.query(
        `insert into lavados
           (cliente_id, condicion, forma_pago_id, estado, total, comision_personal, saldo_lavadero, grupo_cliente_credito_id, creado_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [clienteId, condicion, forma.rows[0].id, estadoPorFormaPago(formaDefault), total, comision, saldo, grupoCreditoId, creadoPor]
      );

      const lavado = lavadoResult.rows[0];
      const personalResult = await client.query(
        `select id from personal where id = any($1::int[]) and activo = true order by array_position($1::int[], id)`,
        [personalIds]
      );
      if (personalResult.rows.length !== personalIds.length) throw new Error("Uno de los personales seleccionados no esta disponible.");
      const commissions = splitCommission(comision, personalIds.length);
      for (const [index, personalId] of personalIds.entries()) {
        await client.query(
          `insert into lavado_personal (lavado_id, personal_id, comision, creado_por) values ($1, $2, $3, $4)`,
          [lavado.id, personalId, commissions[index], creadoPor]
        );
      }
      for (const item of selected) {
        await client.query(
          `insert into lavado_servicios (lavado_id, servicio_id, precio, creado_por)
           values ($1, $2, $3, $4)`,
          [lavado.id, item.servicioId, item.precio, creadoPor]
        );
      }
      await applyCommission(client, lavado, 1, creadoPor);
      return lavado.id;
    });

    setFlash(req, "success", `Lavado #${lavadoId} creado correctamente.`);
    res.redirect("/lavados");
  } catch (error) {
    return redirectLavadosWithForm(req, res, error.message);
  }
});

app.get("/lavados/:id", requireAuth, async (req, res, next) => {
  try {
    const lavado = await query(
      `select l.*, c.chapa, c.marca_modelo, c.ruc, c.nombre as cliente_nombre,
              coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre, fp.nombre as forma_pago,
              fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
       from lavados l
       join clientes c on c.id = l.cliente_id
       left join lavado_personal lp on lp.lavado_id = l.id
       left join personal p on p.id = lp.personal_id
       join formas_pago fp on fp.id = l.forma_pago_id
       where l.id = $1
       group by l.id, c.chapa, c.marca_modelo, c.ruc, c.nombre, fp.nombre, fp.icono_ruta, fp.color`,
      [req.params.id]
    );
    if (!lavado.rows[0]) return res.status(404).render("error", { title: "No encontrado", message: "Lavado no encontrado." });
    const [servicios, formasPago, personal, personalLavado] = await Promise.all([
      query(
        `select ls.*, s.nombre
         from lavado_servicios ls
         join servicios s on s.id = ls.servicio_id
         where ls.lavado_id = $1
         order by ls.id`,
        [req.params.id]
      ),
      query(`select * from formas_pago where activo = true and mostrar_despues_crear = true and nombre <> 'ANULADO' order by ${formasPagoOrderSql()}`),
      query(`select * from personal where activo = true order by nombre`),
      query(`select personal_id from lavado_personal where lavado_id = $1 order by id`, [req.params.id])
    ]);
    const serviciosActivos = await query(
      `select s.*, sg.nombre as grupo_nombre
       from servicios s
       left join servicio_grupo sg on sg.id = s.servicio_grupo_id
       where s.activo = true
          or exists (select 1 from lavado_servicios ls where ls.lavado_id = $1 and ls.servicio_id = s.id)
       order by sg.nombre nulls last, s.nombre`,
      [req.params.id]
    );
    res.render("lavados/detail", {
      title: `Lavado #${req.params.id}`,
      lavado: lavado.rows[0],
      servicios: servicios.rows,
      serviciosDisponibles: serviciosActivos.rows,
      formasPago: formasPago.rows,
      personal: personal.rows,
      personalIds: personalLavado.rows.map((row) => String(row.personal_id))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/lavados/:id/editar", requireAuth, async (req, res, next) => {
  try {
    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const lavadoResult = await client.query(`select * from lavados where id = $1 for update`, [req.params.id]);
      const lavado = lavadoResult.rows[0];
      if (!lavado) throw new Error("Lavado no encontrado.");
      if (lavado.estado === "ANULADO") throw new Error("No se puede editar un lavado anulado.");

      const personalIds = [...new Set(normalizeArray(req.body.personal_id)
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (!personalIds.length) throw new Error("Seleccione al menos un personal.");

      const servicioIds = normalizeArray(req.body.servicio_id).map(Number);
      const precios = normalizeArray(req.body.precio);
      if (!servicioIds.length || servicioIds.length !== precios.length || servicioIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error("Agregue al menos un servicio válido.");
      }

      const personalResult = await client.query(
        `select id from personal where id = any($1::int[]) and activo = true`,
        [personalIds]
      );
      if (personalResult.rows.length !== personalIds.length) throw new Error("Uno de los personales seleccionados no está disponible.");

      const serviciosResult = await client.query(
        `select id
         from servicios
         where id = any($1::int[])
           and (activo = true or exists (
             select 1 from lavado_servicios ls
             where ls.lavado_id = $2 and ls.servicio_id = servicios.id
           ))`,
        [servicioIds, lavado.id]
      );
      if (serviciosResult.rows.length !== new Set(servicioIds).size) throw new Error("Uno de los servicios seleccionados no está disponible.");

      const selected = servicioIds.map((servicioId, index) => ({ servicioId, precio: toMoney(precios[index]) }));
      if (selected.some((item) => item.precio < 0)) throw new Error("Los precios no pueden ser negativos.");
      const total = selected.reduce((sum, item) => sum + item.precio, 0);
      const comision = Math.round(total * 40) / 100;
      const saldo = Math.round(total * 60) / 100;

      await applyCommission(client, lavado, -1, creadoPor);
      await client.query(
        `update lavados set total = $1, comision_personal = $2, saldo_lavadero = $3 where id = $4`,
        [total, comision, saldo, lavado.id]
      );
      await client.query(`delete from lavado_personal where lavado_id = $1`, [lavado.id]);
      await client.query(`delete from lavado_servicios where lavado_id = $1`, [lavado.id]);

      const commissions = splitCommission(comision, personalIds.length);
      for (const [index, personalId] of personalIds.entries()) {
        await client.query(
          `insert into lavado_personal (lavado_id, personal_id, comision, creado_por) values ($1, $2, $3, $4)`,
          [lavado.id, personalId, commissions[index], creadoPor]
        );
      }
      for (const item of selected) {
        await client.query(
          `insert into lavado_servicios (lavado_id, servicio_id, precio, creado_por) values ($1, $2, $3, $4)`,
          [lavado.id, item.servicioId, item.precio, creadoPor]
        );
      }

      await applyCommission(client, { ...lavado, total }, 1, creadoPor);
    });
    setFlash(req, "success", `Lavado #${req.params.id} actualizado correctamente.`);
    res.redirect(`/lavados/${req.params.id}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/lavados/${req.params.id}`);
  }
});

app.post("/lavados/:id/forma-pago", requireAuth, async (req, res, next) => {
  try {
    const lavado = await query(`select estado from lavados where id = $1`, [req.params.id]);
    if (!lavado.rows[0]) {
      setFlash(req, "error", "Lavado no encontrado.");
      return res.redirect(req.body.redirect_to || "/lavados");
    }
    if (lavado.rows[0].estado === "CREDITO") {
      setFlash(req, "error", "Los lavados en credito no permiten cambiar la forma de pago.");
      return res.redirect(req.body.redirect_to || `/lavados/${req.params.id}`);
    }
    const forma = await query(`select nombre from formas_pago where id = $1 and activo = true`, [req.body.forma_pago_id]);
    if (!forma.rows[0]) {
      setFlash(req, "error", "Forma de pago no encontrada.");
      return res.redirect(req.body.redirect_to || `/lavados/${req.params.id}`);
    }
    await query(
      `update lavados
       set forma_pago_id = $1, estado = $2
       where id = $3 and estado <> 'ANULADO' and estado <> 'CREDITO'`,
      [req.body.forma_pago_id, estadoPorFormaPago(forma.rows[0].nombre), req.params.id]
    );
    setFlash(req, "success", "Forma de pago actualizada.");
    res.redirect(req.body.redirect_to && req.body.redirect_to.startsWith("/") ? req.body.redirect_to : `/lavados/${req.params.id}`);
  } catch (error) {
    next(error);
  }
});

app.post("/lavados/:id/anular", requireAuth, async (req, res, next) => {
  try {
    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const result = await client.query(`select * from lavados where id = $1 for update`, [req.params.id]);
      const lavado = result.rows[0];
      if (!lavado) throw new Error("Lavado no encontrado.");
      if (lavado.estado === "ANULADO") return;
      const formaAnulado = await client.query(`select id from formas_pago where nombre = 'ANULADO' and activo = true`);
      if (!formaAnulado.rows[0]) throw new Error("No existe la forma de pago ANULADO.");
      await client.query(
        `update lavados
         set estado = 'ANULADO',
             forma_pago_id = $1,
             total = 0,
             comision_personal = 0,
             saldo_lavadero = 0,
             anulado_en = now(),
             anulado_por = $2
         where id = $3`,
        [formaAnulado.rows[0].id, creadoPor, req.params.id]
      );
      await applyCommission(client, lavado, -1, creadoPor);
      await client.query(`update lavado_personal set comision = 0 where lavado_id = $1`, [req.params.id]);
    });
    setFlash(req, "success", "Lavado anulado y comision descontada.");
    res.redirect(`/lavados/${req.params.id}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/lavados/${req.params.id}`);
  }
});

app.get("/grupo-creditos", requireAuth, async (req, res, next) => {
  try {
    const creditos = await query(
      `select gcc.*, g.nombre as grupo_nombre, fp.nombre as forma_pago,
              count(l.id) filter (where l.estado <> 'ANULADO') as lavados_count,
              coalesce(sum(l.total) filter (where l.estado <> 'ANULADO'), 0) as total
       from grupo_cliente_creditos gcc
       join grupo_cliente g on g.id = gcc.grupo_cliente_id
       left join formas_pago fp on fp.id = gcc.forma_pago_id
       left join lavados l on l.grupo_cliente_credito_id = gcc.id
       group by gcc.id, g.nombre, fp.nombre
       order by case gcc.estado when 'ABIERTO' then 1 else 2 end, gcc.id desc`
    );
    res.render("grupo_creditos/index", { title: "Creditos por grupo", creditos: creditos.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/grupo-creditos/:id", requireAuth, async (req, res, next) => {
  try {
    const detail = await getGrupoCreditoDetail(req.params.id);
    if (!detail) return res.status(404).render("error", { title: "No encontrado", message: "Credito de grupo no encontrado." });
    const formasPago = await query(
      `select *
       from formas_pago
       where activo = true
         and nombre not in ('CREDITO', 'ANULADO', 'LAVADO')
       order by ${formasPagoOrderSql()}`
    );
    res.render("grupo_creditos/detail", { title: `Credito ${detail.credito.grupo_nombre}`, ...detail, formasPago: formasPago.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/grupo-creditos/:id/pagar", requireAuth, async (req, res) => {
  try {
    const formaPagoId = Number(req.body.forma_pago_id || 0);
    if (!formaPagoId) throw new Error("Seleccione una forma de pago.");

    await withTransaction(async (client) => {
      const creditoResult = await client.query(
        `select *
         from grupo_cliente_creditos
         where id = $1
         for update`,
        [req.params.id]
      );
      const credito = creditoResult.rows[0];
      if (!credito) throw new Error("Credito de grupo no encontrado.");
      if (credito.estado !== "ABIERTO") throw new Error("Este credito ya fue pagado.");

      const forma = await client.query(
        `select id, nombre
         from formas_pago
         where id = $1
           and activo = true
           and nombre not in ('CREDITO', 'ANULADO', 'LAVADO')`,
        [formaPagoId]
      );
      if (!forma.rows[0]) throw new Error("Forma de pago no valida para cobrar credito.");

      const pendientes = await client.query(
        `select count(*) as total
         from lavados
         where grupo_cliente_credito_id = $1
           and estado = 'CREDITO'`,
        [credito.id]
      );
      if (Number(pendientes.rows[0].total || 0) === 0) throw new Error("No hay lavados pendientes para cobrar.");

      await client.query(
        `update grupo_cliente_creditos
         set estado = 'PAGADO',
             fecha_fin = current_date,
             forma_pago_id = $1,
             pagado_en = now(),
             pagado_por_usuario_id = $2,
             pagado_por = $3
         where id = $4`,
        [formaPagoId, req.session.user.id, currentUser(req), credito.id]
      );
      await client.query(
        `update lavados
         set estado = 'PAGADO',
             forma_pago_id = $1
         where grupo_cliente_credito_id = $2
           and estado = 'CREDITO'`,
        [formaPagoId, credito.id]
      );
    });
    setFlash(req, "success", "Credito de grupo pagado correctamente.");
    res.redirect(`/grupo-creditos/${req.params.id}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/grupo-creditos/${req.params.id}`);
  }
});

app.get("/grupo-creditos/:id/excel", requireAuth, async (req, res, next) => {
  try {
    const detail = await getGrupoCreditoDetail(req.params.id);
    if (!detail) return res.status(404).render("error", { title: "No encontrado", message: "Credito de grupo no encontrado." });
    const { credito, lavados } = detail;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Lavadero";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Credito grupo");

    sheet.columns = [
      { key: "lavado", width: 9 },
      { key: "fecha", width: 19 },
      { key: "auto", width: 32 },
      { key: "personal", width: 20 },
      { key: "servicios", width: 46 },
      { key: "total", width: 16 }
    ];

    sheet.views = [{ showGridLines: false }];
    sheet.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.2, footer: 0.2 }
    };

    sheet.mergeCells("A1:F3");
    const titleCell = sheet.getCell("A1");
    titleCell.value = "Formulario de credito por grupo";
    titleCell.font = { bold: true, size: 18, color: { argb: "FFFFFFFF" } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF12343B" } };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };
    titleCell.border = {
      top: { style: "thin", color: { argb: "FF12343B" } },
      left: { style: "thin", color: { argb: "FF12343B" } },
      bottom: { style: "thin", color: { argb: "FF12343B" } },
      right: { style: "thin", color: { argb: "FF12343B" } }
    };
    sheet.getRow(1).height = 24;
    sheet.getRow(2).height = 20;
    sheet.getRow(3).height = 20;

    sheet.mergeCells("A4:D4");
    sheet.getCell("A4").value = `Cuenta #${credito.id} - generado ${formatDateTime(new Date())}`;
    sheet.getCell("A4").font = { size: 9, color: { argb: "FF687385" } };
    sheet.getCell("A4").alignment = { vertical: "middle", horizontal: "left" };

    sheet.mergeCells("E4:F4");
    const estadoCell = sheet.getCell("E4");
    estadoCell.value = credito.estado;
    estadoCell.font = {
      bold: true,
      size: 11,
      color: { argb: credito.estado === "ABIERTO" ? "FFB42318" : "FF075985" }
    };
    estadoCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: credito.estado === "ABIERTO" ? "FFFFF1EF" : "FFE8F3FF" }
    };
    estadoCell.alignment = { vertical: "middle", horizontal: "center" };
    estadoCell.border = {
      top: { style: "thin", color: { argb: "FFDCE1E8" } },
      left: { style: "thin", color: { argb: "FFDCE1E8" } },
      bottom: { style: "thin", color: { argb: "FFDCE1E8" } },
      right: { style: "thin", color: { argb: "FFDCE1E8" } }
    };

    const cards = [
      ["Grupo", credito.grupo_nombre, "FF17202A"],
      ["Inicio", formatDate(credito.fecha_inicio), "FF17202A"],
      ["Fin", credito.fecha_fin ? formatDate(credito.fecha_fin) : "Abierto", "FF17202A"],
      ["Lavados", credito.lavados_count, "FF17202A"],
      ["Total", Number(credito.total || 0), "FF0F766E"],
      ["Pago", credito.forma_pago || "Pendiente", credito.forma_pago ? "FF17202A" : "FFB42318"]
    ];
    cards.forEach(([label, value, color], index) => {
      const col = (index % 3) * 2 + 1;
      const row = index < 3 ? 6 : 9;
      const labelCell = sheet.getCell(row, col);
      const valueCell = sheet.getCell(row + 1, col);
      sheet.mergeCells(row, col, row, col + 1);
      sheet.mergeCells(row + 1, col, row + 1, col + 1);
      labelCell.value = String(label).toUpperCase();
      labelCell.font = { bold: true, size: 8, color: { argb: "FF687385" } };
      labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7F9" } };
      labelCell.alignment = { vertical: "bottom", horizontal: "left" };
      valueCell.value = value;
      valueCell.font = { bold: true, size: 11, color: { argb: color } };
      valueCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7F9" } };
      valueCell.alignment = { vertical: "top", horizontal: index === 4 ? "right" : "left" };
      if (index === 4) valueCell.numFmt = '"Gs." #,##0';
      [labelCell, valueCell].forEach((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFDCE1E8" } },
          left: { style: "thin", color: { argb: "FFDCE1E8" } },
          bottom: { style: "thin", color: { argb: "FFDCE1E8" } },
          right: { style: "thin", color: { argb: "FFDCE1E8" } }
        };
      });
    });

    if (credito.pagado_por || credito.pagado_en) {
      sheet.mergeCells("A12:F12");
      const paidCell = sheet.getCell("A12");
      paidCell.value = `Pagado por: ${credito.pagado_por || ""}${credito.pagado_en ? ` - ${formatDateTime(credito.pagado_en)}` : ""}`;
      paidCell.font = { size: 9, color: { argb: "FF687385" } };
    }

    sheet.mergeCells("A14:F14");
    sheet.getCell("A14").value = "Lavados realizados";
    sheet.getCell("A14").font = { bold: true, size: 12, color: { argb: "FF17202A" } };

    const headerRow = sheet.getRow(15);
    headerRow.values = ["#", "Fecha", "Auto", "Personal", "Servicios", "Total"];
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 9, color: { argb: "FF115E59" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F3F1" } };
      cell.alignment = { vertical: "middle", horizontal: cell.col === 6 ? "right" : "left" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFB7D4CF" } },
        left: { style: "thin", color: { argb: "FFB7D4CF" } },
        bottom: { style: "thin", color: { argb: "FFB7D4CF" } },
        right: { style: "thin", color: { argb: "FFB7D4CF" } }
      };
    });

    let rowNumber = 16;
    lavados.forEach((lavado, index) => {
      const row = sheet.getRow(rowNumber++);
      row.values = [
        `#${lavado.id}`,
        formatDateTime(lavado.creado_en),
        `${lavado.chapa || ""}${lavado.marca_modelo ? ` - ${lavado.marca_modelo}` : ""}`.trim(),
        lavado.personal_nombre || "",
        lavado.servicios || "",
        Number(lavado.total || 0)
      ];
      row.height = 28;
      row.eachCell((cell) => {
        cell.font = { size: 9, color: { argb: "FF17202A" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 === 0 ? "FFFFFFFF" : "FFF8FAFB" } };
        cell.alignment = { vertical: "top", horizontal: cell.col === 6 ? "right" : "left", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "FFDCE1E8" } },
          left: { style: "thin", color: { argb: "FFDCE1E8" } },
          bottom: { style: "thin", color: { argb: "FFDCE1E8" } },
          right: { style: "thin", color: { argb: "FFDCE1E8" } }
        };
        if (cell.col === 6) cell.numFmt = '"Gs." #,##0';
      });
    });
    if (!lavados.length) {
      sheet.mergeCells(`A${rowNumber}:F${rowNumber}`);
      const emptyCell = sheet.getCell(`A${rowNumber}`);
      emptyCell.value = "Sin lavados en esta cuenta.";
      emptyCell.font = { size: 9, color: { argb: "FF687385" } };
      emptyCell.alignment = { vertical: "middle", horizontal: "left" };
      emptyCell.border = {
        top: { style: "thin", color: { argb: "FFDCE1E8" } },
        left: { style: "thin", color: { argb: "FFDCE1E8" } },
        bottom: { style: "thin", color: { argb: "FFDCE1E8" } },
        right: { style: "thin", color: { argb: "FFDCE1E8" } }
      };
      rowNumber++;
    }

    rowNumber += 1;
    sheet.mergeCells(rowNumber, 4, rowNumber, 5);
    const totalLabelCell = sheet.getCell(rowNumber, 4);
    const totalValueCell = sheet.getCell(rowNumber, 6);
    totalLabelCell.value = "Total general";
    totalValueCell.value = Number(credito.total || 0);
    [totalLabelCell, totalValueCell].forEach((cell) => {
      cell.font = { bold: true, size: 11, color: { argb: "FF115E59" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F3F1" } };
      cell.alignment = { vertical: "middle", horizontal: cell.col === 6 ? "right" : "left" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFB7D4CF" } },
        left: { style: "thin", color: { argb: "FFB7D4CF" } },
        bottom: { style: "thin", color: { argb: "FFB7D4CF" } },
        right: { style: "thin", color: { argb: "FFB7D4CF" } }
      };
    });
    totalValueCell.numFmt = '"Gs." #,##0';

    rowNumber += 2;
    sheet.mergeCells(rowNumber, 1, rowNumber, 3);
    sheet.getCell(rowNumber, 1).value = "Firma / aclaracion:";
    sheet.getCell(rowNumber, 1).font = { size: 9, color: { argb: "FF687385" } };
    sheet.mergeCells(rowNumber, 5, rowNumber, 6);
    sheet.getCell(rowNumber, 5).value = `Lavadero - credito por grupo #${credito.id}`;
    sheet.getCell(rowNumber, 5).font = { size: 8, color: { argb: "FF687385" } };
    sheet.getCell(rowNumber, 5).alignment = { horizontal: "right" };
    sheet.getColumn("total").numFmt = '"Gs." #,##0';

    const filename = `credito-${safeDownloadName(credito.grupo_nombre)}-${credito.id}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

app.get("/grupo-creditos/:id/pdf", requireAuth, async (req, res, next) => {
  try {
    const detail = await getGrupoCreditoDetail(req.params.id);
    if (!detail) return res.status(404).render("error", { title: "No encontrado", message: "Credito de grupo no encontrado." });
    const { credito, lavados } = detail;
    const filename = `credito-${safeDownloadName(credito.grupo_nombre)}-${credito.id}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 32, size: "A4" });
    doc.pipe(res);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const top = doc.page.margins.top;
    const headerHeight = 62;

    doc.roundedRect(left, top, pageWidth, headerHeight, 8).fillColor("#12343b").fill();
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#ffffff").text("Formulario de credito por grupo", left + 16, top + 13, {
      width: pageWidth - 190
    });
    doc.font("Helvetica").fontSize(8).fillColor("#dce1e8").text(`Cuenta #${credito.id} - generado ${formatDateTime(new Date())}`, left + 16, top + 38, {
      width: pageWidth - 190
    });
    doc.roundedRect(left + pageWidth - 118, top + 17, 96, 28, 999).fillColor(credito.estado === "ABIERTO" ? "#fff1ef" : "#e8f3ff").fill();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(credito.estado === "ABIERTO" ? "#b42318" : "#075985").text(credito.estado, left + pageWidth - 118, top + 27, {
      width: 96,
      align: "center"
    });

    doc.y = top + headerHeight + 14;
    const cardsY = doc.y;
    const cardGap = 8;
    const cardWidth = (pageWidth - cardGap * 2) / 3;
    const cards = [
      ["Grupo", credito.grupo_nombre, "#17202a"],
      ["Inicio", formatDate(credito.fecha_inicio), "#17202a"],
      ["Fin", credito.fecha_fin ? formatDate(credito.fecha_fin) : "Abierto", "#17202a"],
      ["Lavados", credito.lavados_count, "#17202a"],
      ["Total", formatMoney(credito.total), "#0f766e"],
      ["Pago", credito.forma_pago || "Pendiente", credito.forma_pago ? "#17202a" : "#b42318"]
    ];
    cards.forEach(([title, value, color], index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      drawPdfInfoCard(doc, left + col * (cardWidth + cardGap), cardsY + row * 46, cardWidth, title, value, color);
    });
    doc.y = cardsY + 98;

    if (credito.pagado_por || credito.pagado_en) {
      doc.font("Helvetica").fontSize(8).fillColor("#687385").text(
        `Pagado por: ${credito.pagado_por || ""}${credito.pagado_en ? ` - ${formatDateTime(credito.pagado_en)}` : ""}`,
        left,
        doc.y,
        { width: pageWidth }
      );
      doc.moveDown(0.8);
    }

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#17202a").text("Lavados realizados", left, doc.y);
    doc.moveDown(0.35);

    const columns = [
      { x: left, width: 34 },
      { x: left + 34, width: 82 },
      { x: left + 116, width: 118 },
      { x: left + 234, width: 70 },
      { x: left + 304, width: 155 },
      { x: left + 459, width: 72, align: "right" }
    ];
    drawPdfRow(doc, columns, ["#", "Fecha", "Auto", "Personal", "Servicios", "Total"], {
      bold: true,
      minHeight: 22,
      fontSize: 7,
      padding: 4,
      background: "#e8f3f1",
      borderColor: "#b7d4cf",
      color: "#115e59"
    });
    lavados.forEach((lavado, index) => {
      drawPdfRow(doc, columns, [
        `#${lavado.id}`,
        formatDateTime(lavado.creado_en),
        `${lavado.chapa || ""}${lavado.marca_modelo ? ` - ${lavado.marca_modelo}` : ""}`.trim(),
        lavado.personal_nombre || "",
        lavado.servicios || "",
        formatMoney(lavado.total)
      ], {
        background: index % 2 === 0 ? "#ffffff" : "#f8fafb",
        minHeight: 22,
        fontSize: 7,
        padding: 4
      });
    });
    if (!lavados.length) {
      drawPdfRow(doc, columns, ["", "", "", "", "Sin lavados en esta cuenta.", ""], {
        minHeight: 24,
        fontSize: 7,
        padding: 4,
        background: "#ffffff"
      });
    }

    doc.moveDown();
    ensurePdfSpace(doc, 54);
    const totalY = doc.y;
    doc.roundedRect(left + pageWidth - 170, totalY, 170, 34, 7).fillColor("#e8f3f1").fill();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#115e59").text("Total general", left + pageWidth - 158, totalY + 7, {
      width: 146
    });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f766e").text(formatMoney(credito.total), left + pageWidth - 158, totalY + 18, {
      width: 146,
      align: "right"
    });
    doc.y = totalY + 50;
    ensurePdfSpace(doc, 42);
    doc.font("Helvetica").fontSize(9).fillColor("#687385").text("Firma / aclaracion:", left);
    doc.moveTo(left + 94, doc.y + 9).lineTo(left + 330, doc.y + 9).strokeColor("#687385").stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#687385").text(`Lavadero - credito por grupo #${credito.id}`, left, doc.page.height - 26, {
      width: pageWidth,
      align: "right"
    });

    doc.end();
  } catch (error) {
    next(error);
  }
});

app.get("/comisiones", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const [result, lavadosResult, valesResult] = await Promise.all([
      query(
        `select cd.*,
                coalesce(cd.total_vales, 0) as total_vales,
                greatest(0, cd.total_comision_40 - coalesce(cd.total_vales, 0)) as saldo_personal,
                p.nombre as personal_nombre
       from comisiones_diarias cd
       join personal p on p.id = cd.personal_id
       where cd.fecha = $1
       order by p.nombre`,
        [fecha]
      ),
      query(
        `with reparto as (
           select lp.id as relacion_id, lp.lavado_id, lp.personal_id, lp.comision,
                  floor(round(l.total * 100) / count(*) over (partition by lp.lavado_id))
                    + case when row_number() over (partition by lp.lavado_id order by lp.id) = 1
                        then mod(round(l.total * 100), count(*) over (partition by lp.lavado_id)) else 0 end as total_servicios_centavos
           from lavado_personal lp
           join lavados l on l.id = lp.lavado_id
         )
         select l.*, reparto.personal_id, reparto.comision as comision_personal,
                reparto.total_servicios_centavos / 100.0 as total_servicios_personal,
                c.chapa, c.marca_modelo, g.nombre as grupo_cliente_nombre,
                p.nombre as personal_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from lavados l
         join clientes c on c.id = l.cliente_id
         left join grupo_cliente g on g.id = c.grupo_cliente_id
         join reparto on reparto.lavado_id = l.id
         join personal p on p.id = reparto.personal_id
         join formas_pago fp on fp.id = l.forma_pago_id
         where l.creado_en::date = $1
         order by l.creado_en, l.id`,
        [fecha]
      ),
      query(
        `select v.*, fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from vales_personal v
         join formas_pago fp on fp.id = v.forma_pago_id
         where v.fecha_pago = $1
         order by v.creado_en, v.id`,
        [fecha]
      )
    ]);
    const lavadosByPersonal = {};
    const valesByPersonal = {};
    lavadosResult.rows.forEach((lavado) => {
      const personalId = String(lavado.personal_id);
      if (!lavadosByPersonal[personalId]) lavadosByPersonal[personalId] = [];
      lavadosByPersonal[personalId].push(lavado);
    });
    valesResult.rows.forEach((vale) => {
      const personalId = String(vale.personal_id);
      if (!valesByPersonal[personalId]) valesByPersonal[personalId] = [];
      valesByPersonal[personalId].push(vale);
    });
    res.render("comisiones", { title: "Comisiones", fecha, comisiones: result.rows, lavadosByPersonal, valesByPersonal });
  } catch (error) {
    next(error);
  }
});

app.get("/analisis-personal", requireAuth, async (req, res, next) => {
  try {
    let fechaInicio = req.query.fecha_inicio || todayIso();
    let fechaFin = req.query.fecha_fin || fechaInicio;
    if (fechaFin < fechaInicio) {
      const fechaTemp = fechaInicio;
      fechaInicio = fechaFin;
      fechaFin = fechaTemp;
    }
    const personalIdParam = String(req.query.personal_id || "todos");
    const parsedPersonalId = personalIdParam && personalIdParam !== "todos" ? Number(personalIdParam) : null;
    const selectedPersonalId = Number.isFinite(parsedPersonalId) && parsedPersonalId > 0 ? parsedPersonalId : null;
    const personalFilter = selectedPersonalId ? "and p.id = $3" : "";
    const movementFilter = selectedPersonalId ? "and lp.personal_id = $3" : "";
    const queryParams = selectedPersonalId ? [fechaInicio, fechaFin, selectedPersonalId] : [fechaInicio, fechaFin];

    const [personalResult, resumenResult, lavadosResult, comisionesResult, valesResult] = await Promise.all([
      query(`select * from personal where activo = true order by nombre`),
      query(
        `with comisiones as (
           select personal_id,
                  coalesce(sum(total_lavados_emitidos), 0) as lavados,
                  coalesce(sum(total_servicios), 0) as servicios,
                  coalesce(sum(total_comision_40), 0) as comision
           from comisiones_diarias
           where fecha between $1 and $2
           group by personal_id
         ),
         vales as (
           select personal_id,
                  coalesce(sum(monto), 0) as vales
           from vales_personal
           where fecha_pago between $1 and $2
             and estado <> 'ANULADO'
           group by personal_id
         )
         select p.id as personal_id,
                p.nombre as personal_nombre,
                coalesce(c.lavados, 0)::int as lavados,
                coalesce(c.servicios, 0) as servicios,
                coalesce(c.comision, 0) as comision,
                coalesce(v.vales, 0) as vales,
                coalesce(c.comision, 0) - coalesce(v.vales, 0) as saldo
         from personal p
         left join comisiones c on c.personal_id = p.id
         left join vales v on v.personal_id = p.id
         where p.activo = true ${personalFilter}
         order by p.nombre`,
        queryParams
      ),
      query(
            `with reparto as (
               select lp.id as relacion_id, lp.lavado_id, lp.personal_id, lp.comision,
                      floor(round(l.total * 100) / count(*) over (partition by lp.lavado_id))
                        + case when row_number() over (partition by lp.lavado_id order by lp.id) = 1
                            then mod(round(l.total * 100), count(*) over (partition by lp.lavado_id)) else 0 end as total_servicios_centavos
               from lavado_personal lp
               join lavados l on l.id = lp.lavado_id
             )
            select l.*, reparto.personal_id, reparto.comision as comision_personal,
                      reparto.total_servicios_centavos / 100.0 as total_servicios_personal,
                      c.chapa, c.marca_modelo, g.nombre as grupo_cliente_nombre,
                      p.nombre as personal_nombre,
                      fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from lavados l
         join clientes c on c.id = l.cliente_id
         left join grupo_cliente g on g.id = c.grupo_cliente_id
         join reparto on reparto.lavado_id = l.id
         join personal p on p.id = reparto.personal_id
         join formas_pago fp on fp.id = l.forma_pago_id
         where l.creado_en::date between $1 and $2
           and l.estado <> 'ANULADO'
           ${movementFilter}
         order by l.creado_en desc, l.id desc`,
        queryParams
      ),
      query(
        `select cd.*, p.nombre as personal_nombre,
                coalesce(cd.total_vales, 0) as total_vales,
                cd.total_comision_40 - coalesce(cd.total_vales, 0) as saldo_personal
         from comisiones_diarias cd
         join personal p on p.id = cd.personal_id
         where cd.fecha between $1 and $2
           ${selectedPersonalId ? "and cd.personal_id = $3" : ""}
         order by cd.fecha desc, p.nombre`,
        queryParams
      ),
      query(
        `select v.*, p.nombre as personal_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from vales_personal v
         join personal p on p.id = v.personal_id
         join formas_pago fp on fp.id = v.forma_pago_id
         where v.fecha_pago between $1 and $2
           and v.estado <> 'ANULADO'
           ${selectedPersonalId ? "and v.personal_id = $3" : ""}
         order by v.fecha_pago desc, v.id desc`,
        queryParams
      )
    ]);

    const resumen = resumenResult.rows;
    const totales = resumen.reduce(
      (acc, item) => {
        acc.lavados += Number(item.lavados || 0);
        acc.servicios += Number(item.servicios || 0);
        acc.comision += Number(item.comision || 0);
        acc.vales += Number(item.vales || 0);
        acc.saldo += Number(item.saldo || 0);
        return acc;
      },
      { lavados: 0, servicios: 0, comision: 0, vales: 0, saldo: 0 }
    );

    const detailsByPersonal = {};
    resumen.forEach((item) => {
      detailsByPersonal[String(item.personal_id)] = {
        lavados: [],
        comisiones: [],
        vales: []
      };
    });
    lavadosResult.rows.forEach((lavado) => {
      const personalId = String(lavado.personal_id);
      if (!detailsByPersonal[personalId]) detailsByPersonal[personalId] = { lavados: [], comisiones: [], vales: [] };
      detailsByPersonal[personalId].lavados.push(lavado);
    });
    comisionesResult.rows.forEach((comision) => {
      const personalId = String(comision.personal_id);
      if (!detailsByPersonal[personalId]) detailsByPersonal[personalId] = { lavados: [], comisiones: [], vales: [] };
      detailsByPersonal[personalId].comisiones.push(comision);
    });
    valesResult.rows.forEach((vale) => {
      const personalId = String(vale.personal_id);
      if (!detailsByPersonal[personalId]) detailsByPersonal[personalId] = { lavados: [], comisiones: [], vales: [] };
      detailsByPersonal[personalId].vales.push(vale);
    });

    const diasResult = selectedPersonalId
      ? await query(
          `select fecha,
                  coalesce(sum(total_lavados_emitidos), 0)::int as lavados,
                  coalesce(sum(total_servicios), 0) as servicios,
                  coalesce(sum(total_comision_40), 0) as comision,
                  coalesce(sum(total_vales), 0) as vales,
                  coalesce(sum(total_comision_40), 0) - coalesce(sum(total_vales), 0) as saldo
           from comisiones_diarias
           where fecha between $1 and $2
             and personal_id = $3
           group by fecha
           order by fecha`,
          queryParams
        )
      : Promise.resolve({ rows: [] });

    res.render("analisis_personal", {
      title: "Analisis de personal",
      fechaInicio,
      fechaFin,
      personal: personalResult.rows,
      selectedPersonalId,
      resumen,
      totales,
      detailsByPersonal,
      dias: diasResult.rows
    });
  } catch (error) {
    next(error);
  }
});

app.get("/vales/saldo", requireAuth, async (req, res, next) => {
  try {
    const personalId = Number(req.query.personal_id || 0);
    const fecha = req.query.fecha || todayIso();
    if (!personalId) {
      res.json({ total_comision_40: 0, total_vales: 0, saldo_personal: 0 });
      return;
    }
    const result = await query(
      `select coalesce(cd.total_comision_40, 0) as total_comision_40,
              coalesce(cd.total_vales, 0) as total_vales,
              greatest(0, coalesce(cd.total_comision_40, 0) - coalesce(cd.total_vales, 0)) as saldo_personal
       from personal p
       left join comisiones_diarias cd on cd.personal_id = p.id and cd.fecha = $2
       where p.id = $1`,
      [personalId, fecha]
    );
    res.json(result.rows[0] || { total_comision_40: 0, total_vales: 0, saldo_personal: 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/vales", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const editId = req.query.edit;
    const [personalResult, formasPagoResult, valesResult, editResult] = await Promise.all([
      query(`select * from personal where activo = true order by nombre`),
      query(`select * from formas_pago where activo = true and nombre <> 'ANULADO' order by ${formasPagoOrderSql()}`),
      query(
        `select v.*, p.nombre as personal_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from vales_personal v
         join personal p on p.id = v.personal_id
         join formas_pago fp on fp.id = v.forma_pago_id
         where v.fecha_pago = $1
         order by v.id desc`,
        [fecha]
      ),
      editId ? query(`select * from vales_personal where id = $1`, [editId]) : Promise.resolve({ rows: [] })
    ]);
    res.render("vales", {
      title: "Vales",
      fecha,
      personal: personalResult.rows,
      formasPago: formasPagoResult.rows,
      vales: valesResult.rows,
      editItem: editResult.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/vales", requireAuth, async (req, res) => {
  try {
    const personalId = Number(req.body.personal_id || 0);
    const formaPagoId = Number(req.body.forma_pago_id || 0);
    const monto = toMoney(req.body.monto);
    const fechaPago = req.body.fecha_pago || todayIso();
    if (!personalId) throw new Error("Seleccione un personal.");
    if (!formaPagoId) throw new Error("Seleccione una forma de pago.");
    if (monto <= 0) throw new Error("Ingrese un monto mayor a cero.");

    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const created = await client.query(
        `insert into vales_personal (personal_id, fecha_pago, monto, forma_pago_id, creado_por)
         values ($1, $2, $3, $4, $5)
         returning *`,
        [personalId, fechaPago, monto, formaPagoId, creadoPor]
      );
      await applyVale(client, created.rows[0], 1, creadoPor);
    });
    setFlash(req, "success", "Vale emitido correctamente.");
    res.redirect(`/vales?fecha=${fechaPago}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/vales?fecha=${req.body.fecha_pago || todayIso()}`);
  }
});

app.post("/vales/:id", requireAuth, async (req, res) => {
  let fechaRedirect = req.body.fecha_pago || todayIso();
  try {
    const personalId = Number(req.body.personal_id || 0);
    const formaPagoId = Number(req.body.forma_pago_id || 0);
    const monto = toMoney(req.body.monto);
    const fechaPago = req.body.fecha_pago || todayIso();
    fechaRedirect = fechaPago;
    if (!personalId) throw new Error("Seleccione un personal.");
    if (!formaPagoId) throw new Error("Seleccione una forma de pago.");
    if (monto <= 0) throw new Error("Ingrese un monto mayor a cero.");

    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const result = await client.query(`select * from vales_personal where id = $1 for update`, [req.params.id]);
      const vale = result.rows[0];
      if (!vale) throw new Error("Vale no encontrado.");
      if (vale.estado === "ANULADO") throw new Error("No se puede editar un vale anulado.");

      await applyVale(client, vale, -1, creadoPor);
      const updated = await client.query(
        `update vales_personal
         set personal_id = $1,
             fecha_pago = $2,
             monto = $3,
             forma_pago_id = $4
         where id = $5
         returning *`,
        [personalId, fechaPago, monto, formaPagoId, req.params.id]
      );
      await applyVale(client, updated.rows[0], 1, creadoPor);
    });
    setFlash(req, "success", "Vale actualizado correctamente.");
    res.redirect(`/vales?fecha=${fechaRedirect}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/vales?fecha=${fechaRedirect}&edit=${req.params.id}`);
  }
});

app.post("/vales/:id/anular", requireAuth, async (req, res) => {
  let fechaRedirect = req.body.fecha || todayIso();
  try {
    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const result = await client.query(`select * from vales_personal where id = $1 for update`, [req.params.id]);
      const vale = result.rows[0];
      if (!vale) throw new Error("Vale no encontrado.");
      fechaRedirect = formatDateInput(vale.fecha_pago);
      if (vale.estado === "ANULADO") return;
      await applyVale(client, vale, -1, creadoPor);
      await client.query(
        `update vales_personal
         set estado = 'ANULADO',
             monto = 0,
             anulado_en = now(),
             anulado_por = $1
         where id = $2`,
        [creadoPor, req.params.id]
      );
    });
    setFlash(req, "success", "Vale anulado correctamente.");
    res.redirect(`/vales?fecha=${fechaRedirect}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/vales?fecha=${fechaRedirect}`);
  }
});

app.get("/gastos", requireAuth, async (req, res, next) => {
  try {
    const fecha = req.query.fecha || todayIso();
    const editId = req.query.edit;
    const [tiposResult, formasPagoResult, gastosResult, editResult] = await Promise.all([
      query(`select * from gasto_tipo where activo = true order by nombre`),
      query(`select * from formas_pago where activo = true and nombre <> 'ANULADO' order by ${formasPagoOrderSql()}`),
      query(
        `select g.*, gt.nombre as gasto_tipo_nombre,
                fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
         from gastos g
         join gasto_tipo gt on gt.id = g.gasto_tipo_id
         join formas_pago fp on fp.id = g.forma_pago_id
         where g.fecha_gasto = $1
         order by g.id desc`,
        [fecha]
      ),
      editId ? query(`select * from gastos where id = $1`, [editId]) : Promise.resolve({ rows: [] })
    ]);
    res.render("gastos", {
      title: "Gastos",
      fecha,
      tipos: tiposResult.rows,
      formasPago: formasPagoResult.rows,
      gastos: gastosResult.rows,
      editItem: editResult.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/gastos", requireAuth, async (req, res) => {
  try {
    const gastoTipoId = Number(req.body.gasto_tipo_id || 0);
    const formaPagoId = Number(req.body.forma_pago_id || 0);
    const monto = toMoney(req.body.monto);
    const fechaGasto = req.body.fecha_gasto || todayIso();
    const descripcion = String(req.body.descripcion || "").trim().toUpperCase();
    if (!gastoTipoId) throw new Error("Seleccione un tipo de gasto.");
    if (!formaPagoId) throw new Error("Seleccione una forma de pago.");
    if (monto <= 0) throw new Error("Ingrese un monto mayor a cero.");

    await query(
      `insert into gastos (gasto_tipo_id, fecha_gasto, descripcion, monto, forma_pago_id, creado_por)
       values ($1, $2, $3, $4, $5, $6)`,
      [gastoTipoId, fechaGasto, descripcion || null, monto, formaPagoId, currentUser(req)]
    );
    setFlash(req, "success", "Gasto emitido correctamente.");
    res.redirect(`/gastos?fecha=${fechaGasto}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/gastos?fecha=${req.body.fecha_gasto || todayIso()}`);
  }
});

app.post("/gastos/:id", requireAuth, async (req, res) => {
  let fechaRedirect = req.body.fecha_gasto || todayIso();
  try {
    const gastoTipoId = Number(req.body.gasto_tipo_id || 0);
    const formaPagoId = Number(req.body.forma_pago_id || 0);
    const monto = toMoney(req.body.monto);
    const fechaGasto = req.body.fecha_gasto || todayIso();
    const descripcion = String(req.body.descripcion || "").trim().toUpperCase();
    fechaRedirect = fechaGasto;
    if (!gastoTipoId) throw new Error("Seleccione un tipo de gasto.");
    if (!formaPagoId) throw new Error("Seleccione una forma de pago.");
    if (monto <= 0) throw new Error("Ingrese un monto mayor a cero.");

    const result = await query(`select * from gastos where id = $1`, [req.params.id]);
    const gasto = result.rows[0];
    if (!gasto) throw new Error("Gasto no encontrado.");
    if (gasto.estado === "ANULADO") throw new Error("No se puede editar un gasto anulado.");

    await query(
      `update gastos
       set gasto_tipo_id = $1,
           fecha_gasto = $2,
           descripcion = $3,
           monto = $4,
           forma_pago_id = $5
       where id = $6`,
      [gastoTipoId, fechaGasto, descripcion || null, monto, formaPagoId, req.params.id]
    );
    setFlash(req, "success", "Gasto actualizado correctamente.");
    res.redirect(`/gastos?fecha=${fechaRedirect}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/gastos?fecha=${fechaRedirect}&edit=${req.params.id}`);
  }
});

app.post("/gastos/:id/anular", requireAuth, async (req, res) => {
  let fechaRedirect = req.body.fecha || todayIso();
  try {
    const result = await query(`select * from gastos where id = $1`, [req.params.id]);
    const gasto = result.rows[0];
    if (!gasto) throw new Error("Gasto no encontrado.");
    fechaRedirect = formatDateInput(gasto.fecha_gasto);
    if (gasto.estado !== "ANULADO") {
      await query(
        `update gastos
         set estado = 'ANULADO',
             monto = 0,
             anulado_en = now(),
             anulado_por = $1
         where id = $2`,
        [currentUser(req), req.params.id]
      );
    }
    setFlash(req, "success", "Gasto anulado correctamente.");
    res.redirect(`/gastos?fecha=${fechaRedirect}`);
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/gastos?fecha=${fechaRedirect}`);
  }
});

app.get("/usuarios", requireAuth, async (req, res, next) => {
  try {
    const editId = req.query.edit;
    const [usuarios, editItem, rolls] = await Promise.all([
      query(
        `select u.id, u.login, u.nombre, u.activo, u.creado_en, u.creado_por, ur.roll, ur.activo as roll_activo
         from usuarios u
         left join usuario_roll ur on ur.id = u.usuario_roll_id
         order by u.id desc`
      ),
      editId ? query(
        `select u.id, u.login, u.nombre, u.activo, u.usuario_roll_id, ur.roll, ur.activo as roll_activo
         from usuarios u
         left join usuario_roll ur on ur.id = u.usuario_roll_id
         where u.id = $1`,
        [editId]
      ) : Promise.resolve({ rows: [] }),
      query(
        `select id, roll, activo
         from usuario_roll
         where activo = true or id = coalesce((select usuario_roll_id from usuarios where id = $1), 0)
         order by roll`,
        [editId || 0]
      )
    ]);
    res.render("usuarios", {
      title: "Usuarios",
      usuarios: usuarios.rows,
      editItem: editItem.rows[0] || null,
      rolls: rolls.rows
    });
  } catch (error) {
    next(error);
  }
});

app.post("/usuarios", requireAuth, async (req, res) => {
  try {
    const passwordHash = await bcrypt.hash(req.body.password || "", 10);
    const rollId = req.body.usuario_roll_id ? Number(req.body.usuario_roll_id) : null;
    await withTransaction(async (client) => {
      const result = await client.query(
        `insert into usuarios (login, password_hash, nombre, activo, creado_por)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          String(req.body.login || "").trim(),
          passwordHash,
          String(req.body.nombre || "").trim(),
          req.body.activo === "on",
          currentUser(req)
        ]
      );
      if (rollId) await client.query(`update usuarios set usuario_roll_id = $1 where id = $2`, [rollId, result.rows[0].id]);
    });
    setFlash(req, "success", "Usuario creado.");
    res.redirect("/usuarios");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect("/usuarios");
  }
});

app.post("/usuarios/:id", requireAuth, async (req, res) => {
  try {
    const values = [
      String(req.body.login || "").trim(),
      String(req.body.nombre || "").trim(),
      req.body.activo === "on",
      req.params.id
    ];
    const rollId = req.body.usuario_roll_id ? Number(req.body.usuario_roll_id) : null;

    await withTransaction(async (client) => {
      if (req.body.password) {
        const passwordHash = await bcrypt.hash(req.body.password, 10);
        await client.query(
          `update usuarios
           set login = $1, nombre = $2, activo = $3, password_hash = $4
           where id = $5`,
          [values[0], values[1], values[2], passwordHash, values[3]]
        );
      } else {
        await client.query(
          `update usuarios
           set login = $1, nombre = $2, activo = $3
           where id = $4`,
          values
        );
      }

      await client.query(`update usuarios set usuario_roll_id = $1 where id = $2`, [rollId, req.params.id]);
    });

    if (Number(req.params.id) === Number(req.session.user.id)) {
      req.session.user.login = values[0];
      req.session.user.nombre = values[1];
      const selectedRoll = rollId ? await query(`select roll from usuario_roll where id = $1`, [rollId]) : { rows: [] };
      req.session.user.roll = selectedRoll.rows[0]?.roll || null;
    }

    setFlash(req, "success", "Usuario actualizado.");
    res.redirect("/usuarios");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/usuarios?edit=${req.params.id}`);
  }
});

app.post("/usuarios/:id/toggle", requireAuth, async (req, res, next) => {
  try {
    if (Number(req.params.id) === Number(req.session.user.id)) {
      setFlash(req, "error", "No puede desactivar su propio usuario.");
      return res.redirect("/usuarios");
    }
    await query(`update usuarios set activo = not activo where id = $1`, [req.params.id]);
    setFlash(req, "success", "Estado actualizado.");
    res.redirect("/usuarios");
  } catch (error) {
    next(error);
  }
});

app.get("/usuario-roll", requireAuth, async (req, res, next) => {
  try {
    const editRoleId = req.query.edit || req.query.edit_role;
    const [roles, items, eventos, editRole] = await Promise.all([
      query(
        `select ur.id, ur.roll, ur.activo, ur.creado_en, count(distinct u.id)::int as usuarios_count,
                count(distinct uri.id)::int as items_count
         from usuario_roll ur
         left join usuarios u on u.usuario_roll_id = ur.id
         left join usuario_roll_item uri on uri.usuario_roll_id = ur.id
         group by ur.id
         order by ur.roll`
      ),
      query(
        `select uri.*, ur.roll, ure.nombre as evento_nombre, ure.codigo_evento
         from usuario_roll_item uri
         join usuario_roll ur on ur.id = uri.usuario_roll_id
         left join usuario_roll_evento ure on ure.id = uri.usuario_roll_evento_id
         order by ur.roll, ure.codigo_evento`
      ),
      query(`select id, nombre, codigo_evento from usuario_roll_evento order by codigo_evento`),
      editRoleId ? query(`select * from usuario_roll where id = $1`, [editRoleId]) : Promise.resolve({ rows: [] })
    ]);
    res.render("usuario_roll", {
      title: "Roll",
      roles: roles.rows,
      items: items.rows,
      eventos: eventos.rows,
      editRole: editRole.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/usuario-roll", requireAuth, async (req, res) => {
  try {
    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const roleResult = await client.query(
        `insert into usuario_roll (roll, activo, creado_por)
         values ($1, $2, $3)
         returning id`,
        [String(req.body.roll || "").trim(), req.body.activo === "on", creadoPor]
      );
      await client.query(
        `insert into usuario_roll_item
           (usuario_roll_id, usuario_roll_evento_id, activo, creado_por)
         select $1, id, true, $2
         from usuario_roll_evento
         where activo = true
         on conflict (usuario_roll_id, usuario_roll_evento_id) do nothing`,
        [roleResult.rows[0].id, creadoPor]
      );
    });
    setFlash(req, "success", "Roll creado.");
    res.redirect("/usuario-roll");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect("/usuario-roll");
  }
});

app.post("/usuario-roll/:id", requireAuth, async (req, res) => {
  try {
    await query(
      `update usuario_roll set roll = $1, activo = $2 where id = $3`,
      [String(req.body.roll || "").trim(), req.body.activo === "on", req.params.id]
    );
    setFlash(req, "success", "Roll actualizado.");
    res.redirect("/usuario-roll");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/usuario-roll?edit=${req.params.id}`);
  }
});

app.post("/usuario-roll/:id/toggle", requireAuth, async (req, res, next) => {
  try {
    await query(`update usuario_roll set activo = not activo where id = $1`, [req.params.id]);
    setFlash(req, "success", "Estado del roll actualizado.");
    res.redirect("/usuario-roll");
  } catch (error) {
    next(error);
  }
});

app.post("/usuario-roll-item/:id/toggle", requireAuth, async (req, res, next) => {
  try {
    await query(`update usuario_roll_item set activo = not activo where id = $1`, [req.params.id]);
    setFlash(req, "success", "Estado del ítem actualizado.");
    res.redirect("/usuario-roll");
  } catch (error) {
    next(error);
  }
});

app.get("/usuario-roll-eventos", requireAuth, async (req, res, next) => {
  try {
    const [eventos, editEvento] = await Promise.all([
      query(
        `select ure.*, count(uri.id)::int as items_count
         from usuario_roll_evento ure
         left join usuario_roll_item uri on uri.usuario_roll_evento_id = ure.id
         group by ure.id
         order by ure.codigo_evento`
      ),
      req.query.edit ? query(
        `select ure.*
         from usuario_roll_evento ure
         where ure.id = $1`,
        [req.query.edit]
      ) : Promise.resolve({ rows: [] })
    ]);
    res.render("usuario_roll_eventos", {
      title: "Eventos",
      eventos: eventos.rows,
      editEvento: editEvento.rows[0] || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/usuario-roll-eventos", requireAuth, async (req, res) => {
  try {
    const creadoPor = currentUser(req);
    await withTransaction(async (client) => {
      const eventResult = await client.query(
        `insert into usuario_roll_evento
           (nombre, descripcion, codigo_evento, activo, creado_por)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          String(req.body.nombre || "").trim(),
          String(req.body.descripcion || "").trim() || null,
          String(req.body.codigo_evento || "").trim(),
          req.body.activo === "on",
          creadoPor
        ]
      );
      await client.query(
        `insert into usuario_roll_item
           (usuario_roll_id, usuario_roll_evento_id, activo, creado_por)
         select id, $1, true, $2
         from usuario_roll
         where activo = true
         on conflict (usuario_roll_id, usuario_roll_evento_id) do nothing`,
        [eventResult.rows[0].id, creadoPor]
      );
    });
    setFlash(req, "success", "Evento creado.");
    res.redirect("/usuario-roll-eventos");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect("/usuario-roll-eventos");
  }
});

app.post("/usuario-roll-eventos/:id", requireAuth, async (req, res) => {
  try {
    await query(
      `update usuario_roll_evento set descripcion = $1, activo = $2 where id = $3`,
      [String(req.body.descripcion || "").trim() || null, req.body.activo === "on", req.params.id]
    );
    setFlash(req, "success", "Evento actualizado.");
    res.redirect("/usuario-roll-eventos");
  } catch (error) {
    setFlash(req, "error", userErrorMessage(error));
    res.redirect(`/usuario-roll-eventos?edit=${req.params.id}`);
  }
});

app.post("/usuario-roll-eventos/:id/toggle", requireAuth, async (req, res, next) => {
  try {
    await query(`update usuario_roll_evento set activo = not activo where id = $1`, [req.params.id]);
    setFlash(req, "success", "Estado del evento actualizado.");
    res.redirect("/usuario-roll-eventos");
  } catch (error) {
    next(error);
  }
});

async function getCrudOptions(fields) {
  const optionEntries = await Promise.all(fields.map(async (field) => {
    if (field.optionsTable === "grupo_cliente") {
      const result = await query(`select id, nombre, razon_social, ruc, direccion, telefono, email from grupo_cliente where activo = true order by nombre`);
      return [field.name, result.rows];
    }
    if (field.optionsTable === "servicio_grupo") {
      const result = await query(`select id, nombre from servicio_grupo where activo = true order by nombre`);
      return [field.name, result.rows];
    }
    return [field.name, []];
  }));
  return Object.fromEntries(optionEntries);
}

function crudUploadMiddleware(fields, pathName) {
  const imageField = fields.find((field) => field.type === "image");
  if (!imageField) {
    return (req, res, next) => next();
  }
  return (req, res, next) => {
    req.crudImageFolder = publicUploadFolder(imageField);
    imageUpload.single(imageField.name)(req, res, (error) => {
      if (!error) return next();
      setFlash(req, "error", userErrorMessage(error));
      res.redirect(req.params.id ? `/${pathName}?edit=${req.params.id}` : `/${pathName}`);
    });
  };
}

function crudValues(fields, req, omitEmptyImage) {
  return fields.reduce((acc, field) => {
    if (field.type === "image") {
      if (req.file) {
        const publicPath = path.posix.join("/uploads", publicUploadFolder(field), req.file.filename);
        acc.push({ name: field.name, value: publicPath });
      } else if (req.body[`${field.name}_path`] !== undefined) {
        const currentPath = String(req.body[`${field.name}_path`] || "").trim();
        if (currentPath || !omitEmptyImage) {
          acc.push({ name: field.name, value: currentPath || null });
        }
      } else if (!omitEmptyImage) {
        acc.push({ name: field.name, value: null });
      }
      return acc;
    }
    acc.push({ name: field.name, value: fieldValue(req.body[field.name], field) });
    return acc;
  }, []);
}

function crudRoutes(pathName, table, fields, title, authorization = {}) {
  const uploadMiddleware = crudUploadMiddleware(fields, pathName);
  const accessMiddleware = [
    requireAuth,
    authorization.item ? requireItem(authorization.item) : null
  ].filter(Boolean);
  const mutationMiddleware = [
    ...accessMiddleware,
    authorization.event ? requireEvent(authorization.event) : null
  ].filter(Boolean);

  app.get(`/${pathName}`, ...accessMiddleware, async (req, res, next) => {
    try {
      const editId = req.query.edit;
      const searchTerm = String(req.query.q || "").trim();
      const isLargeClientList = pathName === "clientes";
      const limit = isLargeClientList ? 100 : null;
      const offset = isLargeClientList ? Math.max(0, Number(req.query.offset || 0) || 0) : 0;
      let itemsQuery = `select * from ${table} order by id desc`;
      let countPromise = Promise.resolve({ rows: [{ total: 0 }] });
      let itemsParams = [];
      if (isLargeClientList) {
        const searchSql = searchTerm
          ? `where chapa ilike $1
              or marca_modelo ilike $1
              or coalesce(nombre, '') ilike $1
              or coalesce(ruc, '') ilike $1
              or coalesce(telefono, '') ilike $1
              or coalesce(email, '') ilike $1`
          : "";
        const searchParams = searchTerm ? [`%${searchTerm}%`] : [];
        countPromise = query(`select count(*)::int as total from ${table} ${searchSql}`, searchParams);
        itemsParams = searchTerm ? [`%${searchTerm}%`, limit, offset] : [limit, offset];
        itemsQuery = searchTerm
          ? `select * from ${table} ${searchSql} order by id desc limit $2 offset $3`
          : `select * from ${table} order by id desc limit $1 offset $2`;
      }
      const [items, editItem, optionsByField, countResult] = await Promise.all([
        query(itemsQuery, itemsParams),
        editId ? query(`select * from ${table} where id = $1`, [editId]) : Promise.resolve({ rows: [] }),
        getCrudOptions(fields),
        countPromise
      ]);
      const totalItems = isLargeClientList ? Number(countResult.rows[0].total || 0) : items.rows.length;
      const relatedClientsByGroup = {};
      const relatedServicesByGroup = {};
      const relatedPersonalById = {};
      const relatedClientLavadosById = {};
      const relatedClientsMetaByGroup = {};
      const selectedRelatedId = req.query.related || "";
      const relatedTab = req.query.tab === "vales" ? "vales" : "lavados";
      const relatedLimit = 100;
      const clientLavadosLimit = 50;
      const clientLavadosOffset = Math.max(0, Number(req.query.client_lavados_offset || 0) || 0);
      const groupClientsOffset = Math.max(0, Number(req.query.group_clients_offset || 0) || 0);
      const lavadosOffset = Math.max(0, Number(req.query.lavados_offset || 0) || 0);
      const valesOffset = Math.max(0, Number(req.query.vales_offset || 0) || 0);
      if (pathName === "clientes" && items.rows.length) {
        const clientIds = items.rows.map((item) => item.id);
        for (const client of items.rows) {
          const clientId = String(client.id);
          relatedClientLavadosById[clientId] = {
            lavados: [],
            total: 0,
            offset: selectedRelatedId === clientId ? clientLavadosOffset : 0
          };
        }

        const lavadosCount = await query(
          `select cliente_id, count(*)::int as total
           from lavados
           where cliente_id = any($1::int[])
           group by cliente_id`,
          [clientIds]
        );
        lavadosCount.rows.forEach((row) => {
          relatedClientLavadosById[String(row.cliente_id)].total = Number(row.total || 0);
        });

        for (const client of items.rows) {
          const clientId = String(client.id);
          const currentOffset = selectedRelatedId === clientId ? clientLavadosOffset : 0;
          const lavadosResult = await query(
            `select l.*,
                    coalesce(string_agg(distinct p.nombre, ', ' order by p.nombre), '') as personal_nombre,
                    fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
             from lavados l
             left join lavado_personal lp on lp.lavado_id = l.id
             left join personal p on p.id = lp.personal_id
             join formas_pago fp on fp.id = l.forma_pago_id
             where l.cliente_id = $1
             group by l.id, fp.nombre, fp.icono_ruta, fp.color
             order by l.creado_en desc, l.id desc
             limit $2 offset $3`,
            [client.id, clientLavadosLimit, currentOffset]
          );
          relatedClientLavadosById[clientId].lavados = lavadosResult.rows;
        }
      }
      if (pathName === "grupo-clientes" && items.rows.length) {
        const groupIds = items.rows.map((item) => item.id);
        for (const group of items.rows) {
          const groupId = String(group.id);
          relatedClientsByGroup[groupId] = [];
          relatedClientsMetaByGroup[groupId] = {
            total: 0,
            offset: selectedRelatedId === groupId ? groupClientsOffset : 0,
            limit: relatedLimit
          };
        }

        const clientsCount = await query(
          `select grupo_cliente_id, count(*)::int as total
           from clientes
           where grupo_cliente_id = any($1::int[])
           group by grupo_cliente_id`,
          [groupIds]
        );
        clientsCount.rows.forEach((row) => {
          relatedClientsMetaByGroup[String(row.grupo_cliente_id)].total = Number(row.total || 0);
        });

        for (const group of items.rows) {
          const groupId = String(group.id);
          const currentOffset = selectedRelatedId === groupId ? groupClientsOffset : 0;
          const clients = await query(
            `select id, chapa, marca_modelo, nombre, ruc, telefono, email, grupo_cliente_id
             from clientes
             where grupo_cliente_id = $1
             order by chapa, id
             limit $2 offset $3`,
            [group.id, relatedLimit, currentOffset]
          );
          relatedClientsByGroup[groupId] = clients.rows;
        }
      }
      if (pathName === "servicio-grupos") {
        const services = await query(
          `select id, nombre, precio_base, activo, servicio_grupo_id
           from servicios
           where servicio_grupo_id is not null
           order by nombre, id`
        );
        services.rows.forEach((service) => {
          const groupId = String(service.servicio_grupo_id);
          if (!relatedServicesByGroup[groupId]) relatedServicesByGroup[groupId] = [];
          relatedServicesByGroup[groupId].push(service);
        });
      }
      if (pathName === "personal" && items.rows.length) {
        const personalIds = items.rows.map((item) => item.id);
        for (const personal of items.rows) {
          const personalId = String(personal.id);
          relatedPersonalById[personalId] = {
            lavados: [],
            lavadosTotal: 0,
            lavadosOffset: selectedRelatedId === personalId ? lavadosOffset : 0,
            vales: [],
            valesTotal: 0,
            valesOffset: selectedRelatedId === personalId ? valesOffset : 0
          };
        }

        const lavadosCount = await query(
          `select lp.personal_id, count(*)::int as total
           from lavado_personal lp
           join lavados l on l.id = lp.lavado_id
           where lp.personal_id = any($1::int[])
           group by lp.personal_id`,
          [personalIds]
        );
        lavadosCount.rows.forEach((row) => {
          relatedPersonalById[String(row.personal_id)].lavadosTotal = Number(row.total || 0);
        });

        const valesCount = await query(
          `select personal_id, count(*)::int as total
           from vales_personal
           where personal_id = any($1::int[])
           group by personal_id`,
          [personalIds]
        );
        valesCount.rows.forEach((row) => {
          relatedPersonalById[String(row.personal_id)].valesTotal = Number(row.total || 0);
        });

        for (const personal of items.rows) {
          const personalId = String(personal.id);
          const currentLavadosOffset = selectedRelatedId === personalId ? lavadosOffset : 0;
          const currentValesOffset = selectedRelatedId === personalId ? valesOffset : 0;
          const [lavadosResult, valesResult] = await Promise.all([
            query(
              `select l.*, c.chapa, c.marca_modelo, g.nombre as grupo_cliente_nombre,
                      fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
               from lavados l
               join clientes c on c.id = l.cliente_id
               left join grupo_cliente g on g.id = c.grupo_cliente_id
               join lavado_personal lp on lp.lavado_id = l.id
               join personal p on p.id = lp.personal_id
               join formas_pago fp on fp.id = l.forma_pago_id
               where lp.personal_id = $1
               order by l.creado_en desc, l.id desc
               limit $2 offset $3`,
              [personal.id, relatedLimit, currentLavadosOffset]
            ),
            query(
              `select v.*, fp.nombre as forma_pago, fp.icono_ruta as forma_pago_icono, fp.color as forma_pago_color
               from vales_personal v
               join formas_pago fp on fp.id = v.forma_pago_id
               where v.personal_id = $1
               order by v.fecha_pago desc, v.id desc
               limit $2 offset $3`,
              [personal.id, relatedLimit, currentValesOffset]
            )
          ]);
          relatedPersonalById[personalId].lavados = lavadosResult.rows;
          relatedPersonalById[personalId].vales = valesResult.rows;
        }
      }
      res.render("crud", {
        title,
        pathName,
        fields,
        items: items.rows,
        editItem: editItem.rows[0] || null,
        optionsByField,
        listMeta: {
          q: searchTerm,
          limit,
          offset,
          total: totalItems,
          isPaged: isLargeClientList
        },
        relatedClientsByGroup,
        relatedClientsMetaByGroup,
        relatedServicesByGroup,
        relatedPersonalById,
        relatedClientLavadosById,
        relatedClientLavadosMeta: {
          selectedId: selectedRelatedId,
          limit: clientLavadosLimit
        },
        relatedPersonalMeta: {
          selectedId: selectedRelatedId,
          activeTab: relatedTab,
          limit: relatedLimit
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(`/${pathName}`, ...mutationMiddleware, uploadMiddleware, async (req, res, next) => {
    try {
      const entries = crudValues(fields, req, false);
      const names = entries.map((entry) => entry.name);
      const values = entries.map((entry) => entry.value);
      const placeholders = names.map((_, index) => `$${index + 1}`);
      await query(
        `insert into ${table} (${names.join(", ")}, creado_por) values (${placeholders.join(", ")}, $${names.length + 1})`,
        [...values, currentUser(req)]
      );
      setFlash(req, "success", "Registro creado.");
      res.redirect(`/${pathName}`);
    } catch (error) {
      setFlash(req, "error", userErrorMessage(error));
      res.redirect(`/${pathName}`);
    }
  });

  app.post(`/${pathName}/:id`, ...mutationMiddleware, uploadMiddleware, async (req, res, next) => {
    try {
      const entries = crudValues(fields, req, true);
      const names = entries.map((entry) => entry.name);
      const values = entries.map((entry) => entry.value);
      const sets = names.map((name, index) => `${name} = $${index + 1}`);
      await query(`update ${table} set ${sets.join(", ")} where id = $${names.length + 1}`, [...values, req.params.id]);
      setFlash(req, "success", "Registro actualizado.");
      res.redirect(`/${pathName}`);
    } catch (error) {
      setFlash(req, "error", userErrorMessage(error));
      res.redirect(`/${pathName}?edit=${req.params.id}`);
    }
  });

  app.post(`/${pathName}/:id/toggle`, ...mutationMiddleware, async (req, res, next) => {
    try {
      await query(`update ${table} set activo = not activo where id = $1`, [req.params.id]);
      setFlash(req, "success", "Estado actualizado.");
      res.redirect(`/${pathName}`);
    } catch (error) {
      next(error);
    }
  });
}

function fieldValue(value, field) {
  if (field.type === "checkbox") return value === "on";
  if (field.type === "money") return toMoney(value);
  if (field.type === "select") return value ? Number(value) : null;
  if (field.uppercase) return value ? value.trim().toUpperCase() : value;
  return value === "" ? null : value;
}

crudRoutes("grupo-clientes", "grupo_cliente", [
  { name: "nombre", label: "Nombre", required: true },
  { name: "razon_social", label: "Razon social", uppercase: true },
  { name: "ruc", label: "RUC", uppercase: true },
  { name: "direccion", label: "Direccion", uppercase: true },
  { name: "telefono", label: "Telefono", uppercase: true },
  { name: "email", label: "Email", type: "email" },
  { name: "es_credito", label: "Es credito", type: "checkbox" },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Grupos de clientes");

crudRoutes("servicio-grupos", "servicio_grupo", [
  { name: "nombre", label: "Nombre", required: true },
  { name: "imagen", label: "Imagen PNG", type: "image" },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Grupos de servicios", { item: "servicio", event: "servicio-bloqueo" });

crudRoutes("clientes", "clientes", [
  { name: "chapa", label: "Chapa", required: true, uppercase: true },
  { name: "marca_modelo", label: "Marca/modelo", required: true, uppercase: true },
  { name: "ruc", label: "RUC", uppercase: true },
  { name: "nombre", label: "Nombre", uppercase: true },
  { name: "direccion", label: "Direccion", uppercase: true },
  { name: "telefono", label: "Telefono", uppercase: true },
  { name: "email", label: "Email", type: "email" },
  { name: "grupo_cliente_id", label: "Grupo cliente", type: "select", optionsTable: "grupo_cliente" },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Clientes");

crudRoutes("servicios", "servicios", [
  { name: "servicio_grupo_id", label: "Grupo servicio", type: "select", optionsTable: "servicio_grupo" },
  { name: "nombre", label: "Nombre", required: true },
  { name: "precio_base", label: "Precio base", type: "money", required: true },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Servicios", { item: "servicio", event: "servicio-bloqueo" });

crudRoutes("personal", "personal", [
  { name: "nombre", label: "Nombre", required: true },
  { name: "telefono", label: "Telefono" },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Personal");

crudRoutes("gasto-tipos", "gasto_tipo", [
  { name: "nombre", label: "Nombre", required: true, uppercase: true },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Gastos tipo");

crudRoutes("formas-pago", "formas_pago", [
  { name: "nombre", label: "Nombre", required: true, uppercase: true },
  { name: "icono_ruta", label: "Icono PNG", type: "image", uploadFolder: "formas-pago" },
  { name: "color", label: "Color", type: "color" },
  { name: "mostrar_despues_crear", label: "Mostrar despues de crear", type: "checkbox" },
  { name: "activo", label: "Activo", type: "checkbox" }
], "Formas de pago");

app.use((req, res) => {
  res.status(404).render("error", { title: "No encontrado", message: "Pagina no encontrada." });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", { title: "Error", message: error.message || "Ocurrio un error." });
});

app.listen(config.port, () => {
  console.log(`Lavadero listo en http://localhost:${config.port}`);
  startTelegramBot();
});
