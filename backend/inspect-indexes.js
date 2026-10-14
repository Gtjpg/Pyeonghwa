
const pool = require("./db");

async function inspectIds() {
  try {
    const result = await pool.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_identity,
        identity_generation,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'id'
      ORDER BY table_name
    `);

    console.table(result.rows);
  } catch (error) {
    console.error(error.message);
  } finally {
    await pool.end();
  }
}

inspectIds();
