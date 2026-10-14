// Unit tests for private photo storage (no database or server needed).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-unit-uploads-"));
process.env.UPLOAD_DIR = path.join(root, "storage");
process.env.LEGACY_UPLOAD_DIR = path.join(root, "legacy");

const uploads = (await import("../uploads.js")).default;

// ---- tiny valid-looking files, built by hand ----
const pad = (head, size = 64) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const PNG = pad(Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
]));
const WEBP = pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));
const NAME = "a".repeat(32) + ".jpg";

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("detectImageType: judged by the file's own bytes", () => {
  test("accepts real JPEG, PNG and WebP headers", () => {
    assert.equal(uploads.detectImageType(JPEG), "jpg");
    assert.equal(uploads.detectImageType(PNG), "png");
    assert.equal(uploads.detectImageType(WEBP), "webp");
  });

  test("rejects other formats and disguised files", () => {
    const rejected = {
      gif: pad(Buffer.from("GIF89a")),
      svg: pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
      html: pad(Buffer.from("<!doctype html><script>alert(1)</script>")),
      php: pad(Buffer.from("<?php system($_GET['x']); ?>")),
      exe: pad(Buffer.from("MZ")),
      pdf: pad(Buffer.from("%PDF-1.7")),
      text: Buffer.from("just some text pretending to be a photo, long enough to pass the size check"),
      "PNG signature but no IHDR": pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "RIFF but not WebP": pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")])),
      "JPEG start with no marker": pad(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
      empty: Buffer.alloc(0),
      tiny: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    };

    for (const [label, buffer] of Object.entries(rejected)) {
      assert.equal(uploads.detectImageType(buffer), null, label);
    }
  });

  test("rejects values that are not buffers", () => {
    for (const value of [null, undefined, "string", 5, {}, [], new Uint8Array(100)]) {
      assert.equal(uploads.detectImageType(value), null);
    }
  });
});

describe("addresses and paths", () => {
  test("parseImageUrl only accepts the exact private address shape", () => {
    assert.deepEqual(uploads.parseImageUrl(`/conversations/12/images/${NAME}`), {
      conversationId: 12,
      name: NAME,
    });

    const bad = [
      `/uploads/${NAME}`, // the old public address
      `/uploads/tmp/${NAME}`,
      `/conversations/0/images/${NAME}`,
      `/conversations/012/images/${NAME}`,
      `/conversations/-1/images/${NAME}`,
      `/conversations/1e3/images/${NAME}`,
      `/conversations/99999999999/images/${NAME}`,
      `/conversations/1/images/../${NAME}`,
      `/conversations/1/images/${NAME}/`,
      `/conversations/1/images/${NAME}?x=1`,
      `/conversations/1/images/${NAME}.exe`,
      `/conversations/1/images/${"A".repeat(32)}.jpg`,
      `/conversations/1/images/${"a".repeat(31)}.jpg`,
      `/conversations/1/images/${"a".repeat(32)}.gif`,
      `http://evil.example/conversations/1/images/${NAME}`,
      `//evil.example/conversations/1/images/${NAME}`,
      "", null, undefined, 7, {}, [],
    ];

    for (const url of bad) assert.equal(uploads.parseImageUrl(url), null, String(url));
  });

  test("imagePath builds paths inside storage and refuses anything odd", () => {
    const file = uploads.imagePath(5, NAME);
    assert.equal(file, path.join(uploads.UPLOAD_ROOT, "5", NAME));
    assert.ok(file.startsWith(uploads.UPLOAD_ROOT + path.sep));
    assert.equal(uploads.imagePath(5, NAME, true), path.join(uploads.TEMP_ROOT, "5", NAME));

    const badNames = ["../x.jpg", "..\\x.jpg", `${NAME}\0`, "a/b.jpg", "x.jpg", "", null, `../${NAME}`, `${NAME}/..`];
    for (const name of badNames) assert.throws(() => uploads.imagePath(5, name), /Invalid/, String(name));

    for (const id of [0, -1, 1.5, NaN, "5", null, "../..", 2 ** 40]) {
      assert.throws(() => uploads.imagePath(id, NAME), /Invalid/, String(id));
    }
  });
});

describe("saving, finding, moving and deleting", () => {
  before(() => uploads.ensureUploadDirs());

  test("saveImage writes a private, random-named file and never overwrites", async () => {
    const name = await uploads.saveImage(7, JPEG, "jpg");
    assert.match(name, /^[a-f0-9]{32}\.jpg$/);

    const file = uploads.imagePath(7, name);
    assert.ok(fs.readFileSync(file).equals(JPEG));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0, "not readable by others");

    const other = await uploads.saveImage(7, JPEG, "jpg");
    assert.notEqual(other, name);
  });

  test("findImage finds saved and temporary photos, only inside their own conversation", async () => {
    const saved = await uploads.saveImage(8, PNG, "png");
    const temp = await uploads.saveImage(8, WEBP, "webp", true);

    assert.equal((await uploads.findImage(8, saved)).temp, false);
    assert.equal((await uploads.findImage(8, temp)).temp, true);
    assert.equal(await uploads.findImage(9, saved), null, "other conversation");
    assert.equal(await uploads.findImage(8, "f".repeat(32) + ".jpg"), null, "unknown file");
    assert.equal(await uploads.findImage(8, "../../x"), null, "bad name");
    assert.equal(await uploads.findImage("8", saved), null, "id must be a number");
  });

  test("findImage refuses a symbolic link that points outside storage", async (t) => {
    const secret = path.join(root, "outside-secret.jpg");
    fs.writeFileSync(secret, JPEG);

    const dir = path.join(uploads.UPLOAD_ROOT, "10");
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, NAME);

    try {
      fs.symlinkSync(secret, link);
    } catch {
      return t.skip("cannot create symbolic links here");
    }

    assert.equal(await uploads.findImage(10, NAME), null);
  });

  test("relocateImage moves a photo between saved and temporary storage", async () => {
    const name = await uploads.saveImage(11, JPEG, "jpg", true);

    assert.equal(await uploads.relocateImage(11, name, false), true);
    assert.equal((await uploads.findImage(11, name)).temp, false);

    assert.equal(await uploads.relocateImage(11, name, true), true);
    assert.equal((await uploads.findImage(11, name)).temp, true);

    assert.equal(await uploads.relocateImage(11, name, true), true, "already there");
    assert.equal(await uploads.relocateImage(11, "e".repeat(32) + ".jpg", true), false, "missing");
  });

  test("deleteConversationImages removes everything for those conversations only", async () => {
    const a = await uploads.saveImage(20, JPEG, "jpg");
    const b = await uploads.saveImage(20, JPEG, "jpg", true);
    const keep = await uploads.saveImage(21, JPEG, "jpg");

    await uploads.deleteConversationImages([20, "../..", -5, null, 20.5]);

    assert.equal(await uploads.findImage(20, a), null);
    assert.equal(await uploads.findImage(20, b), null);
    assert.ok(await uploads.findImage(21, keep), "other conversation untouched");
    assert.ok(fs.existsSync(uploads.UPLOAD_ROOT), "storage root untouched");
  });

  test("cleanTempUploads deletes old temporary photos and keeps fresh ones", async () => {
    const old = await uploads.saveImage(30, JPEG, "jpg", true);
    const fresh = await uploads.saveImage(30, JPEG, "jpg", true);
    const oldFile = uploads.imagePath(30, old, true);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

    await uploads.cleanTempUploads();

    assert.equal(await uploads.findImage(30, old), null);
    assert.ok(await uploads.findImage(30, fresh));
  });
});

describe("configuration", () => {
  test("refuses to store photos inside the public folder", () => {
    const result = spawnSync(process.execPath, ["-e", 'require("./uploads")'], {
      cwd: backendDir,
      env: { ...process.env, UPLOAD_DIR: path.join(backendDir, "public", "photos") },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be inside the public folder/);
  });

  test("the default storage folder is not inside the public folder", () => {
    const result = spawnSync(process.execPath, ["-e", 'const u=require("./uploads");console.log(u.UPLOAD_ROOT)'], {
      cwd: backendDir,
      env: { ...process.env, UPLOAD_DIR: "" },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const publicDir = path.join(backendDir, "public");
    assert.ok(!result.stdout.trim().startsWith(publicDir + path.sep));
  });
});
