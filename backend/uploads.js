/**
 * Private photo storage.
 *
 * Photos are NOT served from a public folder. They live in UPLOAD_DIR (outside
 * the web-served `public` folder) and are only readable through
 * GET /conversations/:id/images/:name, which checks the login token and that
 * the person belongs to that conversation.
 *
 * Layout:  <UPLOAD_DIR>/<conversationId>/<name>        chats that save history
 *          <UPLOAD_DIR>/tmp/<conversationId>/<name>    chats that don't (deleted after 1 hour)
 *
 * The conversation id is part of the path, so a file can only ever be read
 * through the conversation it was uploaded to.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("./db");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const PUBLIC_DIR = path.resolve(__dirname, "public");
const UPLOAD_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "storage", "uploads"),
);
const TEMP_ROOT = path.join(UPLOAD_ROOT, "tmp");

// The folder the old, public version used. Only read once, to migrate.
const LEGACY_DIR = path.resolve(
  process.env.LEGACY_UPLOAD_DIR || path.join(__dirname, "uploads"),
);

if (UPLOAD_ROOT === PUBLIC_DIR || UPLOAD_ROOT.startsWith(PUBLIC_DIR + path.sep)) {
  throw new Error("UPLOAD_DIR must not be inside the public folder");
}

const IMAGE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const IMAGE_URL =
  /^\/conversations\/([1-9]\d{0,9})\/images\/([a-f0-9]{32}\.(?:jpg|png|webp))$/;

const MIME_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/* ---------- Validation ---------- */

function isValidConversationId(id) {
  return Number.isInteger(id) && id > 0 && id <= 2147483647;
}

function isValidImageName(name) {
  return typeof name === "string" && IMAGE_NAME.test(name);
}

function mimeTypeFor(name) {
  return MIME_TYPES[name.slice(name.lastIndexOf(".") + 1)];
}

// Looks at the file's own bytes. The file name and the type the browser
// reports are never trusted.
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;

  // JPEG: starts with FF D8 FF and a real marker byte
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer[3] >= 0xc0 &&
    buffer[3] !== 0xff
  ) {
    return "jpg";
  }

  // PNG: signature, then the IHDR header chunk
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ) &&
    buffer.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return "png";
  }

  // WebP: RIFF container holding a VP8 / VP8L / VP8X chunk
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(buffer.subarray(12, 16).toString("ascii"))
  ) {
    return "webp";
  }

  return null;
}

/* ---------- Addresses and paths ---------- */

function imageUrl(conversationId, name) {
  return `/conversations/${conversationId}/images/${name}`;
}

// "/conversations/12/images/<name>" -> { conversationId: 12, name }
function parseImageUrl(url) {
  const match = typeof url === "string" ? IMAGE_URL.exec(url) : null;

  return match ? { conversationId: Number(match[1]), name: match[2] } : null;
}

function conversationDir(conversationId, temp) {
  return path.join(temp ? TEMP_ROOT : UPLOAD_ROOT, String(conversationId));
}

// Builds a file path only from a validated id and name, and double-checks
// that it stays inside the storage folder.
function imagePath(conversationId, name, temp = false) {
  if (!isValidConversationId(conversationId) || !isValidImageName(name)) {
    throw new Error("Invalid image reference");
  }

  const file = path.join(conversationDir(conversationId, temp), name);

  if (!file.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error("Invalid image path");
  }

  return file;
}

async function ensureUploadDirs() {
  await fs.promises.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
}

/* ---------- Saving, finding, moving, deleting ---------- */

async function saveImage(conversationId, buffer, type, temp = false) {
  const name = `${crypto.randomBytes(16).toString("hex")}.${type}`;
  const file = imagePath(conversationId, name, temp);

  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // "wx": never overwrite an existing file
  await fs.promises.writeFile(file, buffer, { flag: "wx", mode: 0o600 });

  return name;
}

// Returns { file, temp } for a photo that exists, otherwise null. Also refuses
// anything that isn't a plain file inside the storage folder (for example a
// symbolic link pointing somewhere else).
async function findImage(conversationId, name) {
  if (!isValidConversationId(conversationId) || !isValidImageName(name)) {
    return null;
  }

  let rootReal;

  try {
    rootReal = await fs.promises.realpath(UPLOAD_ROOT);
  } catch {
    return null;
  }

  for (const temp of [false, true]) {
    try {
      const file = imagePath(conversationId, name, temp);
      const real = await fs.promises.realpath(file);
      const stats = await fs.promises.stat(real);

      if (stats.isFile() && real.startsWith(rootReal + path.sep)) {
        return { file: real, temp };
      }
    } catch {
      // not in this folder
    }
  }

  return null;
}

// Keeps a photo in the folder that matches the chat's history setting.
async function relocateImage(conversationId, name, toTemp) {
  const found = await findImage(conversationId, name);

  if (!found) return false;
  if (found.temp === toTemp) return true;

  const target = imagePath(conversationId, name, toTemp);

  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  try {
    await fs.promises.rename(found.file, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;

    // Different disks: copy, then remove the original.
    await fs.promises.copyFile(found.file, target);
    await fs.promises.unlink(found.file);
  }

  return true;
}

// Removes every saved and temporary photo of these conversations.
async function deleteConversationImages(conversationIds) {
  for (const id of conversationIds) {
    if (!isValidConversationId(id)) continue;

    for (const temp of [false, true]) {
      await fs.promises
        .rm(conversationDir(id, temp), { recursive: true, force: true })
        .catch((error) => console.error("Photo delete error:", error.code));
    }
  }
}

/* ---------- Clean-up jobs ---------- */

async function numericDirs(root) {
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory() && /^[1-9]\d{0,9}$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Photos from chats that don't save history are removed after an hour.
async function cleanTempUploads() {
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;

  for (const dirName of await numericDirs(TEMP_ROOT)) {
    const dir = path.join(TEMP_ROOT, dirName);

    try {
      for (const fileName of await fs.promises.readdir(dir)) {
        const file = path.join(dir, fileName);
        const stats = await fs.promises.stat(file);

        if (stats.isFile() && stats.mtimeMs < cutoff) {
          await fs.promises.unlink(file);
        }
      }

      await fs.promises.rmdir(dir).catch(() => {}); // only if empty
    } catch (error) {
      console.error("Temp photo clean-up error:", error.code);
    }
  }
}

// Photos that were uploaded but never attached to a message (for example a
// failed send) are removed after an hour.
async function cleanOrphanUploads() {
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;

  for (const dirName of await numericDirs(UPLOAD_ROOT)) {
    const dir = path.join(UPLOAD_ROOT, dirName);

    try {
      for (const fileName of await fs.promises.readdir(dir)) {
        if (!isValidImageName(fileName)) continue;

        const file = path.join(dir, fileName);
        const stats = await fs.promises.stat(file);

        if (!stats.isFile() || stats.mtimeMs > cutoff) continue;

        const used = await pool.query(
          `SELECT 1 FROM messages WHERE image_url = $1 LIMIT 1`,
          [imageUrl(Number(dirName), fileName)],
        );

        if (used.rows.length === 0) await fs.promises.unlink(file);
      }
    } catch (error) {
      console.error("Orphan photo clean-up error:", error.code || error.message);
    }
  }
}

/* ---------- One-time move from the old public folder ---------- */

// Earlier versions stored photos in backend/uploads and served that folder to
// everyone. This moves the photos that belong to saved messages into private
// storage and rewrites their addresses. Safe to run on every start.
async function migrateLegacyUploads() {
  let legacyFiles;

  try {
    legacyFiles = await fs.promises.readdir(LEGACY_DIR);
  } catch {
    return { moved: 0, missing: 0 };
  }

  // Temporary photos are meant to disappear anyway.
  await fs.promises
    .rm(path.join(LEGACY_DIR, "tmp"), { recursive: true, force: true })
    .catch(() => {});

  const rows = await pool.query(
    `SELECT id, room, image_url FROM messages WHERE image_url LIKE '/uploads/%'`,
  );

  let moved = 0;
  let missing = 0;

  for (const row of rows.rows) {
    const name = row.image_url.slice("/uploads/".length);
    const conversationId = Number(/^conversation_(\d+)$/.exec(row.room)?.[1]);

    if (!isValidImageName(name) || !isValidConversationId(conversationId)) {
      continue;
    }

    const source = path.join(LEGACY_DIR, name);
    const target = imagePath(conversationId, name, false);

    try {
      await fs.promises.mkdir(path.dirname(target), {
        recursive: true,
        mode: 0o700,
      });

      try {
        await fs.promises.rename(source, target);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;

        await fs.promises.copyFile(source, target);
        await fs.promises.unlink(source);
      }

      moved += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;

      missing += 1; // the file was already gone
    }

    await pool.query(`UPDATE messages SET image_url = $2 WHERE id = $1`, [
      row.id,
      imageUrl(conversationId, name),
    ]);
  }

  const left = legacyFiles.filter((file) => IMAGE_NAME.test(file)).length;

  if (moved || missing || left) {
    console.log(
      `Photo storage: moved ${moved} photo(s) to private storage` +
        (missing ? `, ${missing} were already missing` : "") +
        (left ? `. ${left} unreferenced file(s) remain in backend/uploads (no longer served)` : ""),
    );
  }

  return { moved, missing };
}

module.exports = {
  MAX_IMAGE_BYTES,
  UPLOAD_ROOT,
  TEMP_ROOT,
  LEGACY_DIR,
  isValidConversationId,
  isValidImageName,
  mimeTypeFor,
  detectImageType,
  imageUrl,
  parseImageUrl,
  imagePath,
  ensureUploadDirs,
  saveImage,
  findImage,
  relocateImage,
  deleteConversationImages,
  cleanTempUploads,
  cleanOrphanUploads,
  migrateLegacyUploads,
};
