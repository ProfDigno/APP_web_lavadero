const path = require("path");
const ExcelJS = require("exceljs");
const { pool, withTransaction } = require("./db");

const EXCEL_FILE = path.join(__dirname, "..", "Lista_cliente.xlsx");
const CREATED_BY = "Importacion Excel";

function text(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.text !== undefined) return text(value.text);
    if (value.result !== undefined) return text(value.result);
    if (value.richText) return value.richText.map((part) => part.text || "").join("").trim();
  }
  return String(value).trim();
}

function checked(value) {
  return text(value).toLowerCase() === "checked";
}

function upperOrNull(value) {
  const normalized = text(value).toUpperCase();
  return normalized || null;
}

function valueOrNull(value) {
  const normalized = text(value);
  return normalized || null;
}

function chapaBase(value, excelId) {
  const raw = text(value).toUpperCase().replace(/\s+/g, "");
  if (raw) return raw.slice(0, 30);
  return `SINCHAPA-${excelId}`.slice(0, 30);
}

function uniqueChapa(base, excelId, used) {
  let candidate = base.slice(0, 30);
  if (!used.has(candidate)) {
    used.add(candidate);
    return { chapa: candidate, generated: false };
  }

  const suffix = `-${excelId}`.toUpperCase();
  candidate = `${base.slice(0, Math.max(1, 30 - suffix.length))}${suffix}`;
  let counter = 2;
  while (used.has(candidate)) {
    const counterSuffix = `-${counter}`;
    candidate = `${base.slice(0, Math.max(1, 30 - suffix.length - counterSuffix.length))}${suffix}${counterSuffix}`;
    counter += 1;
  }
  used.add(candidate);
  return { chapa: candidate, generated: true };
}

function readRows(workbook) {
  const groupSheet = workbook.getWorksheet("cliente grupo");
  const clientSheet = workbook.getWorksheet("cliente");
  if (!groupSheet) throw new Error("No existe la hoja 'cliente grupo'.");
  if (!clientSheet) throw new Error("No existe la hoja 'cliente'.");

  const groups = [];
  for (let rowNumber = 2; rowNumber <= groupSheet.rowCount; rowNumber += 1) {
    const row = groupSheet.getRow(rowNumber);
    const externalId = text(row.getCell(2).value);
    const nombre = text(row.getCell(4).value);
    if (!externalId && !nombre) continue;
    if (!externalId) throw new Error(`Grupo sin grupo_id en fila ${rowNumber}.`);
    if (!nombre) throw new Error(`Grupo sin nombre en fila ${rowNumber}.`);
    groups.push({
      rowNumber,
      externalId,
      nombre: nombre.toUpperCase(),
      esCredito: checked(row.getCell(5).value)
    });
  }

  const groupExternalIds = new Set(groups.map((group) => group.externalId));
  const usedChapas = new Set();
  const clients = [];
  const generatedChapas = [];
  const blankChapas = [];
  const duplicateChapas = [];
  const seenRawChapas = new Map();

  for (let rowNumber = 2; rowNumber <= clientSheet.rowCount; rowNumber += 1) {
    const row = clientSheet.getRow(rowNumber);
    const externalId = text(row.getCell(2).value);
    if (!externalId) continue;

    const rawChapa = text(row.getCell(4).value).toUpperCase().replace(/\s+/g, "");
    const base = chapaBase(rawChapa, externalId);
    const unique = uniqueChapa(base, externalId, usedChapas);
    if (!rawChapa) blankChapas.push({ rowNumber, externalId, chapa: unique.chapa });
    if (rawChapa && seenRawChapas.has(rawChapa)) duplicateChapas.push({ rowNumber, externalId, original: rawChapa, chapa: unique.chapa });
    if (rawChapa && !seenRawChapas.has(rawChapa)) seenRawChapas.set(rawChapa, rowNumber);
    if (!rawChapa || unique.generated) generatedChapas.push({ rowNumber, externalId, original: rawChapa || "", chapa: unique.chapa });

    const groupExternalId = text(row.getCell(11).value);
    if (groupExternalId && !groupExternalIds.has(groupExternalId)) {
      throw new Error(`Cliente fila ${rowNumber} referencia grupo_id inexistente: ${groupExternalId}.`);
    }

    clients.push({
      rowNumber,
      externalId,
      chapa: unique.chapa,
      marcaModelo: upperOrNull(row.getCell(5).value) || "SIN MARCA/MODELO",
      direccion: upperOrNull(row.getCell(6).value),
      telefono: upperOrNull(row.getCell(7).value),
      ruc: upperOrNull(row.getCell(8).value),
      activo: checked(row.getCell(9).value),
      nombre: upperOrNull(row.getCell(10).value),
      groupExternalId
    });
  }

  return { groups, clients, generatedChapas, blankChapas, duplicateChapas };
}

function printSummary(data, prefix = "Resumen") {
  const withGroup = data.clients.filter((client) => client.groupExternalId).length;
  console.log(`${prefix}:`);
  console.log(`- Grupos en Excel: ${data.groups.length}`);
  console.log(`- Clientes en Excel: ${data.clients.length}`);
  console.log(`- Clientes con grupo: ${withGroup}`);
  console.log(`- Chapas vacias corregidas: ${data.blankChapas.length}`);
  console.log(`- Chapas duplicadas corregidas: ${data.duplicateChapas.length}`);
  console.log(`- Chapas generadas total: ${data.generatedChapas.length}`);
}

async function resetSequences(client) {
  const tables = ["grupo_cliente", "clientes", "grupo_cliente_creditos", "lavados", "lavado_servicios", "comisiones_diarias"];
  for (const table of tables) {
    const result = await client.query(`select pg_get_serial_sequence($1, 'id') as sequence_name`, [table]);
    const sequenceName = result.rows[0] && result.rows[0].sequence_name;
    if (sequenceName) await client.query(`alter sequence ${sequenceName} restart with 1`);
  }
}

async function importData(data) {
  const summary = await withTransaction(async (client) => {
    await client.query("delete from lavado_servicios");
    await client.query("delete from lavados");
    await client.query("delete from grupo_cliente_creditos");
    await client.query("delete from comisiones_diarias");
    await client.query("delete from clientes");
    await client.query("delete from grupo_cliente");
    await resetSequences(client);

    const groupMap = new Map();
    for (const group of data.groups) {
      const result = await client.query(
        `insert into grupo_cliente (nombre, es_credito, activo, creado_por)
         values ($1, $2, true, $3)
         returning id`,
        [group.nombre, group.esCredito, CREATED_BY]
      );
      groupMap.set(group.externalId, result.rows[0].id);
    }

    let clientsWithGroup = 0;
    for (const item of data.clients) {
      const groupId = item.groupExternalId ? groupMap.get(item.groupExternalId) : null;
      if (groupId) clientsWithGroup += 1;
      await client.query(
        `insert into clientes
           (chapa, marca_modelo, ruc, nombre, direccion, telefono, email, grupo_cliente_id, activo, creado_por)
         values ($1, $2, $3, $4, $5, $6, null, $7, $8, $9)`,
        [
          item.chapa,
          item.marcaModelo,
          item.ruc,
          item.nombre,
          item.direccion,
          item.telefono,
          groupId,
          item.activo,
          CREATED_BY
        ]
      );
    }

    const vales = await client.query(
      `select fecha_pago, personal_id, coalesce(sum(monto), 0) as total_vales
       from vales_personal
       where estado = 'EMITIDO'
       group by fecha_pago, personal_id`
    );
    for (const vale of vales.rows) {
      await client.query(
        `insert into comisiones_diarias
           (fecha, personal_id, total_lavados_emitidos, total_servicios, total_comision_40, total_vales, creado_por)
         values ($1, $2, 0, 0, 0, $3, $4)
         on conflict (fecha, personal_id) do update set total_vales = excluded.total_vales`,
        [vale.fecha_pago, vale.personal_id, vale.total_vales, CREATED_BY]
      );
    }

    return {
      groupsCreated: data.groups.length,
      clientsCreated: data.clients.length,
      clientsWithGroup,
      valesRecalculated: vales.rows.length
    };
  });
  return summary;
}

async function main() {
  const mode = process.argv.includes("--execute") ? "execute" : "validate";
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_FILE);
  const data = readRows(workbook);
  printSummary(data, mode === "execute" ? "Resumen previo" : "Validacion");

  if (mode !== "execute") {
    console.log("Validacion completada sin modificar la base. Use --execute para importar.");
    return;
  }

  const summary = await importData(data);
  console.log("Importacion completada:");
  console.log(`- Grupos creados: ${summary.groupsCreated}`);
  console.log(`- Clientes creados: ${summary.clientsCreated}`);
  console.log(`- Clientes asociados a grupo: ${summary.clientsWithGroup}`);
  console.log(`- Chapas generadas: ${data.generatedChapas.length}`);
  console.log(`- Comisiones de vales recalculadas: ${summary.valesRecalculated}`);
}

main()
  .catch((error) => {
    console.error("No se pudo importar Lista_cliente.xlsx:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
