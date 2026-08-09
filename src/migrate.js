const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

async function migrate() {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
    console.log(`Migracion aplicada: ${file}`);
  }
}

migrate()
  .catch((error) => {
    console.error("No se pudo aplicar la migracion:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
