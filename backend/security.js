/**
 * Security helpers: startup checks, login tokens, rate limits and input checks.
 * Nothing in here ever logs or returns a secret.
 */
const jwt = require("jsonwebtoken");

/* ---------- Startup checks ---------- */

// Stops the server from starting half-configured. Messages name the setting,
// never its value.
function checkConfig(env = process.env) {
  if (!env.JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is not set. Add a long random value to backend/.env " +
        "(for example the output of: openssl rand -hex 32).",
    );
  }

  if (env.JWT_SECRET.length < 32) {
    const message = "JWT_SECRET is shorter than 32 characters.";

    if (env.NODE_ENV === "production") {
      throw new Error(`${message} Use a long random value in production.`);
    }

    console.warn(`Warning: ${message} Use a longer one before going live.`);
  }

  if (env.NODE_ENV === "production") {
    const origins = (env.CLIENT_ORIGIN || "").split(",").map((o) => o.trim());

    if (origins.some((origin) => origin && !origin.startsWith("https://"))) {
      console.warn(
        "Warning: CLIENT_ORIGIN contains a non-https address. Use https in production.",
      );
    }
  }
}

/* ---------- Login tokens ---------- */

// The algorithm is pinned so a token can't pick a weaker one ("none" etc.).
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "7d",
  });
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
}

// "Bearer <token>" -> "<token>", anything else -> null
function readBearerToken(header) {
  if (typeof header !== "string") return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return match ? match[1] : null;
}

/* ---------- Rate limits (in memory, per server process) ---------- */

class WindowCounter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.entries = new Map();

    const timer = setInterval(() => this.sweep(), Math.max(windowMs, 60000));
    timer.unref();
  }

  sweep() {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (entry.reset <= now) this.entries.delete(key);
    }
  }

  // Counts one attempt for this key.
  hit(key) {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || entry.reset <= now) {
      // Keep memory bounded if someone floods with different keys.
      if (this.entries.size >= 50000) {
        this.entries.delete(this.entries.keys().next().value);
      }

      entry = { count: 0, reset: now + this.windowMs };
      this.entries.set(key, entry);
    }

    entry.count += 1;

    return {
      allowed: entry.count <= this.max,
      retryAfter: Math.max(1, Math.ceil((entry.reset - now) / 1000)),
    };
  }

  // Is this key already over the limit? (does not count an attempt)
  isBlocked(key) {
    const entry = this.entries.get(key);

    return {
      blocked: !!entry && entry.reset > Date.now() && entry.count >= this.max,
      retryAfter: entry
        ? Math.max(1, Math.ceil((entry.reset - Date.now()) / 1000))
        : 0,
    };
  }

  reset(key) {
    this.entries.delete(key);
  }
}

function rateLimit({ windowMs, max, key = (req) => req.ip, message }) {
  const counter = new WindowCounter({ windowMs, max });

  return (req, res, next) => {
    const result = counter.hit(String(key(req)));

    if (result.allowed) return next();

    res.setHeader("Retry-After", String(result.retryAfter));

    return res.status(429).json({
      message: message || "Too many requests. Please try again later.",
    });
  };
}

/* ---------- Security headers ---------- */

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }

  next();
}

/* ---------- Input checks ---------- */

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// bcrypt only uses the first 72 bytes, so longer passwords are refused
// instead of being silently cut.
function validateSignup(body) {
  const { username, email, password } = body || {};

  if (
    typeof username !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !username ||
    !email ||
    !password
  ) {
    return { error: "Username, email, and password are required" };
  }

  if (!USERNAME_PATTERN.test(username)) {
    return {
      error:
        "Username must be 3 to 30 characters: letters, numbers, dots, dashes or underscores",
    };
  }

  const cleanEmail = email.trim().toLowerCase();

  if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) {
    return { error: "Enter a valid email address" };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  if (Buffer.byteLength(password, "utf8") > 72) {
    return { error: "Password must be 72 bytes or fewer" };
  }

  return { value: { username, email: cleanEmail, password } };
}

function validateLogin(body) {
  const { username, password } = body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username ||
    !password
  ) {
    return { error: "Username and password are required" };
  }

  if (username.length > 100 || password.length > 200) {
    return { error: "Invalid username or password" };
  }

  return { value: { username, password } };
}

// A positive whole number, given as a number or as digits in a string.
// Anything else (arrays, objects, "1e3", "0x10", " 5 ") is rejected.
function parseId(value) {
  const isNumber = typeof value === "number";
  const isDigits = typeof value === "string" && /^[0-9]{1,10}$/.test(value);

  if (!isNumber && !isDigits) return null;

  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

module.exports = {
  checkConfig,
  signToken,
  verifyToken,
  readBearerToken,
  WindowCounter,
  rateLimit,
  securityHeaders,
  validateSignup,
  validateLogin,
  parseId,
};
