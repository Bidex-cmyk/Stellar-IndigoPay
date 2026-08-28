"use strict";

const provider = require("./signingSecretProvider");
const jwt = require("jsonwebtoken");

const ORIG = { ...process.env };

function setEnv(values) {
  for (const k of Object.keys(process.env)) {
    if (/^(JWT_SECRET|WEBHOOK_SIGNING_SECRET|ADMIN_API_KEY|RECURRING_SIGNER_SECRET)/.test(k)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  process.env = { ...ORIG };
});

describe("signingSecretProvider", () => {
  test("currentKey returns the configured current value", () => {
    setEnv({ JWT_SECRET: "cur" });
    expect(provider.currentKey("JWT_SECRET")).toBe("cur");
  });

  test("currentKey throws when no current value is configured", () => {
    setEnv({ JWT_SECRET: "" });
    expect(() => provider.currentKey("JWT_SECRET")).toThrow(/no current value/);
  });

  test("keysForAcceptance returns current + previous + next, current first", () => {
    setEnv({
      JWT_SECRET: "cur",
      JWT_SECRET_PREVIOUS: "prev",
      JWT_SECRET_NEXT: "next",
    });
    const keys = provider.keysForAcceptance("JWT_SECRET");
    expect(keys.map((k) => k.version)).toEqual(["current", "previous", "next"]);
    expect(keys.map((k) => k.key)).toEqual(["cur", "prev", "next"]);
    // kid is a stable fingerprint, never the plaintext.
    expect(keys[0].kid).toMatch(/^[0-9a-f]{16}$/);
  });

  test("keysForAcceptance omits unset optional versions", () => {
    setEnv({ JWT_SECRET: "cur" });
    const keys = provider.keysForAcceptance("JWT_SECRET");
    expect(keys.length).toBe(1);
    expect(keys[0].version).toBe("current");
  });

  test("describe returns fingerprints, not values", () => {
    setEnv({ JWT_SECRET: "cur", JWT_SECRET_NEXT: "new" });
    const d = provider.describe("JWT_SECRET");
    expect(typeof d.current).toBe("string");
    expect(d.current).not.toBe("cur");
    expect(typeof d.next).toBe("string");
    expect(d.previous).toBeNull();
  });

  test("registeredSecretNames only reports configured secrets", () => {
    setEnv({
      JWT_SECRET: "cur",
      WEBHOOK_SIGNING_SECRET: "",
    });
    expect(provider.registeredSecretNames()).toEqual(["JWT_SECRET"]);
  });

  test("keyIdFor is deterministic and differs across values", () => {
    expect(provider.keyIdFor("a")).toBe(provider.keyIdFor("a"));
    expect(provider.keyIdFor("a")).not.toBe(provider.keyIdFor("b"));
  });

  describe("integration with jsonwebtoken", () => {
    // jsonwebtoken.verify accepts a single secret, so — exactly like
    // middleware/auth.verifyToken — we iterate the acceptance candidates.
    function verifyWithAny(payload, candidates) {
      let lastError;
      for (const key of candidates) {
        try {
          return jwt.verify(payload, key);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    }

    test("a token signed with the previous key still verifies during rotation", () => {
      setEnv({
        JWT_SECRET: "current-key",
        JWT_SECRET_PREVIOUS: "old-key",
      });
      const oldToken = jwt.sign({ sub: "1" }, "old-key");
      const candidates = provider.keysForAcceptance("JWT_SECRET").map((k) => k.key);
      expect(verifyWithAny(oldToken, candidates).sub).toBe("1");
    });

    test("a token signed with an unknown key is rejected", () => {
      setEnv({ JWT_SECRET: "current-key" });
      const token = jwt.sign({ sub: "1" }, "someone-elses-key");
      const candidates = provider.keysForAcceptance("JWT_SECRET").map((k) => k.key);
      expect(() => verifyWithAny(token, candidates)).toThrow();
    });
  });
});