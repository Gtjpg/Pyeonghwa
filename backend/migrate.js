const pool = require("./db");

async function columnExists(client, table, column) {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND column_name = $2
    `,
    [table, column],
  );

  return result.rows.length > 0;
}

/**
 * Brings the database up to date every time the server starts.
 * Every step checks first, so running it again changes nothing.
 */
async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. When each conversation last had a message (chat list order)
    if (!(await columnExists(client, "conversations", "last_message_at"))) {
      await client.query(
        `ALTER TABLE conversations ADD COLUMN last_message_at TIMESTAMPTZ`,
      );

      await client.query(`
        UPDATE conversations c
        SET last_message_at = m.latest
        FROM (
          SELECT room, MAX(created_at) AS latest
          FROM messages
          GROUP BY room
        ) m
        WHERE m.room = 'conversation_' || c.id
      `);
    }

    // 2. Unread counts and last-message previews
    await client.query(`
      ALTER TABLE conversation_members
        ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0
    `);

    if (!(await columnExists(client, "conversations", "last_message_text"))) {
      await client.query(`
        ALTER TABLE conversations
          ADD COLUMN last_message_text TEXT,
          ADD COLUMN last_message_sender TEXT
      `);

      await client.query(`
        UPDATE conversations c
        SET last_message_text = m.content,
            last_message_sender = m.username
        FROM (
          SELECT DISTINCT ON (room) room, content, username
          FROM messages
          ORDER BY room, created_at DESC
        ) m
        WHERE m.room = 'conversation_' || c.id
          AND c.keep_history = true
      `);
    }

    // 3. Unique short user IDs (8 characters, no 0/O/1/I)
    await client.query(`
      CREATE OR REPLACE FUNCTION generate_public_id() RETURNS TEXT AS $$
      DECLARE
        alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        candidate TEXT;
      BEGIN
        LOOP
          candidate := '';
          FOR i IN 1..8 LOOP
            candidate := candidate ||
              substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
          END LOOP;

          EXIT WHEN NOT EXISTS (
            SELECT 1 FROM users WHERE public_id = candidate
          );
        END LOOP;

        RETURN candidate;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id TEXT`,
    );
    await client.query(
      `UPDATE users SET public_id = generate_public_id() WHERE public_id IS NULL`,
    );
    await client.query(
      `ALTER TABLE users ALTER COLUMN public_id SET DEFAULT generate_public_id()`,
    );
    await client.query(
      `ALTER TABLE users ALTER COLUMN public_id SET NOT NULL`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_key ON users (public_id)`,
    );
    
    
    
    // 4. Image messages
    await client.query(`
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text',
        ADD COLUMN IF NOT EXISTS image_url TEXT
    `);

    const imageConstraint = await client.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'messages_message_type_check'
        AND conrelid = 'messages'::regclass
    `);

    if (imageConstraint.rows.length === 0) {
      await client.query(`
        ALTER TABLE messages
        ADD CONSTRAINT messages_message_type_check
        CHECK (message_type IN ('text', 'image'))
      `);
    }


    // 4. Message requests between users
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_requests (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        responded_at TIMESTAMPTZ,
        CHECK (sender_id <> receiver_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS message_requests_receiver_status_idx
      ON message_requests (receiver_id, status)
    `);


    // 6. Remove empty conversations (no members) that the old
    //    POST /conversations left behind every time a request was refused.
    await client.query(`
      DELETE FROM conversations c
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversation_members m
        WHERE m.conversation_id = c.id
      )
    `);

    await client.query("COMMIT");
    console.log("Database is up to date");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };