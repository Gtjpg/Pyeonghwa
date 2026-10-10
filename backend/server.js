const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("./db");
const { runMigrations } = require("./migrate");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

app.use(express.json());

app.use(express.static("public"));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("No token provided"));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    socket.userId = decoded.userId;
    socket.username = decoded.username;

    next();
  } catch (error) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Personal room so we can notify this user about activity in any of their chats.
  socket.join(`user_${socket.userId}`);

  socket.on("join_room", async (room) => {
    try {
      // Validate the room name.
      if (typeof room !== "string" || !/^conversation_\d+$/.test(room)) {
        console.log("Invalid room requested:", room);
        return;
      }

      const conversationId = Number(room.replace("conversation_", ""));

      // Check whether this user belongs to the conversation.
      const membership = await pool.query(
        `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id = $2
      `,
        [conversationId, socket.userId],
      );

      // Reject users who are not members.
      if (membership.rows.length === 0) {
        console.log(`User ${socket.userId} denied access to ${room}`);
        return;
      }

      // Join only after membership is confirmed.
      await socket.join(room);

      console.log(`${socket.username} joined ${room}`);

      // Load saved messages only for authorized members.
      const result = await pool.query(
        `
      SELECT id, username, content, created_at
      FROM messages
      WHERE room = $1
      ORDER BY created_at ASC
      `,
        [room],
      );

      socket.emit("chat_history", result.rows);
    } catch (error) {
      console.error("Failed to join room:", error);
    }
  });

  socket.on("chat_message", async (data) => {
    try {
      const conversationId = Number(data.room.replace("conversation_", ""));

      const members = await pool.query(
        `
      SELECT user_id
      FROM conversation_members
      WHERE conversation_id = $1
      `,
        [conversationId],
      );

      const isMember = members.rows.some(
        (member) => member.user_id === socket.userId,
      );

      if (!isMember) {
        console.log(
          `User ${socket.userId} tried to send to unauthorized room ${data.room}`,
        );

        return;
      }

      // The database decides whether this chat saves history, not the client.
      const settings = await pool.query(
        `SELECT keep_history FROM conversations WHERE id = $1`,
        [conversationId],
      );
      const keepHistory = settings.rows[0]?.keep_history === true;

      if (keepHistory) {
        await pool.query(
          `
        INSERT INTO messages (room, username, content)
        VALUES ($1, $2, $3)
        `,
          [data.room, socket.username, data.message],
        );
      }

      io.to(data.room).emit("chat_message", {
        room: data.room,
        username: socket.username,
        message: data.message,
        keepHistory,
      });

      // Track the latest activity and the preview shown in the chat list.
      // The preview text is only stored when this chat saves history.
      await pool.query(
        `
        UPDATE conversations
        SET last_message_at = NOW(),
            last_message_text = $2,
            last_message_sender = $3
        WHERE id = $1
        `,
        [
          conversationId,
          keepHistory ? String(data.message).slice(0, 200) : null,
          keepHistory ? socket.username : null,
        ],
      );

      // Everyone except the sender now has one more unread message.
      await pool.query(
        `
        UPDATE conversation_members
        SET unread_count = unread_count + 1
        WHERE conversation_id = $1
          AND user_id <> $2
        `,
        [conversationId, socket.userId],
      );

      // Tell every member (even if they have another chat open) so their list can reorder.
      for (const member of members.rows) {
        io.to(`user_${member.user_id}`).emit("conversation_activity", {
          conversationId,
          room: data.room,
          username: socket.username,
          message: data.message,
        });
      }
    } catch (error) {
      console.log("Message error:", error);
    }
  });
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  const token = authHeader?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      message: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(403).json({
      message: "Invalid or expired token",
    });
  }
}

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      message: "PostgreSQL connected",
      time: result.rows[0].now,
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Database connection failed",
    });
  }
});

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      message: "Username, email, and password are required",
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (username, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, email, public_id
      `,
      [username, email, passwordHash],
    );

    res.status(201).json({
      message: "Account created successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Failed to create account",
    });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      message: "Username and password are required",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM users
      WHERE username = $1
      `,
      [username],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid username or password",
      });
    }

    const user = result.rows[0];

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({
        message: "Invalid username or password",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        public_id: user.public_id,
      },
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Login failed",
    });
  }
});

app.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, public_id FROM users WHERE id = $1`,
      [req.user.userId],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "User no longer exists",
      });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.log("Session check error:", error);

    res.status(500).json({
      message: "Failed to check session",
    });
  }
});

app.get("/users/search", authenticateToken, async (req, res) => {
  // Only an exact ID matches, so nobody can browse or guess through the user list.
  const publicId = String(req.query.id || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (publicId.length !== 8) {
    return res.status(400).json({
      message: "Enter the 8-character user ID",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, username, public_id
      FROM users
      WHERE public_id = $1
      `,
      [publicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "No user found with that ID",
      });
    }

    const user = result.rows[0];

    res.json({
      user,
      isSelf: String(user.id) === String(req.user.userId),
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Failed to search users",
    });
  }
});

app.post("/message-requests", authenticateToken, async (req, res) => {
  const senderId = req.user.userId;
  const { targetUserId } = req.body;
  const receiverId = Number(targetUserId);

  if (!Number.isInteger(receiverId) || receiverId <= 0) {
    return res.status(400).json({
      message: "A valid target user is required",
    });
  }

  if (senderId === receiverId) {
    return res.status(400).json({
      message: "You cannot send a request to yourself",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Make sure the target user exists.
    const target = await client.query(`SELECT id FROM users WHERE id = $1`, [
      receiverId,
    ]);

    if (target.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        message: "User not found",
      });
    }

    // If these users already have a conversation, don't create a request.
    const existingConversation = await client.query(
      `
      SELECT cm.conversation_id
      FROM conversation_members cm
      WHERE cm.user_id IN ($1, $2)
      GROUP BY cm.conversation_id
      HAVING COUNT(DISTINCT cm.user_id) = 2
        AND (
          SELECT COUNT(*)
          FROM conversation_members cm2
          WHERE cm2.conversation_id = cm.conversation_id
        ) = 2
      LIMIT 1
      `,
      [senderId, receiverId],
    );

    if (existingConversation.rows.length > 0) {
      await client.query("COMMIT");
      return res.status(409).json({
        message: "You already have a conversation with this user",
      });
    }

    // Reuse an existing pending request in either direction.
    const existingRequest = await client.query(
      `
      SELECT id, sender_id, receiver_id, status
      FROM message_requests
      WHERE status = 'pending'
        AND (
          (sender_id = $1 AND receiver_id = $2)
          OR
          (sender_id = $2 AND receiver_id = $1)
        )
      LIMIT 1
      `,
      [senderId, receiverId],
    );

    if (existingRequest.rows.length > 0) {
      await client.query("COMMIT");
      return res.status(409).json({
        message: "A pending request already exists between these users",
      });
    }

    const result = await client.query(
      `
      INSERT INTO message_requests (sender_id, receiver_id)
      VALUES ($1, $2)
      RETURNING id, sender_id, receiver_id, status, created_at
      `,
      [senderId, receiverId],
    );

    await client.query("COMMIT");

    const request = result.rows[0];

    // Notify the recipient if they are currently connected.
    io.to(`user_${receiverId}`).emit("message_request_received", {
      requestId: request.id,
      senderId,
    });

    return res.status(201).json({
      message: "Message request sent",
      request,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Send message request error:", error);

    return res.status(500).json({
      message: "Failed to send message request",
    });
  } finally {
    client.release();
  }
});

app.get("/message-requests/incoming", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        mr.id AS request_id,
        mr.sender_id,
        u.username AS sender_username,
        u.public_id AS sender_public_id,
        mr.created_at
      FROM message_requests mr
      JOIN users u ON u.id = mr.sender_id
      WHERE mr.receiver_id = $1
        AND mr.status = 'pending'
      ORDER BY mr.created_at DESC
      `,
      [req.user.userId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Incoming requests error:", error);

    res.status(500).json({
      message: "Failed to load incoming requests",
    });
  }
});

app.post(
  "/message-requests/:id/respond",
  authenticateToken,
  async (req, res) => {
    const requestId = Number(req.params.id);
    const { action } = req.body;
    const receiverId = req.user.userId;

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        message: "Invalid request ID",
      });
    }

    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({
        message: "Action must be accept or reject",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Lock the request so it cannot be accepted or rejected twice.
      const requestResult = await client.query(
        `
        SELECT id, sender_id, receiver_id, status
        FROM message_requests
        WHERE id = $1
        FOR UPDATE
        `,
        [requestId],
      );

      if (requestResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          message: "Message request not found",
        });
      }

      const request = requestResult.rows[0];

      // Only the recipient can respond.
      if (request.receiver_id !== receiverId) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          message: "You cannot respond to this request",
        });
      }

      if (request.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "This request has already been handled",
        });
      }

      if (action === "reject") {
        await client.query(
          `
          UPDATE message_requests
          SET status = 'rejected',
              responded_at = NOW()
          WHERE id = $1
          `,
          [requestId],
        );

        await client.query("COMMIT");

        io.to(`user_${request.sender_id}`).emit("message_request_rejected", {
          requestId,
        });

        return res.json({
          message: "Message request rejected",
        });
      }

      // Check whether a conversation already exists between these users.
      const existingConversation = await client.query(
        `
        SELECT cm.conversation_id
        FROM conversation_members cm
        WHERE cm.user_id IN ($1, $2)
        GROUP BY cm.conversation_id
        HAVING COUNT(DISTINCT cm.user_id) = 2
          AND (
            SELECT COUNT(*)
            FROM conversation_members cm2
            WHERE cm2.conversation_id = cm.conversation_id
          ) = 2
        LIMIT 1
        `,
        [request.sender_id, request.receiver_id],
      );

      let conversationId;

      if (existingConversation.rows.length > 0) {
        conversationId = existingConversation.rows[0].conversation_id;
      } else {
        const conversationResult = await client.query(
          `INSERT INTO conversations DEFAULT VALUES RETURNING id`,
        );

        conversationId = conversationResult.rows[0].id;

        await client.query(
          `
          INSERT INTO conversation_members (conversation_id, user_id)
          VALUES ($1, $2), ($1, $3)
          `,
          [conversationId, request.sender_id, request.receiver_id],
        );
      }

      await client.query(
        `
        UPDATE message_requests
        SET status = 'accepted',
            responded_at = NOW()
        WHERE id = $1
        `,
        [requestId],
      );

      await client.query("COMMIT");

      const conversation = {
        conversationId,
        room: `conversation_${conversationId}`,
      };

      // Notify the requester and recipient so their interfaces can refresh.

      // Get the username of the user who accepted the request.
      const accepterResult = await client.query(
        `SELECT username FROM users WHERE id = $1`,
        [receiverId],
      );

      const accepterUsername = accepterResult.rows[0]?.username || "Someone";

      // Notify both users so their interfaces can refresh.
      for (const userId of [request.sender_id, request.receiver_id]) {
        io.to(`user_${userId}`).emit("message_request_accepted", {
          requestId,
          conversation,
          username: accepterUsername,
          requesterId: request.sender_id,
        });
      }

      return res.json({
        message: "Message request accepted",
        ...conversation,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Respond to message request error:", error);

      return res.status(500).json({
        message: "Failed to respond to message request",
      });
    } finally {
      client.release();
    }
  },
);

app.post("/conversations", authenticateToken, async (req, res) => {
  const currentUserId = req.user.userId;
  const { targetUserId } = req.body;

  if (!targetUserId) {
    return res.status(400).json({
      message: "Target user is required",
    });
  }

  if (currentUserId === targetUserId) {
    return res.status(400).json({
      message: "You cannot start a conversation with yourself",
    });
  }

  try {
    const existing = await pool.query(
      `
        SELECT cm.conversation_id
        FROM conversation_members cm
        WHERE cm.user_id IN ($1, $2)
        GROUP BY cm.conversation_id
        HAVING COUNT(DISTINCT cm.user_id) = 2
        AND (
          SELECT COUNT(*)
          FROM conversation_members cm2
          WHERE cm2.conversation_id = cm.conversation_id
        ) = 2
        LIMIT 1
        `,
      [currentUserId, targetUserId],
    );

    if (existing.rows.length > 0) {
      const conversationId = existing.rows[0].conversation_id;

      return res.json({
        conversationId,
        room: `conversation_${conversationId}`,
      });
    }

    const conversation = await pool.query(
      `
        INSERT INTO conversations DEFAULT VALUES
        RETURNING id
        `,
    );

    return res.status(403).json({
      message:
        "A message request must be accepted before starting a new conversation",
    });
  } catch (error) {
    console.log("Conversation error:", error);

    res.status(500).json({
      message: "Failed to create conversation",
    });
  }
});

app.get("/conversations", authenticateToken, async (req, res) => {
  const currentUserId = req.user.userId;

  try {
    const result = await pool.query(
      `
        SELECT
          c.id AS conversation_id,
          u.id AS user_id,
          u.username,
          u.public_id,
          c.keep_history,
          c.created_at,
          c.last_message_at,
          c.last_message_text,
          c.last_message_sender,
          me.unread_count
        FROM conversations c

        JOIN conversation_members me
          ON me.conversation_id = c.id
          AND me.user_id = $1

        JOIN conversation_members other
          ON other.conversation_id = c.id
          AND other.user_id != $1

        JOIN users u
          ON u.id = other.user_id

        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
        `,
      [currentUserId],
    );

    res.json(result.rows);
  } catch (error) {
    console.log("Conversation list error:", error);

    res.status(500).json({
      message: "Failed to load conversations",
    });
  }
});

app.post("/conversations/:id/read", authenticateToken, async (req, res) => {
  const conversationId = Number(req.params.id);

  if (!Number.isInteger(conversationId)) {
    return res.status(400).json({
      message: "Invalid conversation",
    });
  }

  try {
    await pool.query(
      `
        UPDATE conversation_members
        SET unread_count = 0
        WHERE conversation_id = $1
          AND user_id = $2
        `,
      [conversationId, req.user.userId],
    );

    res.json({ ok: true });
  } catch (error) {
    console.log("Mark read error:", error);

    res.status(500).json({
      message: "Failed to mark as read",
    });
  }
});

app.patch("/settings/history", authenticateToken, async (req, res) => {
  const { keepHistory } = req.body;

  if (typeof keepHistory !== "boolean") {
    return res.status(400).json({
      message: "keepHistory must be true or false",
    });
  }

  try {
    await pool.query(
      `
        UPDATE conversations
        SET keep_history = $1
        WHERE id IN (
          SELECT conversation_id
          FROM conversation_members
          WHERE user_id = $2
        )
        `,
      [keepHistory, req.user.userId],
    );

    if (!keepHistory) {
      // Don't leave saved message text behind once saving is turned off.
      await pool.query(
        `
        UPDATE conversations
        SET last_message_text = NULL,
            last_message_sender = NULL
        WHERE id IN (
          SELECT conversation_id
          FROM conversation_members
          WHERE user_id = $1
        )
        `,
        [req.user.userId],
      );
    }

    res.json({ keepHistory });
  } catch (error) {
    console.log("Settings error:", error);

    res.status(500).json({
      message: "Failed to update settings",
    });
  }
});

// Panic button: delete every saved message in all of the user's conversations.
app.delete("/messages", authenticateToken, async (req, res) => {
  try {
    const conversations = await pool.query(
      `
        SELECT conversation_id
        FROM conversation_members
        WHERE user_id = $1
        `,
      [req.user.userId],
    );

    const ids = conversations.rows.map((row) => row.conversation_id);
    const rooms = ids.map((id) => `conversation_${id}`);

    let deleted = 0;

    if (ids.length > 0) {
      const result = await pool.query(
        `DELETE FROM messages WHERE room = ANY($1::text[])`,
        [rooms],
      );

      deleted = result.rowCount;

      await pool.query(
        `
        UPDATE conversations
        SET last_message_text = NULL,
            last_message_sender = NULL
        WHERE id = ANY($1::int[])
        `,
        [ids],
      );

      await pool.query(
        `
        UPDATE conversation_members
        SET unread_count = 0
        WHERE conversation_id = ANY($1::int[])
        `,
        [ids],
      );

      // Tell every member of those chats so open chats, previews and
      // unread badges clear immediately.
      const members = await pool.query(
        `
        SELECT conversation_id, user_id
        FROM conversation_members
        WHERE conversation_id = ANY($1::int[])
        `,
        [ids],
      );

      for (const member of members.rows) {
        io.to(`user_${member.user_id}`).emit("history_cleared", {
          room: `conversation_${member.conversation_id}`,
        });
      }
    }

    res.json({ deleted });
  } catch (error) {
    console.log("Panic delete error:", error);

    res.status(500).json({
      message: "Failed to delete chat history",
    });
  }
});

// Update the database first, then start accepting connections.
runMigrations()
  .then(() => {
    server.listen(3000, () => {
      console.log("Server is running on port 3000");
    });
  })
  .catch((error) => {
    console.error("Database setup failed:", error);
    process.exit(1);
  });
