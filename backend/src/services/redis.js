"use strict";

/**
 * src/services/redis.js
 *
 * Redis client abstraction for the Stellar IndigoPay backend.
 *
 * Supports two modes:
 *   1. Single-instance (default): REDIS_URL → one ioredis client.
 *   2. Sharded: REDIS_URLS (comma-separated) → multiple clients with
 *      consistent hashing for key routing.
 *
 * Exports:
 *   - getClient([key])  — Returns a Redis client. When `key` is provided,
 *                          routes to the shard responsible for that key.
 *                          When omitted, returns the first (default) client.
 *   - get(key)          — JSON-aware cache read (any shard via routing).
 *   - set(key, val, ttl)— JSON-aware cache write.
 *   - deletePattern(p)  — Deletes all keys matching `pattern` on ALL shards.
 *   - initRedis()       — Force initialise the pool (useful for testing).
 *   - _reset()          — Reset internal state (test-only).
 */

const Redis = require("ioredis");
const { ConsistentHashRing } = require("./consistentHash");

/** @type {import("ioredis").Redis[]} */
let clients = [];

/** @type {ConsistentHashRing|null} */
let ring = null;

/** Whether initRedis() has been called at least once. */
let _initialised = false;

/**
 * Return the list of Redis passwords to attempt, current first.
 *
 * Dual-version support (WS3 / #1100): during a rotation the current password
 * lives in `REDIS_PASSWORD` and the previous one lives in `REDIS_PASSWORD_PREVIOUS`
 * (or `CLIENTSIDE_REDIS_PASSWORD_PREVIOUS` if the URL carries the credentials).
 * A consumer that fails AUTH with the current key can retry with the previous
 * key until the rotation grace period is over.
 *
 * @param {object} [opts]
 * @param {{password?: string, previousPassword?: string}} [opts.urlCreds] - parsed
 *   credentials from a REDIS_URL (user:pass@host). When provided they take
 *   precedence over env vars.
 * @returns {string[]} Non-empty password candidates, current first.
 */
function getAuthCandidates(opts = {}) {
  const urlCreds = opts.urlCreds || {};
  const candidates = [
    urlCreds.password || process.env.REDIS_PASSWORD || "",
    urlCreds.previousPassword ||
      process.env.REDIS_PASSWORD_PREVIOUS ||
      process.env.CLIENTSIDE_REDIS_PASSWORD_PREVIOUS ||
      "",
  ];
  // De-duplicate, drop empties, preserve order (current first).
  return [...new Set(candidates)].filter(Boolean);
}

/**
 * Initialise Redis connections from environment variables.
 *
 * When REDIS_URLS is set (comma-separated), each URL gets its own ioredis
 * client and a consistent hashing ring distributes keys across them.
 * Falls back to REDIS_URL (single instance) when REDIS_URLS is absent.
 *
 * @returns {{ clients: import("ioredis").Redis[], ring: ConsistentHashRing }}
 */
function initRedis() {
  if (_initialised) return { clients, ring };

  const urlsRaw = process.env.REDIS_URLS
    ? process.env.REDIS_URLS.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.REDIS_URL || "redis://localhost:6379"];

  clients = urlsRaw.map((url) => {
    // Parse URL credentials so we can layer dual-version AUTH fallback on top
    // of whatever the connection string already carries.
    const parsed = /([^:@/]+)?:([^@/]+)@/.exec(url);
    const urlCreds = parsed
      ? { password: decodeURIComponent(parsed[2] || "") }
      : {};
    const authCandidates = getAuthCandidates({ urlCreds });

    const client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      // When a separate REDIS_PASSWORD is configured, pass it explicitly so
      // ioredis authenticates with it before any command (dual-version safe).
      ...(urlCreds.password ? {} : authCandidates[0] ? { password: authCandidates[0] } : {}),
    });

    client.on("error", (err) => {
      // On an AUTH error, transparently retry the connection with the previous
      // password (rotation grace window). Other errors remain non-fatal.
      if (authCandidates.length > 1 && err && /NOAUTH|ERR.*auth/i.test(String(err.message || ""))) {
        const fallback = new Redis(url, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          password: authCandidates[1],
        });
        fallback.connect().catch(() => {
          // Best-effort fallback; cache simply goes unauthenticated otherwise.
        });
        fallback.on("error", () => {});
        // Swap the box-level client so subsequent calls use the working one.
        const idx = clients.indexOf(client);
        if (idx !== -1) clients[idx] = fallback;
        return;
      }
      // Redis connection errors are non-fatal; bypass cache on failure
    });

    client.connect().catch(() => {
      // Non-fatal: server runs without cache if Redis is unavailable
    });

    return client;
  });

  ring = new ConsistentHashRing(
    clients.map((_, i) => `shard-${i}`),
    parseInt(process.env.RATE_LIMIT_CONSISTENT_HASH_VNODES || "150", 10) || 150,
  );

  _initialised = true;
  return { clients, ring };
}

/**
 * Return a Redis client, optionally routed to a specific shard.
 *
 * @param {string} [key] - Rate-limit key (or other shard-routing key).
 *   When omitted, returns the first (default) client for backward compat.
 * @returns {import("ioredis").Redis}
 */
function getClient(key) {
  if (!_initialised) initRedis();

  if (clients.length === 0) {
    // Should not happen, but guard against empty state
    return new Redis();
  }

  if (key !== undefined && clients.length > 1) {
    const node = ring.getNode(key);
    if (node !== null) {
      // Parse "shard-N" → index N
      const idx = parseInt(node.split("-")[1], 10);
      if (!isNaN(idx) && idx >= 0 && idx < clients.length) {
        return clients[idx];
      }
    }
  }

  // Default: return the first client (backward compatible)
  return clients[0];
}

/**
 * Read a JSON value from the cache.
 *
 * For sharded environments the key is routed through consistent hashing.
 *
 * @param {string} key
 * @returns {Promise<*>} Parsed JSON value or null on miss/error.
 */
async function get(key) {
  try {
    const c = getClient(key);
    const value = await c.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * Write a JSON value to the cache.
 *
 * For sharded environments the key is routed through consistent hashing.
 *
 * @param {string} key
 * @param {*}      value      - Any JSON-serialisable value
 * @param {number} [ttlSeconds]- Optional TTL in seconds
 * @returns {Promise<void>}
 */
async function set(key, value, ttlSeconds) {
  try {
    const c = getClient(key);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await c.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } else {
      await c.set(key, JSON.stringify(value));
    }
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Delete all keys matching `pattern` across ALL shards.
 *
 * This is intentionally NOT shard-routed because patterns like
 * "cache:projects:*" need to sweep every Redis instance.
 *
 * @param {string} pattern - Redis glob pattern (e.g. "cache:projects:*")
 * @returns {Promise<void>}
 */
async function deletePattern(pattern) {
  if (!_initialised) initRedis();

  const results = await Promise.allSettled(
    clients.map(async (c) => {
      const keys = await c.keys(pattern);
      if (keys.length > 0) {
        await c.del(...keys);
      }
    }),
  );

  // Log failures but don't throw — cache invalidation is best-effort
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    // Swallow; cache invalidation failures are non-fatal. Operators can
    // detect partial invalidation by monitoring per-shard key counts.
  }
}

/**
 * Return the number of connected shards (for health checks).
 * @returns {number}
 */
function shardCount() {
  return clients.length;
}

/**
 * Test-only: reset internal state so tests can re-initialise with
 * different environment variables.
 *
 * @package
 */
function _reset() {
  clients = [];
  ring = null;
  _initialised = false;
}

module.exports = {
  getClient,
  get,
  set,
  deletePattern,
  initRedis,
  shardCount,
  getAuthCandidates,
  _reset,
};
