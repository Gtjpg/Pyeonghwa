
const pool = require("./db");

async function inspectConstraints() {
  try {
    const result = await pool.query(`
      SELECT
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns,
        ccu.table_name AS referenced_table,
        string_agg(ccu.column_name, ', ' ORDER BY kcu.ordinal_position) AS referenced_columns
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.table_schema = 'public'
      GROUP BY
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        ccu.table_name
      ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name
    `);

    console.table(result.rows);
  } catch (error) {
    console.error("Inspection failed:", error.message);
  } finally {
    await pool.end();
  }
}

inspectConstraints();
