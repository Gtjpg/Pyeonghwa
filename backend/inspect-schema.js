
const pool = require("./db");

async function inspectSchema() {
  try {
    const result = await pool.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    let currentTable = "";

    for (const row of result.rows) {
      if (row.table_name !== currentTable) {
        currentTable = row.table_name;
        console.log(`\nTABLE: ${currentTable}`);
      }

      console.log(
        `  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable} | default=${row.column_default ?? "none"}`
      );
    }
  } catch (error) {
    console.error("Schema inspection failed:", error.message);
  } finally {
    await pool.end();
  }
}

inspectSchema();
