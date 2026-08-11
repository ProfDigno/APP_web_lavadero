require("dotenv").config();
const fs = require("fs");
const path = require("path");

const appEnv = String(process.env.APP_ENV || "production").trim().toLowerCase();
const isLocal = appEnv === "local";

function localTelegramToken() {
  if (!isLocal) return "";
  try {
    const content = fs.readFileSync(path.join(__dirname, "..", "servidor.txt"), "utf8");
    const match = content.match(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/);
    return match ? match[0] : "";
  } catch (_error) {
    return "";
  }
}

const telegramToken = localTelegramToken() || (isLocal ? "" : process.env.TELEGRAM_BOT_TOKEN || "");

module.exports = {
  appEnv,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || "lavadero-local-secret",
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "bdlavadero_a1",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "4650586"
  },
  admin: {
    login: process.env.ADMIN_LOGIN || "admin",
    password: process.env.ADMIN_PASSWORD || "admin123",
    name: process.env.ADMIN_NAME || "Administrador"
  },
  telegram: {
    token: telegramToken,
    universalPin: String(process.env.TELEGRAM_UNIVERSAL_PIN || "").trim(),
    allowedChatIds: String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  },
  plateRecognizer: {
    token: process.env.PLATE_RECOGNIZER_TOKEN || ""
  }
};
