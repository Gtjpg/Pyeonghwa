// Integration tests: starts the real server and talks to it over HTTP and
// WebSockets. Needs PostgreSQL (the one in backend/.env, or set TEST_DB_NAME).
// It only creates users named zt<random>..., and removes everything it made.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { io } from "socket.io-client";

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(backendDir);
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const pool = (await import("../db.js")).default;
const { runMigrations } = await import("../migrate.js");

let dbReady = true;
try {
  await pool.query("SELECT 1");
} catch {
  dbReady = false;
  console.warn("PostgreSQL is not reachable: skipping the API tests.");
}

const SECRET = crypto.randomBytes(24).toString("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-api-test-"));
const UPLOAD = path.join(root, "storage");
const LEGACY = path.join(root, "legacy");
const PUBLIC_DIR = path.join(backendDir, "public");
const tag = crypto.randomBytes(3).toString("hex");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/* ---------- starting servers ---------- */

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: SECRET,
      UPLOAD_DIR: UPLOAD,
      LEGACY_UPLOAD_DIR: LEGACY,
      CLIENT_ORIGIN: "http://localhost:5173",
      NODE_ENV: "test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${logs}`)), 25000);
    child.stdout.on("data", () => {
      if (logs.includes("Server is running")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}):\n${logs}`));
    });
  });

  return { child, port, base: `http://127.0.0.1:${port}`, logs: () => logs };
}

function runServerExpectingExit(extraEnv) {
  return spawnSync(process.execPath, ["server.js"], {
    cwd: backendDir,
    env: { ...process.env, PORT: "0", NODE_ENV: "test", ...extraEnv },
    encoding: "utf8",
    timeout: 20000,
  });
}

/* ---------- helpers ---------- */

let main; // the main server
const sockets = [];
const createdUserIds = [];

const api = async (p, { method = "GET", token, json, form, body, headers = {}, server = main } = {}) => {
  const res = await fetch(server.base + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: form ?? (json !== undefined ? JSON.stringify(json) : body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, buf, data };
};

// Sends the path exactly as written (fetch would tidy ".." away).
const raw = (pathname, { token, headers = {}, method = "GET" } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: main.port, path: pathname, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const photoForm = (bytes, { field = "image", filename = "photo.jpg", type = "image/jpeg" } = {}) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), filename);
  return form;
};

const pad = (head, size = 200) => Buffer.concat([head, crypto.randomBytes(Math.max(0, size - head.length))]);
const makeJpeg = () => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const makePng = () => pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR")]));
const makeWebp = () => pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));

async function makeUser(name) {
  const username = `zt${tag}${name}`;
  const password = "a-good-password-1";
  const signup = await api("/signup", { method: "POST", json: { username, email: `${username}@example.test`, password } });
  assert.equal(signup.status, 201, `signup ${name}: ${signup.buf}`);
  const login = await api("/login", { method: "POST", json: { username, password } });
  assert.equal(login.status, 200);
  createdUserIds.push(signup.data.user.id);
  return { name, username, password, id: signup.data.user.id, token: login.data.token, publicId: signup.data.user.public_id };
}

async function befriend(a, b) {
  const sent = await api("/message-requests", { method: "POST", token: a.token, json: { targetUserId: b.id } });
  assert.equal(sent.status, 201, String(sent.buf));
  const accepted = await api(`/message-requests/${sent.data.request.id}/respond`, { method: "POST", token: b.token, json: { action: "accept" } });
  assert.equal(accepted.status, 200, String(accepted.buf));
  return accepted.data.conversationId;
}

const connect = (token, server = main) =>
  new Promise((resolve, reject) => {
    const socket = io(server.base, { auth: { token }, transports: ["websocket"], reconnection: false });
    sockets.push(socket);
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });

const once = (socket, event, ms = 700) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });

async function joinRoom(socket, conversationId) {
  const history = once(socket, "chat_history", 3000);
  socket.emit("join_room", `conversation_${conversationId}`);
  return history;
}

const countOrphans = async () =>
  Number((await pool.query(`SELECT COUNT(*) FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id)`)).rows[0].count);
const countMemberships = async (ids) =>
  Number((await pool.query(`SELECT COUNT(*) FROM conversation_members WHERE user_id = ANY($1::int[])`, [ids])).rows[0].count);
const countConversationsOf = async (ids) =>
  Number((await pool.query(`SELECT COUNT(DISTINCT conversation_id) FROM conversation_members WHERE user_id = ANY($1::int[])`, [ids])).rows[0].count);

/* ---------- the tests ---------- */

const suite = dbReady ? describe : describe.skip;

suite("API", () => {
  let alice, bob, carol, dave;
  let C1, C2, C3; // alice-bob, carol-dave, bob-carol

  before(async () => {
    main = await startServer();
    [alice, bob, carol, dave] = [await makeUser("alice"), await makeUser("bob"), await makeUser("carol"), await makeUser("dave")];
    C1 = await befriend(alice, bob);
    C2 = await befriend(carol, dave);
    C3 = await befriend(bob, carol);
    await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory: true } });
    await api("/settings/history", { method: "PATCH", token: carol.token, json: { keepHistory: true } });
  });

  after(async () => {
    for (const socket of sockets) socket.close();
    main?.child.kill();

    try {
      const convs = (await pool.query(`SELECT DISTINCT conversation_id FROM conversation_members WHERE user_id = ANY($1::int[])`, [createdUserIds])).rows.map((r) => r.conversation_id);
      await pool.query(`DELETE FROM messages WHERE room = ANY($1::text[])`, [convs.map((id) => `conversation_${id}`)]);
      await pool.query(`DELETE FROM message_requests WHERE sender_id = ANY($1::int[]) OR receiver_id = ANY($1::int[])`, [createdUserIds]);
      await pool.query(`DELETE FROM conversation_members WHERE conversation_id = ANY($1::int[])`, [convs]);
      await pool.query(`DELETE FROM conversations WHERE id = ANY($1::int[])`, [convs]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [createdUserIds]);
    } catch (error) {
      console.warn("Test clean-up problem:", error.message);
    }

    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /* ======================= 1. PRIVATE PHOTOS ======================= */

  describe("private photos", () => {
    const jpeg = makeJpeg();
    let url, name;

    before(async () => {
      const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(jpeg) });
      assert.equal(up.status, 200, String(up.buf));
      url = up.data.url;
      name = path.basename(url);
    });

    test("upload returns a private, conversation-scoped address (not /uploads)", () => {
      assert.match(url, new RegExp(`^/conversations/${C1}/images/[a-f0-9]{32}\\.jpg$`));
    });

    test("nothing is served from /uploads or any public path any more", async () => {
      for (const p of [`/uploads/${name}`, `/uploads/${C1}/${name}`, `/uploads/tmp/${name}`, `/uploads/`, "/uploads", `/${name}`, `/storage/uploads/${C1}/${name}`, `/public/${name}`]) {
        for (const token of [undefined, bob.token]) {
          assert.equal((await api(p, { token })).status, 404, p);
        }
      }
    });

    test("files are stored outside the public folder", () => {
      assert.ok(fs.existsSync(path.join(UPLOAD, String(C1), name)));
      assert.ok(!path.resolve(UPLOAD).startsWith(PUBLIC_DIR + path.sep));
      assert.ok(!fs.readdirSync(PUBLIC_DIR, { recursive: true }).some((f) => String(f).includes(name)));
    });

    test("members can read the photo, with safe headers", async () => {
      for (const user of [alice, bob]) {
        const r = await api(url, { token: user.token });
        assert.equal(r.status, 200);
        assert.ok(r.buf.equals(jpeg), "exact bytes");
        assert.equal(r.headers.get("content-type"), "image/jpeg");
        assert.equal(r.headers.get("x-content-type-options"), "nosniff");
        assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
        assert.equal(r.headers.get("cache-control"), "private, no-cache");
        assert.match(r.headers.get("content-disposition"), /^inline/);
      }
    });

    test("no login, a bad login, or a non-member cannot read it", async () => {
      assert.equal((await api(url)).status, 401);
      assert.equal((await api(url, { token: "garbage" })).status, 403);
      assert.equal((await api(url, { headers: { Authorization: "Basic abc" } })).status, 401);

      const missing = await api(`/conversations/${C1}/images/${"0".repeat(32)}.jpg`, { token: carol.token });
      for (const user of [carol, dave]) {
        const r = await api(url, { token: user.token });
        assert.equal(r.status, 404);
        assert.ok(!r.buf.equals(jpeg));
        assert.deepEqual(r.data, missing.data, "same answer as a photo that doesn't exist");
      }
    });

    test("a photo can't be read through a different conversation", async () => {
      // bob is in C1 and C3; carol is in C2 and C3
      assert.equal((await api(`/conversations/${C3}/images/${name}`, { token: bob.token })).status, 404);
      assert.equal((await api(`/conversations/${C3}/images/${name}`, { token: carol.token })).status, 404);
      assert.equal((await api(`/conversations/${C2}/images/${name}`, { token: carol.token })).status, 404);
    });

    test("path traversal and malformed addresses never return a file", async () => {
      const attempts = [
        `/conversations/${C1}/images/..%2F..%2Fserver.js`,
        `/conversations/${C1}/images/%2e%2e%2f%2e%2e%2fserver.js`,
        `/conversations/${C1}/images/..%5C..%5Cserver.js`,
        `/conversations/${C1}/images/${name}%00`,
        `/conversations/${C1}/images/${name}%00.png`,
        `/conversations/${C1}/images/${name}/..`,
        `/conversations/${C1}/images/${name}.exe`,
        `/conversations/${C1}/images/${name.toUpperCase()}`,
        `/conversations/${C1}/images/`,
        `/conversations/${C1}/images/%2e%2e/${name}`,
        `/conversations/${C1}/images/../../../etc/passwd`,
        `/conversations/${C1}/images/....//....//server.js`,
        `/conversations/0/images/${name}`,
        `/conversations/-1/images/${name}`,
        `/conversations/1e1/images/${name}`,
        `/conversations/${C1}%20/images/${name}`,
        `/conversations/99999999999/images/${name}`,
        `//conversations/${C1}/images/${name}`,
        `/conversations/${C1}/images/${"a".repeat(5000)}`,
      ];

      for (const attempt of attempts) {
        const r = await raw(attempt, { token: bob.token });
        assert.ok(r.status >= 400 && r.status < 500, `${attempt.slice(0, 80)} -> ${r.status}`);
        assert.ok(!r.body.equals(jpeg));
        assert.ok(!r.body.toString().includes("require("), "never returns source code");
      }
    });

    test("only real JPEG, PNG and WebP photos are accepted, judged by their bytes", async () => {
      for (const [label, bytes, type] of [["PNG", makePng(), "image/png"], ["WebP", makeWebp(), "image/webp"]]) {
        const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(bytes, { type, filename: "x" }) });
        assert.equal(up.status, 200, label);
        const read = await api(up.data.url, { token: bob.token });
        assert.equal(read.headers.get("content-type"), type);
        assert.ok(read.buf.equals(bytes));
      }

      const disguised = {
        "text called .jpg": Buffer.from("this is not a photo at all, just plain text that is long enough"),
        "GIF": pad(Buffer.from("GIF89a")),
        "SVG with script": pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
        "HTML": pad(Buffer.from("<!doctype html><script>alert(1)</script>")),
        "PNG signature only": pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        "empty": Buffer.alloc(0),
      };

      for (const [label, bytes] of Object.entries(disguised)) {
        const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(bytes) });
        assert.equal(up.status, 400, label);
      }
    });

    test("the file name sent by the client is ignored", async () => {
      const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(makeJpeg(), { filename: "../../evil.jpg" }) });
      assert.equal(up.status, 200);
      assert.match(up.data.url, /^\/conversations\/\d+\/images\/[a-f0-9]{32}\.jpg$/);
      assert.ok(!fs.existsSync(path.join(UPLOAD, "..", "evil.jpg")));
      assert.ok(!fs.existsSync(path.join(UPLOAD, "evil.jpg")));
    });

    test("files over 5 MB are refused", async () => {
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6 * 1024 * 1024)]);
      const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(big) });
      assert.equal(up.status, 413);
    });

    test("bad upload requests are refused", async () => {
      const post = (id, opts) => api(`/conversations/${id}/images`, { method: "POST", ...opts });
      assert.equal((await post(C1, { form: photoForm(makeJpeg()) })).status, 401, "no login");
      assert.equal((await post(C1, { token: carol.token, form: photoForm(makeJpeg()) })).status, 404, "not a member");
      assert.equal((await post("abc", { token: alice.token, form: photoForm(makeJpeg()) })).status, 400);
      assert.equal((await post("0", { token: alice.token, form: photoForm(makeJpeg()) })).status, 400);
      assert.equal((await post("1e1", { token: alice.token, form: photoForm(makeJpeg()) })).status, 400);
      assert.equal((await post(C1, { token: alice.token, form: photoForm(makeJpeg(), { field: "file" }) })).status, 400, "wrong field name");
      assert.equal((await post(C1, { token: alice.token, json: { hello: "world" } })).status, 400, "no file");
      assert.equal((await post(C1, { token: alice.token })).status, 400, "empty body");
    });

    describe("sending photos in chat", () => {
      let sa, sb, sc;
      const room = () => `conversation_${C1}`;

      before(async () => {
        [sa, sb, sc] = [await connect(alice.token), await connect(bob.token), await connect(carol.token)];
        await joinRoom(sa, C1);
        await joinRoom(sb, C1);
      });

      test("a photo is delivered, saved, and shows up in history", async () => {
        const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(makeJpeg()) });
        const delivered = once(sb, "chat_message", 2000);
        sa.emit("chat_message", { room: room(), type: "image", imageUrl: up.data.url });
        const message = await delivered;
        assert.equal(message.type, "image");
        assert.equal(message.imageUrl, up.data.url);

        const history = await joinRoom(sb, C1);
        const saved = history.find((m) => m.image_url === up.data.url);
        assert.equal(saved.message_type, "image");
      });

      test("a photo from another conversation, or a made-up address, is ignored", async () => {
        const other = await api(`/conversations/${C2}/images`, { method: "POST", token: carol.token, form: photoForm(makeJpeg()) });
        const name2 = path.basename(other.data.url);
        const own = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(makeJpeg()) });
        const ownName = path.basename(own.data.url);

        const bad = [
          other.data.url, // belongs to C2
          `/conversations/${C1}/images/${name2}`, // C2's file name under C1
          `/conversations/${C1}/images/${"1".repeat(32)}.jpg`, // doesn't exist
          `/uploads/${ownName}`, // the old public style
          `/conversations/${C1}/images/../images/${ownName}`,
          `http://evil.example/${ownName}`,
          `/conversations/${C1}/images/${ownName}?x=1`,
          "", null, {}, [], 5,
        ];

        for (const imageUrl of bad) {
          const got = once(sb, "chat_message", 250);
          sa.emit("chat_message", { room: room(), type: "image", imageUrl });
          assert.equal(await got, null, String(JSON.stringify(imageUrl)).slice(0, 70));
        }

        const notMine = once(sb, "chat_message", 300);
        sa.emit("chat_message", { room: `conversation_${C3}`, type: "image", imageUrl: `/conversations/${C3}/images/${ownName}` });
        assert.equal(await notMine, null, "alice isn't in C3");
      });

      test("with history off, photos are temporary and not saved; turning history on keeps them", async () => {
        await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory: false } });

        const up = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(makeJpeg()) });
        const fileName = path.basename(up.data.url);
        const tempFile = path.join(UPLOAD, "tmp", String(C1), fileName);
        assert.ok(fs.existsSync(tempFile), "stored in temporary storage");
        assert.equal((await api(up.data.url, { token: bob.token })).status, 200, "still readable by members");

        const delivered = once(sb, "chat_message", 2000);
        sa.emit("chat_message", { room: room(), type: "image", imageUrl: up.data.url });
        assert.ok(await delivered);
        assert.ok(!(await joinRoom(sb, C1)).some((m) => m.image_url === up.data.url), "not in history");

        await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory: true } });
        const keep = await api(`/conversations/${C1}/images`, { method: "POST", token: alice.token, form: photoForm(makeJpeg()) });
        const keepName = path.basename(keep.data.url);
        await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory: false } });
        await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory: true } });
        sa.emit("chat_message", { room: room(), type: "image", imageUrl: keep.data.url });
        await once(sb, "chat_message", 1500);
        assert.ok(fs.existsSync(path.join(UPLOAD, String(C1), keepName)), "saved folder");
      });

      test("non-members get nothing from the room and can't post into it", async () => {
        assert.equal(await joinRoom(sc, C1), null, "no history for a non-member");
        const got = once(sb, "chat_message", 400);
        sc.emit("chat_message", { room: room(), message: "hello from an outsider" });
        assert.equal(await got, null);
      });
    });

    test("the panic button deletes the photo files, but only for the caller's own conversations", async () => {
      const keep = await api(`/conversations/${C2}/images`, { method: "POST", token: carol.token, form: photoForm(makeJpeg()) });
      assert.equal((await api(url, { token: bob.token })).status, 200);

      const panic = await api("/messages", { method: "DELETE", token: bob.token });
      assert.equal(panic.status, 200);

      assert.ok(!fs.existsSync(path.join(UPLOAD, String(C1))), "saved photos gone");
      assert.ok(!fs.existsSync(path.join(UPLOAD, "tmp", String(C1))), "temporary photos gone");
      assert.equal((await api(url, { token: bob.token })).status, 404);
      assert.equal((await api(url, { token: alice.token })).status, 404);
      assert.equal((await api(keep.data.url, { token: dave.token })).status, 200, "bob can't touch carol and dave's chat");
    });
  });

  describe("moving old public photos into private storage", () => {
    test("referenced photos move, the old address stops working, missing files are handled", async () => {
      const legacyName = `${crypto.randomBytes(16).toString("hex")}.jpg`;
      const missingName = `${crypto.randomBytes(16).toString("hex")}.jpg`;
      const bytes = makeJpeg();

      fs.mkdirSync(path.join(LEGACY, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(LEGACY, legacyName), bytes);
      fs.writeFileSync(path.join(LEGACY, "tmp", `${"b".repeat(32)}.jpg`), bytes);

      for (const file of [legacyName, missingName]) {
        await pool.query(
          `INSERT INTO messages (room, username, content, message_type, image_url) VALUES ($1, $2, '📷 Photo', 'image', $3)`,
          [`conversation_${C1}`, alice.username, `/uploads/${file}`],
        );
      }

      const second = await startServer({ UPLOAD_DIR: path.join(root, "storage2") });

      try {
        const rows = (await pool.query(`SELECT image_url FROM messages WHERE room = $1 AND image_url LIKE $2`, [`conversation_${C1}`, "%" + legacyName.slice(0, 32) + "%"])).rows;
        assert.equal(rows[0].image_url, `/conversations/${C1}/images/${legacyName}`);
        assert.ok(fs.existsSync(path.join(root, "storage2", String(C1), legacyName)));
        assert.ok(!fs.existsSync(path.join(LEGACY, legacyName)), "removed from the public folder");
        assert.ok(!fs.existsSync(path.join(LEGACY, "tmp")), "old temporary photos deleted");

        assert.equal((await api(`/uploads/${legacyName}`, { server: second })).status, 404);
        const read = await api(`/conversations/${C1}/images/${legacyName}`, { token: bob.token, server: second });
        assert.equal(read.status, 200);
        assert.ok(read.buf.equals(bytes));
        assert.equal((await api(`/conversations/${C1}/images/${legacyName}`, { token: carol.token, server: second })).status, 404);

        const gone = (await pool.query(`SELECT image_url FROM messages WHERE image_url = $1`, [`/conversations/${C1}/images/${missingName}`])).rows;
        assert.equal(gone.length, 1, "address rewritten even though the file was gone");
        assert.equal((await api(`/conversations/${C1}/images/${missingName}`, { token: bob.token, server: second })).status, 404);
      } finally {
        second.child.kill();
      }
    });
  });

  /* ======================= 2. CONVERSATION CREATION ======================= */

  describe("POST /conversations leaves nothing behind", () => {
    const post = (token, targetUserId) => api("/conversations", { method: "POST", token, json: { targetUserId } });

    test("a refused request creates no conversation and no members", async () => {
      const orphans = await countOrphans();
      const ids = [alice.id, carol.id];
      const [members, convs] = [await countMemberships(ids), await countConversationsOf(ids)];

      const r = await post(alice.token, carol.id); // no conversation, no accepted request
      assert.equal(r.status, 403);
      assert.match(r.data.message, /message request must be accepted/);

      assert.equal(await countOrphans(), orphans, "no empty conversation");
      assert.equal(await countMemberships(ids), members);
      assert.equal(await countConversationsOf(ids), convs);
    });

    test("invalid targets are rejected with 400 and write nothing", async () => {
      const orphans = await countOrphans();
      const bad = ["abc", 0, -5, 1.5, "1e2", "0x10", "", null, true, [dave.id], { id: dave.id }, 2 ** 40, "5; DROP TABLE users", undefined];

      for (const target of bad) {
        const r = await post(alice.token, target);
        assert.equal(r.status, 400, JSON.stringify(target));
      }

      assert.equal(await countOrphans(), orphans);
    });

    test("you can't start a conversation with yourself (number or text)", async () => {
      const orphans = await countOrphans();
      assert.equal((await post(alice.token, alice.id)).status, 400);
      assert.equal((await post(alice.token, String(alice.id))).status, 400);
      assert.equal(await countOrphans(), orphans);
    });

    test("an unknown user is refused without writing anything", async () => {
      const orphans = await countOrphans();
      assert.equal((await post(alice.token, 2147483647)).status, 403);
      assert.equal(await countOrphans(), orphans);
    });

    test("an existing conversation is returned, not duplicated", async () => {
      const ids = [alice.id, bob.id];
      const before = await countConversationsOf(ids);
      const r = await post(alice.token, bob.id);
      assert.equal(r.status, 200);
      assert.equal(r.data.conversationId, C1);
      assert.equal(r.data.room, `conversation_${C1}`);
      assert.equal((await post(alice.token, String(bob.id))).data.conversationId, C1, "id as text works too");
      assert.equal(await countConversationsOf(ids), before);
    });

    test("25 requests at once still create nothing", async () => {
      const orphans = await countOrphans();
      const results = await Promise.all(Array.from({ length: 25 }, () => post(alice.token, carol.id)));
      assert.ok(results.every((r) => r.status === 403));
      assert.equal(await countOrphans(), orphans);
    });

    test("needs a login", async () => {
      assert.equal((await post(undefined, bob.id)).status, 401);
    });

    test("empty conversations left behind by the old bug are cleaned up at startup", async () => {
      const inserted = [];
      for (let i = 0; i < 3; i += 1) inserted.push((await pool.query(`INSERT INTO conversations DEFAULT VALUES RETURNING id`)).rows[0].id);
      assert.ok((await countOrphans()) >= 3);

      await runMigrations();

      const left = (await pool.query(`SELECT id FROM conversations WHERE id = ANY($1::int[])`, [inserted])).rows;
      assert.equal(left.length, 0, "orphans removed");
      assert.equal(await countOrphans(), 0);
      const real = (await pool.query(`SELECT id FROM conversations WHERE id = ANY($1::int[])`, [[C1, C2, C3]])).rows;
      assert.equal(real.length, 3, "real conversations untouched");
    });
  });

  /* ======================= 3. SECURITY & RELIABILITY ======================= */

  describe("message requests: authorization and races", () => {
    const send = (token, targetUserId) => api("/message-requests", { method: "POST", token, json: { targetUserId } });
    let requestId;

    test("input is validated", async () => {
      assert.equal((await send(undefined, bob.id)).status, 401);
      for (const target of ["abc", 0, -1, 1.5, null, [], {}]) assert.equal((await send(dave.token, target)).status, 400, JSON.stringify(target));
      assert.equal((await send(dave.token, dave.id)).status, 400, "yourself");
      assert.equal((await send(dave.token, 2147483647)).status, 404, "unknown user");
      assert.equal((await send(alice.token, bob.id)).status, 409, "already have a conversation");
    });

    test("only the person who received a request can answer it", async () => {
      const sent = await send(dave.token, alice.id);
      assert.equal(sent.status, 201);
      requestId = sent.data.request.id;
      const respond = (token, action, id = requestId) => api(`/message-requests/${id}/respond`, { method: "POST", token, json: { action } });

      assert.equal((await respond(undefined, "accept")).status, 401);
      assert.equal((await respond(dave.token, "accept")).status, 403, "the sender can't accept their own request");
      assert.equal((await respond(carol.token, "accept")).status, 403, "a stranger can't");
      assert.equal((await respond(alice.token, "maybe")).status, 400);
      assert.equal((await respond(alice.token, "accept", "abc")).status, 400);
      assert.equal((await respond(alice.token, "accept", 2147483647)).status, 404);

      assert.equal((await respond(alice.token, "reject")).status, 200);
      assert.equal((await respond(alice.token, "accept")).status, 409, "already handled");
      assert.equal((await respond(alice.token, "reject")).status, 409);
    });

    test("eight identical requests at once leave exactly one pending request", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => send(dave.token, alice.id)));
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 7);

      const pending = await pool.query(
        `SELECT COUNT(*) FROM message_requests WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
        [dave.id, alice.id],
      );
      assert.equal(Number(pending.rows[0].count), 1);
    });
  });

  describe("sign-up and login", () => {
    test("sign-up validates its input", async () => {
      const post = (json, headers) => api("/signup", { method: "POST", json, headers });
      const base = { username: `zt${tag}new`, email: `zt${tag}new@example.test`, password: "long-enough-pass" };

      assert.equal((await post({ ...base, password: "short" })).status, 400);
      assert.equal((await post({ ...base, username: { $ne: null } })).status, 400);
      assert.equal((await post(5)).status, 400);
    });

    test("a taken username is refused, whatever the capital letters", async () => {
      const r = await api("/signup", { method: "POST", json: { username: alice.username.toUpperCase(), email: `other${tag}@example.test`, password: "long-enough-pass" } });
      assert.equal(r.status, 409);
      assert.equal(r.data.user, undefined);
    });

    test("responses never contain password data", async () => {
      const login = await api("/login", { method: "POST", json: { username: alice.username, password: alice.password } });
      const me = await api("/me", { token: login.data.token });
      for (const body of [login.buf.toString(), me.buf.toString()]) {
        assert.ok(!/password|hash|\$2[aby]\$/i.test(body.replace(/Login successful/g, "")), body);
      }
    });

    test("login checks types, and gives one answer for wrong password and unknown user", async () => {
      const post = (json) => api("/login", { method: "POST", json });
      assert.equal((await post({ username: { $ne: null }, password: { $ne: null } })).status, 400);
      assert.equal((await post({ username: alice.username })).status, 400);
      assert.equal((await post(null)).status, 400);

      const wrong = await post({ username: alice.username, password: "not-the-password" });
      const unknown = await post({ username: `zt${tag}nobody`, password: "not-the-password" });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(wrong.data, unknown.data);
    });

    test("repeated wrong passwords lock that account's login for a while", async () => {
      const victim = await makeUser("victim");
      const attempt = (password) => api("/login", { method: "POST", json: { username: victim.username, password } });

      for (let i = 0; i < 10; i += 1) assert.equal((await attempt("wrong-password")).status, 401);

      const locked = await attempt("wrong-password");
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get("retry-after")) >= 1);
      assert.equal((await attempt(victim.password)).status, 429, "even the right password waits");
      assert.equal((await api("/login", { method: "POST", json: { username: alice.username, password: alice.password } })).status, 200, "other accounts unaffected");
    });
  });

  describe("tokens", () => {
    const me = (headers) => api("/me", { headers });

    test("only a well-formed, correctly signed, unexpired token works", async () => {
      assert.equal((await me({ Authorization: `Bearer ${alice.token}` })).status, 200);

      const expired = jwt.sign({ userId: alice.id }, SECRET, { expiresIn: -60 });
      const wrongKey = jwt.sign({ userId: alice.id }, "another-secret-that-is-not-ours-123456");
      const wrongAlg = jwt.sign({ userId: alice.id }, SECRET, { algorithm: "HS512" });
      const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ userId: alice.id })).toString("base64url")}.`;
      const badPayload = jwt.sign({ userId: "1 OR 1=1" }, SECRET);
      const noUser = jwt.sign({ username: "x" }, SECRET);

      assert.equal((await me({})).status, 401);
      assert.equal((await me({ Authorization: "Basic abc" })).status, 401);
      assert.equal((await me({ Authorization: "Bearer" })).status, 401);
      for (const token of [expired, wrongKey, wrongAlg, noneAlg, badPayload, noUser, "garbage", alice.token.slice(0, -3)]) {
        assert.equal((await me({ Authorization: `Bearer ${token}` })).status, 403, token.slice(0, 25));
      }
    });

    test("the socket needs a valid token too", async () => {
      const attempt = (auth) => new Promise((resolve) => {
        const socket = io(main.base, { auth, transports: ["websocket"], reconnection: false });
        sockets.push(socket);
        socket.on("connect", () => resolve("connected"));
        socket.on("connect_error", (error) => resolve(error.message));
      });

      assert.equal(await attempt({}), "No token provided");
      assert.equal(await attempt({ token: "garbage" }), "Invalid token");
      assert.equal(await attempt({ token: jwt.sign({ userId: alice.id }, "wrong-secret-wrong-secret-wrong-1234") }), "Invalid token");
      assert.equal(await attempt({ token: jwt.sign({ userId: "x" }, SECRET) }), "Invalid token");
    });
  });

  describe("errors and headers", () => {
    test("health check shows nothing about the database; the old debug route is gone", async () => {
      const health = await api("/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.data, { status: "ok" });
      assert.equal((await api("/db-test")).status, 404);
    });

    test("bad requests get short JSON errors, never HTML or stack traces", async () => {
      const badJson = await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
      assert.equal(badJson.status, 400);
      assert.deepEqual(badJson.data, { message: "Invalid JSON" });

      const tooBig = await api("/login", { method: "POST", json: { username: "a", password: "x".repeat(30000) } });
      assert.equal(tooBig.status, 413);
      assert.deepEqual(tooBig.data, { message: "Request is too large" });

      const unknown = await api("/no/such/route");
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.data, { message: "Not found" });

      for (const r of [badJson, tooBig, unknown]) {
        assert.match(r.headers.get("content-type"), /application\/json/);
        assert.ok(!/at .*\.js|node_modules|<html/i.test(r.buf.toString()));
      }
    });

    test("security headers are set and the framework isn't advertised", async () => {
      const r = await api("/health");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.equal(r.headers.get("x-powered-by"), null);
    });

    test("only the configured website may call the API from a browser", async () => {
      const ok = await raw("/health", { headers: { Origin: "http://localhost:5173" } });
      assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
      const bad = await raw("/health", { headers: { Origin: "https://evil.example" } });
      assert.equal(bad.headers["access-control-allow-origin"], undefined);
    });

    test("settings reject non-boolean values", async () => {
      for (const keepHistory of ["true", 1, null, {}, undefined]) {
        assert.equal((await api("/settings/history", { method: "PATCH", token: alice.token, json: { keepHistory } })).status, 400);
      }
      assert.equal((await api("/settings/history", { method: "PATCH", json: { keepHistory: true } })).status, 401);
    });

    test("protected routes all require a login", async () => {
      const routes = [
        ["GET", "/me"], ["GET", "/conversations"], ["GET", "/ice-servers"], ["GET", "/users/search?id=ABCD2345"],
        ["GET", "/message-requests/incoming"], ["POST", "/message-requests"], ["POST", "/message-requests/1/respond"],
        ["POST", "/conversations"], ["POST", "/conversations/1/read"], ["POST", "/conversations/1/images"],
        ["GET", `/conversations/1/images/${"a".repeat(32)}.jpg`], ["PATCH", "/settings/history"], ["DELETE", "/messages"],
      ];
      for (const [method, p] of routes) {
        const r = await api(p, { method, json: method === "GET" ? undefined : {} });
        assert.equal(r.status, 401, `${method} ${p}`);
      }
    });

    test("user search: needs the exact 8-character ID", async () => {
      assert.equal((await api(`/users/search?id=${bob.publicId}`, { token: alice.token })).data.user.id, bob.id);
      for (const id of ["", "short", "A".repeat(9), "%", "a' OR '1'='1"]) {
        assert.equal((await api(`/users/search?id=${encodeURIComponent(id)}`, { token: alice.token })).status, 400, id);
      }
      assert.equal((await api("/users/search?id=ZZZZZZZZ", { token: alice.token })).status, 404);
    });
  });

  describe("real-time messages and calls", () => {
    let sa, sb, sd, sc;

    before(async () => {
      [sa, sb] = [await connect(alice.token), await connect(bob.token)];
      [sc, sd] = [await connect(carol.token), await connect(dave.token)];
      await joinRoom(sa, C1);
      await joinRoom(sb, C1);
    });

    test("odd payloads can't crash the server", async () => {
      const events = ["join_room", "chat_message", "call:invite", "call:answer", "call:ice", "call:end"];
      const payloads = [null, undefined, 0, "text", [], {}, true, 1e9, { room: {} }, { room: "conversation_1" }, { callId: null }, { callId: {}, candidate: "x" }, { room: "x".repeat(2000) }, [[[]]]];
      for (const event of events) for (const payload of payloads) sd.emit(event, payload);

      await sleep(700);
      assert.equal(main.child.exitCode, null, "server still running");
      assert.equal((await api("/health")).status, 200);
    });

    test("an oversized message is dropped and the connection is closed", async () => {
      const big = await connect(carol.token);
      const closed = new Promise((resolve) => big.once("disconnect", () => resolve(true)));
      big.emit("chat_message", { room: `conversation_${C2}`, message: "x".repeat(300 * 1024) });
      assert.equal(await Promise.race([closed, sleep(4000).then(() => false)]), true);
      assert.equal(main.child.exitCode, null);
    });

    test("messages longer than 2000 characters are refused; 2000 is fine", async () => {
      const refused = once(sa, "message_rejected", 1500);
      const leaked = once(sb, "chat_message", 600);
      sa.emit("chat_message", { room: `conversation_${C1}`, message: "x".repeat(2001) });
      assert.equal((await refused).reason, "too_long");
      assert.equal(await leaked, null);

      const delivered = once(sb, "chat_message", 1500);
      sa.emit("chat_message", { room: `conversation_${C1}`, message: "y".repeat(2000) });
      assert.equal((await delivered).message.length, 2000);

      for (const message of ["", "   ", 5, null, {}, []]) {
        const got = once(sb, "chat_message", 200);
        sa.emit("chat_message", { room: `conversation_${C1}`, message });
        assert.equal(await got, null, JSON.stringify(message));
      }
    });

    test("an outsider can't see or send into someone else's room", async () => {
      assert.equal(await joinRoom(sc, C1), null);
      const got = once(sb, "chat_message", 400);
      sc.emit("chat_message", { room: `conversation_${C1}`, message: "hi" });
      assert.equal(await got, null);
    });

    test("calls: ring, answer, relay setup messages, hang up; outsiders and double calls are refused", async () => {
      const sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
      const offer = { type: "offer", sdp };
      const incoming = once(sb, "call:incoming", 1500);
      const ringing = once(sa, "call:ringing", 1500);
      sa.emit("call:invite", { callId: "t1", conversationId: C1, callType: "audio", offer });
      assert.equal((await incoming).from.username, alice.username);
      assert.ok(await ringing);

      const outsider = once(sc, "call:ended", 1500);
      sc.emit("call:invite", { callId: "t2", conversationId: C1, callType: "audio", offer });
      assert.equal((await outsider).reason, "unavailable");

      const busy = once(sb, "call:ended", 1500);
      sb.emit("call:invite", { callId: "t3", conversationId: C1, callType: "video", offer });
      assert.equal((await busy).reason, "busy");

      const answered = once(sa, "call:answered", 1500);
      sb.emit("call:answer", { callId: "t1", answer: { type: "answer", sdp } });
      assert.ok(await answered);

      const hijack = once(sa, "call:ended", 400);
      sc.emit("call:end", { callId: "t1", reason: "hangup" });
      assert.equal(await hijack, null, "a stranger can't end it");

      const ended = once(sb, "call:ended", 1500);
      sa.emit("call:end", { callId: "t1", reason: "hangup" });
      assert.equal((await ended).reason, "hangup");
    });

    test("sending too fast is slowed down", async () => {
      const rejected = new Promise((resolve) => sd.once("message_rejected", (d) => resolve(d.reason)));
      for (let i = 0; i < 45; i += 1) sd.emit("chat_message", { room: `conversation_${C2}`, message: `m${i}` });
      assert.equal(await Promise.race([rejected, sleep(3000).then(() => "none")]), "too_fast");
    });
  });

  describe("start-up checks", () => {
    test("won't start without JWT_SECRET, and says so without printing any secret", () => {
      const r = runServerExpectingExit({ JWT_SECRET: "" });
      assert.equal(r.status, 1);
      assert.match(r.stdout + r.stderr, /JWT_SECRET is not set/);
    });

    test("in production a short JWT_SECRET is refused and never printed", () => {
      const short = "tiny-secret-abc123";
      const r = runServerExpectingExit({ JWT_SECRET: short, NODE_ENV: "production" });
      assert.equal(r.status, 1);
      assert.match(r.stdout + r.stderr, /shorter than 32/);
      assert.ok(!(r.stdout + r.stderr).includes(short));
    });

    test("refuses to keep photos inside the public folder", () => {
      const r = runServerExpectingExit({ JWT_SECRET: SECRET, UPLOAD_DIR: path.join(PUBLIC_DIR, "photos") });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /must not be inside the public folder/);
    });
  });

  // Last on purpose: this uses up the sign-up allowance for this address.
  describe("rate limits", () => {
    test("too many sign-up attempts from one address get 429 with Retry-After", async () => {
      let limited = null;

      for (let i = 0; i < 12 && !limited; i += 1) {
        const r = await api("/signup", { method: "POST", json: { username: "x" } });
        if (r.status === 429) limited = r;
      }

      assert.ok(limited, "a 429 appeared");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });
  });
});
