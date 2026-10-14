// Unit tests for the security helpers (no database or server needed).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "unit-test-secret-that-is-long-enough-1234567890";
const security = (await import("../security.js")).default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("validateSignup", () => {
  const good = { username: "alice_01", email: "Alice@Example.com", password: "correct horse" };

  test("accepts a good sign-up and tidies the email", () => {
    const result = security.validateSignup(good);
    assert.equal(result.error, undefined);
    assert.equal(result.value.email, "alice@example.com");
  });

  test("rejects missing and non-text values (including injection-style objects)", () => {
    const bad = [
      undefined, null, "text", 5, [], {},
      { ...good, username: undefined },
      { ...good, email: 123 },
      { ...good, password: { $ne: null } },
      { ...good, username: ["a", "b", "c"] },
      { ...good, username: "" },
    ];
    for (const body of bad) assert.ok(security.validateSignup(body).error, JSON.stringify(body));
  });

  test("rejects bad usernames", () => {
    for (const username of ["ab", "a".repeat(31), "has space", "semi;colon", "quo'te", "<script>", "émile", "a/b", "../x"]) {
      assert.ok(security.validateSignup({ ...good, username }).error, username);
    }
  });

  test("rejects bad emails", () => {
    for (const email of ["nope", "a@b", "@x.com", "a b@x.com", "a@x", `${"a".repeat(250)}@x.com`]) {
      assert.ok(security.validateSignup({ ...good, email }).error, email);
    }
  });

  test("password rules: 8 or more characters, at most 72 bytes", () => {
    assert.ok(security.validateSignup({ ...good, password: "short" }).error);
    assert.equal(security.validateSignup({ ...good, password: "12345678" }).error, undefined);
    assert.equal(security.validateSignup({ ...good, password: "a".repeat(72) }).error, undefined);
    assert.ok(security.validateSignup({ ...good, password: "a".repeat(73) }).error);
    assert.ok(security.validateSignup({ ...good, password: "é".repeat(37) }).error, "74 bytes");
  });
});

describe("validateLogin", () => {
  test("needs two non-empty strings of sensible length", () => {
    assert.equal(security.validateLogin({ username: "a", password: "b" }).error, undefined);

    for (const body of [null, {}, { username: "a" }, { password: "b" }, { username: {}, password: "b" },
      { username: "a", password: ["x"] }, { username: "", password: "b" }, { username: "a".repeat(101), password: "b" },
      { username: "a", password: "b".repeat(201) }]) {
      assert.ok(security.validateLogin(body).error, JSON.stringify(body));
    }
  });
});

describe("parseId", () => {
  test("accepts whole positive numbers only", () => {
    assert.equal(security.parseId(5), 5);
    assert.equal(security.parseId("42"), 42);
    assert.equal(security.parseId(2147483647), 2147483647);

    for (const value of [0, -1, 1.5, NaN, Infinity, "0", "-3", "1.5", "1e3", "0x10", " 5", "5 ", "", "abc",
      "12345678901", 2147483648, 2 ** 53, null, undefined, true, [5], { id: 5 }, "5; DROP TABLE users"]) {
      assert.equal(security.parseId(value), null, String(JSON.stringify(value)));
    }
  });
});

describe("login tokens", () => {
  test("readBearerToken is strict", () => {
    assert.equal(security.readBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
    assert.equal(security.readBearerToken("bearer abc"), "abc");

    for (const header of [undefined, null, "", "Bearer", "Bearer ", "Basic abc", "abc", "Bearer a b", ["Bearer x"], 5]) {
      assert.equal(security.readBearerToken(header), null, String(header));
    }
  });

  test("verifyToken accepts our own tokens and rejects forgeries", () => {
    const token = security.signToken({ userId: 7, username: "x" });
    assert.equal(security.verifyToken(token).userId, 7);

    const forged = [
      jwt.sign({ userId: 7 }, "some-other-secret"),
      jwt.sign({ userId: 7 }, process.env.JWT_SECRET, { expiresIn: -10 }),
      jwt.sign({ userId: 7 }, process.env.JWT_SECRET, { algorithm: "HS512" }), // algorithm must be HS256
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"userId":7}').toString("base64url")}.`,
      "not.a.token", "", token.slice(0, -2),
    ];
    for (const bad of forged) assert.throws(() => security.verifyToken(bad), undefined, bad.slice(0, 30));
  });
});

describe("checkConfig", () => {
  const silence = (fn) => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try { return { result: fn(), warnings }; } finally { console.warn = warn; }
  };

  test("refuses to run without a JWT_SECRET, and the message holds no secret", () => {
    assert.throws(() => security.checkConfig({}), /JWT_SECRET is not set/);
    assert.throws(() => security.checkConfig({ JWT_SECRET: "" }), /JWT_SECRET is not set/);
  });

  test("a short secret is a warning in development and an error in production", () => {
    const short = "short-secret-value";
    const dev = silence(() => security.checkConfig({ JWT_SECRET: short }));
    assert.equal(dev.warnings.length, 1);
    assert.ok(!dev.warnings[0].includes(short), "never prints the secret");

    assert.throws(
      () => security.checkConfig({ JWT_SECRET: short, NODE_ENV: "production" }),
      (error) => /shorter than 32/.test(error.message) && !error.message.includes(short),
    );
  });

  test("a long secret passes quietly", () => {
    const { warnings } = silence(() => security.checkConfig({ JWT_SECRET: "x".repeat(40), NODE_ENV: "production", CLIENT_ORIGIN: "https://a.example" }));
    assert.equal(warnings.length, 0);
  });

  test("warns about a non-https origin in production", () => {
    const { warnings } = silence(() => security.checkConfig({ JWT_SECRET: "x".repeat(40), NODE_ENV: "production", CLIENT_ORIGIN: "http://a.example" }));
    assert.equal(warnings.length, 1);
  });
});

describe("rate limiting", () => {
  test("WindowCounter allows up to max, then blocks, then recovers", async () => {
    const counter = new security.WindowCounter({ windowMs: 80, max: 3 });
    assert.deepEqual([1, 2, 3].map(() => counter.hit("k").allowed), [true, true, true]);
    assert.equal(counter.hit("k").allowed, false);
    assert.ok(counter.hit("k").retryAfter >= 1);
    assert.equal(counter.hit("other").allowed, true, "keys are independent");

    await sleep(100);
    assert.equal(counter.hit("k").allowed, true, "new window");
  });

  test("isBlocked does not count, and reset forgives", () => {
    const counter = new security.WindowCounter({ windowMs: 1000, max: 2 });
    assert.equal(counter.isBlocked("k").blocked, false);
    counter.hit("k"); counter.hit("k");
    assert.equal(counter.isBlocked("k").blocked, true);
    counter.reset("k");
    assert.equal(counter.isBlocked("k").blocked, false);
  });

  test("rateLimit middleware answers 429 with Retry-After", () => {
    const limiter = security.rateLimit({ windowMs: 1000, max: 2, message: "slow down" });
    const run = () => {
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      let passed = false;
      limiter({ ip: "1.2.3.4" }, res, () => { passed = true; });
      return { res, passed };
    };

    assert.equal(run().passed, true);
    assert.equal(run().passed, true);
    const blocked = run();
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.code, 429);
    assert.equal(blocked.res.body.message, "slow down");
    assert.ok(Number(blocked.res.headers["Retry-After"]) >= 1);
  });

  test("a flood of different keys cannot grow memory without bound", () => {
    const counter = new security.WindowCounter({ windowMs: 60000, max: 1 });
    for (let i = 0; i < 50100; i += 1) counter.hit(`k${i}`);
    assert.ok(counter.entries.size <= 50000);
  });
});

describe("security headers", () => {
  const run = (req) => {
    const headers = {};
    security.securityHeaders(req, { setHeader: (k, v) => (headers[k] = v) }, () => {});
    return headers;
  };

  test("sets the basic protections", () => {
    const headers = run({ secure: false });
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
    assert.equal(headers["Strict-Transport-Security"], undefined);
  });

  test("adds HSTS only on https", () => {
    assert.match(run({ secure: true })["Strict-Transport-Security"], /max-age=/);
  });
});
