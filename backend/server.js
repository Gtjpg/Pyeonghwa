const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const bcrypt = require("bcrypt");
const pool = require("./db"); // also loads backend/.env
const security = require("./security");

// Refuse to start without a proper JWT_SECRET (the message never shows it).
try {
  security.checkConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const uploads = require("./uploads");
const { runMigrations } = require("./migrate");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.disable("x-powered-by");

// Behind a reverse proxy (nginx, Render, Railway...), set TRUST_PROXY=1 so
// rate limits see each visitor's real address instead of the proxy's.
if (process.env.TRUST_PROXY) {
  app.set(
    "trust proxy",
    /^\d+$/.test(process.env.TRUST_PROXY)
      ? Number(process.env.TRUST_PROXY)
      : process.env.TRUST_PROXY,
  );
}

app.use(security.securityHeaders);

// Who may use this server from a browser. Set CLIENT_ORIGIN in .env when the
// site is hosted somewhere else, for example https://chat.example.com
// (several addresses can be separated with commas).
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT) || 3000;

app.use(
  cors({
    origin: CLIENT_ORIGINS,
  }),
);

app.use(express.json({ limit: "20kb" }));

app.use(express.static("public"));

/* ---------- Limits ---------- */
const MAX_MESSAGE_LENGTH = 2000;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Photos are stored privately (see uploads.js) and only served through
// GET /conversations/:id/images/:name after a membership check.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_IMAGE_BYTES, files: 1, fields: 4, parts: 6 },
});

const MINUTE = 60 * 1000;

// Per visitor address
const loginIpLimiter = security.rateLimit({
  windowMs: 15 * MINUTE,
  max: 100,
  message: "Too many login attempts. Please try again later.",
});
const signupLimiter = security.rateLimit({
  windowMs: 60 * MINUTE,
  max: 10,
  message: "Too many sign-ups from this address. Please try again later.",
});
// Wrong passwords for one account from one address
const loginFailures = new security.WindowCounter({
  windowMs: 15 * MINUTE,
  max: 10,
});

// Per logged-in user
const perUser = (req) => req.user.userId;
const searchLimiter = security.rateLimit({ windowMs: MINUTE, max: 30, key: perUser });
const requestLimiter = security.rateLimit({
  windowMs: 60 * MINUTE,
  max: 20,
  key: perUser,
  message: "You've sent a lot of requests. Please try again later.",
});
const uploadLimiter = security.rateLimit({ windowMs: MINUTE, max: 30, key: perUser });
const imageReadLimiter = security.rateLimit({ windowMs: MINUTE, max: 600, key: perUser });

// Per socket user
const socketLimits = {
  join: new security.WindowCounter({ windowMs: 10 * 1000, max: 30 }),
  chat: new security.WindowCounter({ windowMs: 10 * 1000, max: 30 }),
  invite: new security.WindowCounter({ windowMs: MINUTE, max: 10 }),
  ice: new security.WindowCounter({ windowMs: MINUTE, max: 300 }),
};

// Run once at startup so a missing user takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS,
    methods: ["GET", "POST"],
  },
  // Messages here are small; this stops oversized payloads.
  maxHttpBufferSize: 100 * 1024,
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("No token provided"));
  }

  try {
    const decoded = security.verifyToken(token);

    if (!Number.isInteger(decoded.userId)) throw new Error("Bad token");

    socket.userId = decoded.userId;
    socket.username = decoded.username;

    next();
  } catch (error) {
    next(new Error("Invalid token"));
  }
});

/* ---------- Audio / video calls ----------
   The server only passes WebRTC setup messages between the two people.
   The audio and video themselves go directly between their browsers. */
const calls = new Map(); // callId -> call details
const CALL_END_REASONS = [
  "hangup",
  "declined",
  "cancelled",
  "no_answer",
  "failed",
];

function userInCall(userId) {
  for (const call of calls.values()) {
    if (call.callerId === userId || call.calleeId === userId) return true;
  }

  return false;
}

function endCall(callId, reason, exceptSocketId) {
  const call = calls.get(callId);

  if (!call) return;

  clearTimeout(call.ringTimer);
  calls.delete(callId);

  let target = io
    .to(`user_${call.callerId}`)
    .to(`user_${call.calleeId}`);

  if (exceptSocketId) target = target.except(exceptSocketId);

  target.emit("call:ended", { callId, reason });
}

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Personal room so we can notify this user about activity in any of their chats.
  socket.join(`user_${socket.userId}`);

  socket.on("call:invite", async (data) => {
    try {
      if (!isObject(data)) return;

      if (!socketLimits.invite.hit(String(socket.userId)).allowed) {
        return socket.emit("call:ended", {
          callId: typeof data.callId === "string" ? data.callId : "",
          reason: "unavailable",
        });
      }

      const { callId, callType, offer } = data;
      const conversationId = Number(data.conversationId);

      if (
        typeof callId !== "string" ||
        callId.length === 0 ||
        callId.length > 64 ||
        !["audio", "video"].includes(callType) ||
        typeof offer?.sdp !== "string" ||
        offer.sdp.length > 20000 ||
        !Number.isInteger(conversationId)
      ) {
        return;
      }

      const members = await pool.query(
        `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
        [conversationId],
      );

      const memberIds = members.rows.map((row) => row.user_id);

      if (memberIds.length !== 2 || !memberIds.includes(socket.userId)) {
        return socket.emit("call:ended", { callId, reason: "unavailable" });
      }

      const calleeId = memberIds.find((id) => id !== socket.userId);

      const calleeSockets = await io.in(`user_${calleeId}`).fetchSockets();

      if (calleeSockets.length === 0) {
        return socket.emit("call:ended", { callId, reason: "offline" });
      }

      // No awaits between this check and calls.set, so two callers
      // can't both reach the same person.
      if (calls.has(callId) || userInCall(socket.userId) || userInCall(calleeId)) {
        return socket.emit("call:ended", { callId, reason: "busy" });
      }

      // Nobody can keep someone's phone ringing (and "busy") forever.
      const ringTimer = setTimeout(() => {
        const pending = calls.get(callId);

        if (pending && !pending.answered) endCall(callId, "no_answer");
      }, 60 * 1000);

      ringTimer.unref();

      calls.set(callId, {
        callerId: socket.userId,
        calleeId,
        conversationId,
        callType,
        callerSocketId: socket.id,
        calleeSocketId: null,
        answered: false,
        ringTimer,
      });

      io.to(`user_${calleeId}`).emit("call:incoming", {
        callId,
        conversationId,
        callType,
        offer: { type: "offer", sdp: offer.sdp },
        from: { id: socket.userId, username: socket.username },
      });

      // Lets the caller start sending network candidates. Anything sent
      // before this point would be dropped because the call isn't registered yet.
      socket.emit("call:ringing", { callId });
    } catch (error) {
      console.log("Call invite error:", error);
    }
  });

  socket.on("call:answer", (data) => {
    if (!isObject(data)) return;

    const call = calls.get(data.callId);

    if (
      !call ||
      call.answered ||
      call.calleeId !== socket.userId ||
      typeof data.answer?.sdp !== "string" ||
      data.answer.sdp.length > 20000
    ) {
      return;
    }

    call.answered = true;
    call.calleeSocketId = socket.id;
    clearTimeout(call.ringTimer);

    // Other tabs of the same person stop ringing.
    socket.to(`user_${call.calleeId}`).emit("call:taken", {
      callId: data.callId,
    });

    io.to(call.callerSocketId).emit("call:answered", {
      callId: data.callId,
      answer: { type: "answer", sdp: data.answer.sdp },
    });
  });

  socket.on("call:ice", (data) => {
    if (!isObject(data)) return;

    const call = calls.get(data.callId);

    if (!call || !data.candidate) return;

    if (!socketLimits.ice.hit(String(socket.userId)).allowed) return;

    if (JSON.stringify(data.candidate).length > 4000) return;

    let target = null;

    if (socket.id === call.callerSocketId) {
      target = call.answered
        ? call.calleeSocketId
        : `user_${call.calleeId}`;
    } else if (call.answered && socket.id === call.calleeSocketId) {
      target = call.callerSocketId;
    }

    if (!target) return;

    io.to(target).emit("call:ice", {
      callId: data.callId,
      candidate: data.candidate,
    });
  });

  socket.on("call:end", (data) => {
    if (!isObject(data)) return;

    const call = calls.get(data.callId);

    if (!call) return;

    const isCaller = socket.id === call.callerSocketId;
    const isCallee =
      socket.userId === call.calleeId &&
      (!call.answered || socket.id === call.calleeSocketId);

    if (!isCaller && !isCallee) return;

    const reason = CALL_END_REASONS.includes(data.reason)
      ? data.reason
      : "hangup";

    endCall(data.callId, reason, socket.id);
  });

  socket.on("disconnect", () => {
    for (const [callId, call] of calls) {
      if (
        call.callerSocketId === socket.id ||
        call.calleeSocketId === socket.id
      ) {
        endCall(callId, "disconnected", socket.id);
      }
    }
  });

  socket.on("join_room", async (room) => {
    try {
      // Validate the room name.
      if (typeof room !== "string" || !/^conversation_\d{1,10}$/.test(room)) {
        return;
      }

      if (!socketLimits.join.hit(String(socket.userId)).allowed) return;

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
      SELECT id, username, content, message_type, image_url, created_at
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
      if (
        typeof data?.room !== "string" ||
        !/^conversation_\d{1,10}$/.test(data.room)
      ) {
        return;
      }

      if (!socketLimits.chat.hit(String(socket.userId)).allowed) {
        return socket.emit("message_rejected", { reason: "too_fast" });
      }

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
        console.log(`User ${socket.userId} tried to send to a room they are not in`);

        return;
      }

      // The database decides whether this chat saves history, not the client.
      const settings = await pool.query(
        `SELECT keep_history FROM conversations WHERE id = $1`,
        [conversationId],
      );
      const keepHistory = settings.rows[0]?.keep_history === true;

      const isImage = data.type === "image";
      let imageUrl = null;
      let content;

      if (isImage) {
        const parsed = uploads.parseImageUrl(data.imageUrl);

        // The photo has to come from THIS conversation's own uploads.
        if (!parsed || parsed.conversationId !== conversationId) return;

        // Keep the file where the chat's history setting says it belongs.
        const found = await uploads.relocateImage(
          conversationId,
          parsed.name,
          !keepHistory,
        );

        if (!found) return;

        imageUrl = data.imageUrl;
        content = "📷 Photo";
      } else {
        if (typeof data.message !== "string" || !data.message.trim()) return;

        if (data.message.length > MAX_MESSAGE_LENGTH) {
          return socket.emit("message_rejected", { reason: "too_long" });
        }

        content = data.message;
      }

      if (keepHistory) {
        await pool.query(
          `
        INSERT INTO messages (room, username, content, message_type, image_url)
        VALUES ($1, $2, $3, $4, $5)
        `,
          [
            data.room,
            socket.username,
            content,
            isImage ? "image" : "text",
            imageUrl,
          ],
        );
      }

      io.to(data.room).emit("chat_message", {
        room: data.room,
        username: socket.username,
        message: content,
        type: isImage ? "image" : "text",
        imageUrl,
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
          keepHistory ? content.slice(0, 200) : null,
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
          message: content,
        });
      }
    } catch (error) {
      console.log("Message error:", error);
    }
  });
});

function authenticateToken(req, res, next) {
  const token = security.readBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({
      message: "Authentication required",
    });
  }

  try {
    const decoded = security.verifyToken(token);

    if (!Number.isInteger(decoded.userId)) throw new Error("Bad token");

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(403).json({
      message: "Invalid or expired token",
    });
  }
}

// For uptime checks. Deliberately shows nothing about the database.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/signup", signupLimiter, async (req, res) => {
  const checked = security.validateSignup(req.body);

  if (checked.error) {
    return res.status(400).json({ message: checked.error });
  }

  const { username, email, password } = checked.value;

  try {
    // "Alice" and "alice" would look like the same person to others.
    const taken = await pool.query(
      `SELECT 1 FROM users WHERE lower(username) = lower($1) OR email = $2 LIMIT 1`,
      [username, email],
    );

    if (taken.rows.length > 0) {
      return res.status(409).json({
        message: "That username or email is already in use",
      });
    }

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
    // 23505 = someone else just took it (unique constraint)
    if (error.code === "23505") {
      return res.status(409).json({
        message: "That username or email is already in use",
      });
    }

    console.error("Signup error:", error.code || error.message);

    res.status(500).json({
      message: "Failed to create account",
    });
  }
});

app.post("/login", loginIpLimiter, async (req, res) => {
  const checked = security.validateLogin(req.body);

  if (checked.error) {
    return res.status(400).json({ message: checked.error });
  }

  const { username, password } = checked.value;

  // Too many wrong passwords for this account from this address.
  const failKey = `${req.ip}|${username.toLowerCase()}`;
  const blocked = loginFailures.isBlocked(failKey);

  if (blocked.blocked) {
    res.setHeader("Retry-After", String(blocked.retryAfter));

    return res.status(429).json({
      message: "Too many failed attempts. Please try again later.",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, username, email, public_id, password_hash
      FROM users
      WHERE username = $1
      `,
      [username],
    );

    const user = result.rows[0];

    // Always run bcrypt, so an unknown username takes as long as a wrong
    // password and can't be told apart by timing.
    const passwordMatches = await bcrypt.compare(
      password,
      user ? user.password_hash : DUMMY_HASH,
    );

    if (!user || !passwordMatches) {
      loginFailures.hit(failKey);

      return res.status(401).json({
        message: "Invalid username or password",
      });
    }

    loginFailures.reset(failKey);

    const token = security.signToken({
      userId: user.id,
      username: user.username,
    });

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
    console.error("Login error:", error.code || error.message);

    res.status(500).json({
      message: "Login failed",
    });
  }
});

/* ---------- Calls: STUN / TURN servers ----------
   STUN lets two browsers find each other. TURN relays the call when they
   can't connect directly (different networks, strict firewalls).

   Set these in .env to turn relaying on:
     TURN_URLS    comma-separated, e.g. turn:turn.example.com:3478,turns:turn.example.com:443?transport=tcp
     TURN_SECRET  the same secret as static-auth-secret in coturn (recommended:
                  each person gets a temporary password), or
     TURN_USERNAME + TURN_CREDENTIAL for a fixed login (hosted TURN services)
     TURN_TTL_SECONDS  how long a temporary password lasts (default 86400) */
const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

function splitList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

app.get("/ice-servers", authenticateToken, (req, res) => {
  const stunUrls = splitList(process.env.STUN_URLS);
  const turnUrls = splitList(process.env.TURN_URLS);
  const ttl = Number(process.env.TURN_TTL_SECONDS) || 24 * 60 * 60;

  const iceServers = [{ urls: stunUrls.length ? stunUrls : DEFAULT_STUN }];

  if (turnUrls.length > 0) {
    if (process.env.TURN_SECRET) {
      // coturn "REST API" login: the username carries the expiry time and
      // the password is a signature of it, so nothing permanent is shared.
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${req.user.userId}`;
      const credential = crypto
        .createHmac("sha1", process.env.TURN_SECRET)
        .update(username)
        .digest("base64");

      iceServers.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: turnUrls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
  }

  // Never cache: the temporary password is different for each request.
  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers, ttl });
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

app.get("/users/search", authenticateToken, searchLimiter, async (req, res) => {
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

app.post(
  "/message-requests",
  authenticateToken,
  requestLimiter,
  async (req, res) => {
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

    // Two requests for the same pair of people run one after the other, so a
    // double-click can't create duplicate pending requests.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      Math.min(senderId, receiverId),
      Math.max(senderId, receiverId),
    ]);

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
    await client.query("ROLLBACK").catch(() => {});
    console.error("Send message request error:", error.code || error.message);

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

      // Serialize per pair so two accepts can't create two conversations.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        Math.min(request.sender_id, request.receiver_id),
        Math.max(request.sender_id, request.receiver_id),
      ]);

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
      await client.query("ROLLBACK").catch(() => {});
      console.error(
        "Respond to message request error:",
        error.code || error.message,
      );

      return res.status(500).json({
        message: "Failed to respond to message request",
      });
    } finally {
      client.release();
    }
  },
);

// Looks up the conversation you already have with someone. It never creates
// one: a new conversation only exists once a message request is accepted
// (POST /message-requests/:id/respond). Because nothing is written here, a
// refused request can't leave an empty conversation behind.
app.post("/conversations", authenticateToken, async (req, res) => {
  const currentUserId = req.user.userId;
  const targetUserId = security.parseId(req.body?.targetUserId);

  if (!targetUserId) {
    return res.status(400).json({
      message: "A valid target user is required",
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

    return res.status(403).json({
      message:
        "A message request must be accepted before starting a new conversation",
    });
  } catch (error) {
    console.error("Conversation error:", error.code || error.message);

    res.status(500).json({
      message: "Failed to look up the conversation",
    });
  }
});

app.post(
  "/conversations/:id/images",
  authenticateToken,
  uploadLimiter,
  async (req, res, next) => {
    const conversationId = security.parseId(req.params.id);

    if (!conversationId) {
      return res.status(400).json({ message: "Invalid conversation" });
    }

    try {
      // Only people in the conversation can upload to it.
      const result = await pool.query(
        `
        SELECT c.keep_history
        FROM conversations c
        JOIN conversation_members m ON m.conversation_id = c.id
        WHERE c.id = $1
          AND m.user_id = $2
        `,
        [conversationId, req.user.userId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Conversation not found",
        });
      }

      res.locals.conversationId = conversationId;
      res.locals.keepHistory = result.rows[0].keep_history === true;
      next();
    } catch (error) {
      console.error("Upload check error:", error.code || error.message);

      res.status(500).json({ message: "Failed to upload photo" });
    }
  },
  (req, res, next) => {
    upload.single("image")(req, res, (error) => {
      if (!error) return next();

      const tooLarge = error.code === "LIMIT_FILE_SIZE";

      res.status(tooLarge ? 413 : 400).json({
        message: tooLarge
          ? "That photo is too large (5 MB max)"
          : "The upload didn't work. Please try again.",
      });
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No photo was uploaded" });
    }

    // Judged by the file's own bytes, not its name or reported type.
    const type = uploads.detectImageType(req.file.buffer);

    if (!type) {
      return res.status(400).json({
        message: "Only JPEG, PNG and WebP photos are allowed",
      });
    }

    try {
      const name = await uploads.saveImage(
        res.locals.conversationId,
        req.file.buffer,
        type,
        !res.locals.keepHistory,
      );

      res.json({ url: uploads.imageUrl(res.locals.conversationId, name) });
    } catch (error) {
      console.error("Upload save error:", error.code || error.message);

      res.status(500).json({ message: "Failed to save photo" });
    }
  },
);

// The only way to read a photo: you must be logged in AND be a member of the
// conversation the photo belongs to.
app.get(
  "/conversations/:id/images/:name",
  authenticateToken,
  imageReadLimiter,
  async (req, res) => {
    const conversationId = security.parseId(req.params.id);
    const name = req.params.name;

    // One answer for a bad address, someone else's conversation and a missing
    // file, so this can't be used to find out what exists.
    const notFound = () => res.status(404).json({ message: "Photo not found" });

    if (!conversationId || !uploads.isValidImageName(name)) return notFound();

    try {
      const membership = await pool.query(
        `
        SELECT 1
        FROM conversation_members
        WHERE conversation_id = $1
          AND user_id = $2
        `,
        [conversationId, req.user.userId],
      );

      if (membership.rows.length === 0) return notFound();

      const found = await uploads.findImage(conversationId, name);

      if (!found) return notFound();

      // "root" keeps the file name check separate from the folder path.
      res.sendFile(
        path.basename(found.file),
        {
          root: path.dirname(found.file),
          dotfiles: "deny",
          cacheControl: false,
          headers: {
            "Content-Type": uploads.mimeTypeFor(name),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline",
            // Never stored by shared caches; always re-checked with login.
            "Cache-Control": "private, no-cache",
          },
        },
        (error) => {
          if (error && !res.headersSent) notFound();
        },
      );
    } catch (error) {
      console.error("Photo read error:", error.code || error.message);

      if (!res.headersSent) {
        res.status(500).json({ message: "Failed to load photo" });
      }
    }
  },
);

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

      // Remove every photo file of these conversations (saved and temporary),
      // not just the database rows.
      await uploads.deleteConversationImages(ids);

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

// Anything that didn't match a route
app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

// Last stop for errors: always JSON, never a stack trace.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON" });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "Request is too large" });
  }

  console.error("Unhandled error:", error.message);

  res.status(500).json({ message: "Something went wrong" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason?.message || reason);
});

// Update the database first, then start accepting connections.
runMigrations()
  .then(async () => {
    await uploads.ensureUploadDirs();

    // Photos used to be public. Move them into private storage once.
    await uploads.migrateLegacyUploads();

    uploads.cleanTempUploads();
    uploads.cleanOrphanUploads();
    setInterval(uploads.cleanTempUploads, 10 * 60 * 1000).unref();
    setInterval(uploads.cleanOrphanUploads, 30 * 60 * 1000).unref();

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Startup failed:", error.message);
    process.exit(1);
  });
