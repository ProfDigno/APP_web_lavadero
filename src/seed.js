const bcrypt = require("bcryptjs");
const config = require("./config");
const { pool, withTransaction } = require("./db");

const formasPago = [
  { nombre: "LAVADO", icono: "car-wash", color: "#075985" },
  { nombre: "CREDITO", icono: "dollar-broken", color: "#b42318" },
  { nombre: "EFECTIVO", icono: "dollar", color: "#137333" },
  { nombre: "TRANSFERENCIA", icono: "bank", color: "#c2410c" },
  { nombre: "TARJETA_DEBITO", icono: "card", color: "#65a30d" },
  { nombre: "TARJETA_CREDITO", icono: "card", color: "#9a3412" },
  { nombre: "ANULADO", icono: "cross", color: "#6b7280", mostrar: false }
];

async function seed() {
  await withTransaction(async (client) => {
    const passwordHash = await bcrypt.hash(config.admin.password, 10);
    await client.query(
      `insert into usuarios (login, password_hash, nombre, activo, creado_por)
       values ($1, $2, $3, true, $3)
       on conflict (login) do update set
         usuario_roll_id = coalesce(usuarios.usuario_roll_id, (select id from usuario_roll where roll = 'ADMINISTRADOR'))`,
      [config.admin.login, passwordHash, config.admin.name]
    );

    await client.query(
      `update usuarios
       set usuario_roll_id = (select id from usuario_roll where roll = 'ADMINISTRADOR')
       where login = $1 and usuario_roll_id is null`,
      [config.admin.login]
    );

    for (const forma of formasPago) {
      await client.query(
        `insert into formas_pago (nombre, icono_ruta, color, mostrar_despues_crear, activo, creado_por)
         values ($1, $2, $3, $4, true, $5)
         on conflict (nombre) do nothing`,
        [forma.nombre, forma.icono, forma.color, forma.mostrar !== false, config.admin.name]
      );
    }
  });

  console.log("Datos iniciales cargados.");
}

seed()
  .catch((error) => {
    console.error("No se pudieron cargar los datos iniciales:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
