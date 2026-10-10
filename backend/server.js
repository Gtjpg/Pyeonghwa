const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("./db");
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

      const membership = await pool.query(
        `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1
      AND user_id = $2
      `,
        [conversationId, socket.userId],
      );

      if (membership.rows.length === 0) {
        console.log(
          `User ${socket.userId} tried to send to unauthorized room ${data.room}`,
        );

        return;
      }

      if (data.keepHistory) {
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
        keepHistory: data.keepHistory,
      });
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
      RETURNING id, username, email
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
        expiresIn: "1h",
      },
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Login failed",
    });
  }
});

app.get("/users/search", authenticateToken, async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({
      message: "Username is required",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, username
      FROM users
      WHERE username ILIKE $1
      ORDER BY username
      LIMIT 10
      `,
      [`%${username}%`],
    );

    res.json(result.rows);
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Failed to search users",
    });
  }
});

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

    const conversationId = conversation.rows[0].id;

    await pool.query(
      `
        INSERT INTO conversation_members
        (conversation_id, user_id)
        VALUES ($1, $2), ($1, $3)
        `,
      [conversationId, currentUserId, targetUserId],
    );

    res.status(201).json({
      conversationId,
      room: `conversation_${conversationId}`,
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
          c.keep_history,
          c.created_at
        FROM conversations c

        JOIN conversation_members me
          ON me.conversation_id = c.id
          AND me.user_id = $1

        JOIN conversation_members other
          ON other.conversation_id = c.id
          AND other.user_id != $1

        JOIN users u
          ON u.id = other.user_id

        ORDER BY c.created_at DESC
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

server.listen(3000, () => {
  console.log("Server is running on port 3000");
});
