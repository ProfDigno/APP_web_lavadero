require("dotenv").config();

module.exports = {
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
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  }
};
