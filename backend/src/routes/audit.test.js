"use strict";

/**
 * src/routes/audit.test.js
 *
 * Tests for the public audit-chain verification endpoints.
 *
 * The audit routes are public (no auth) but rate-limited.  These tests
 * exercise both the /verify/:table and /chain/:table endpoints using
 * mocked pg pool and auditChain modules so no real Postgres is needed.
 *
 * Integration tests of verifyChain against real data live in
 * auditChain.test.js and auditRetention.integration.test.js.
 */

const request = require("supertest");
const express = require("express");

// ── Mock setup ──────────────────────────────────────────────────────────

// Mock the pool module — each test sets mockPool.query before calling the
// endpoint so the route handler receives controlled responses.
jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const mockPool = require("../db/pool");

// Mock auditChain.verifyChain so we can control the integrity verdict.
jest.mock("../services/auditChain", () => ({
  verifyChain: jest.fn(),
  GENESIS_PREV_HASH: "0",
}));

const { verifyChain } = require("../services/auditChain");

// We mount the route directly on a bare Express app without the Redis rate
// limiter middleware.  The rate-limiting behaviour is tested separately in
// rateLimiter.test.js and rateLimitConfig.test.js.

const router = require("./audit");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/audit", router);
  app.use("/api/v1/audit", router);
  // 404 handler for unmatched routes.
  app.use((req, res) =>
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `${req.method} ${req.path} not found` },
    }),
  );
  // Attach the central error handler for consistent responses.
  const { errorHandler } = require("../server");
  app.use(errorHandler);
  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeChainRows(count, startId = 1) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const id = `r${startId + i}`;
    rows.push({
      id,
      actor: "admin",
      action: `action-${id}`,
      target_type: null,
      target_id: null,
      metadata: "{}",
      ip_address: null,
      created_at: new Date(2026, 6, startId + i).toISOString(),
      prev_hash: i === 0 ? "0" : `hash-r${startId + i - 1}`,
      row_hash: `hash-${id}`,
    });
  }
  return rows;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── GET /api/audit/verify/:table ────────────────────────────────────────

describe("GET /api/audit/verify/:table", () => {
  it("returns valid:true for a clean chain", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 42,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.checked).toBe(42);
    expect(res.body.data.anchored).toBe(false);
  });

  it("detects a tampered chain and returns the first invalid id", async () => {
    verifyChain.mockResolvedValue({
      valid: false,
      firstInvalidId: "r17",
      checked: 100,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.firstInvalidId).toBe("r17");
  });

  it("reports anchored:true when verification resumed from a retention anchor", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 15,
      anchored: true,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.data.anchored).toBe(true);
  });

  it("rejects an unknown table with 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/unknown_table")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    // AppError stores detail in error.detail, and the error handler puts
    // the combined message there.  The detail itself is in
    // res.body.error.detail.
    expect(res.body.error.detail).toMatch(/not available/);
  });

  it("returns 404 for a path without a table name", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/")
      .expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("v1 mount also works", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 3,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
  });
});

// ── GET /api/audit/chain/:table ─────────────────────────────────────────

describe("GET /api/audit/chain/:table", () => {
  it("returns a full chain segment with hash fields", async () => {
    const rows = makeChainRows(3);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: [{ total: "3" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(3);

    // Every returned row must carry prev_hash and row_hash so an external
    // verifier can recompute the chain.
    for (const row of res.body.data.rows) {
      expect(row).toHaveProperty("prev_hash");
      expect(row).toHaveProperty("row_hash");
      expect(row).toHaveProperty("actor");
      expect(row).toHaveProperty("action");
    }

    // When there's no more data, nextCursor is null.
    expect(res.body.data.prevCursor).toBe("r1");
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(3);
  });

  it("supports cursor-based pagination with from and to", async () => {
    const rows = makeChainRows(2, 5); // r5, r6
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "50" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log?from=r4&to=r10&limit=50")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(2);
    expect(res.body.data.prevCursor).toBe("r5");
    // No hasMore → nextCursor null
    expect(res.body.data.nextCursor).toBeNull();

    // Verify the SQL includes the cursor filters.
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/id > \$1/);
    expect(sql).toMatch(/id <= \$2/);
  });

  it("respects the limit parameter (capped at 500)", async () => {
    const rows = makeChainRows(2);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "1000" }], rowCount: 1 });

    const app = makeApp();
    await request(app)
      .get("/api/audit/chain/admin_audit_log?limit=2")
      .expect(200);

    // When no from/to cursors, the only parameter is the limit+1 = 3,
    // so it's $1.
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/LIMIT \$1/);
    const values = mockPool.query.mock.calls[0][1];
    expect(values).toContain(3); // limit + 1
  });

  it("reports hasMore:true when more rows exist beyond the limit", async () => {
    // Return limit+1 rows to signal more data.  Default limit is 100,
    // but we pass limit=3 → 4 rows returned.
    const rows = makeChainRows(4);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 4 })
      .mockResolvedValueOnce({ rows: [{ total: "100" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log?limit=3")
      .expect(200);

    expect(res.body.data.rows).toHaveLength(3); // truncated to limit
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe("r3");
  });

  it("rejects an unknown table with 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/secret_ledger")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toMatch(/not available/);
  });

  it("returns empty rows for a table with no records", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(0);
    expect(res.body.data.prevCursor).toBeNull();
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(0);
  });

  it("v1 mount also works for chain endpoint", async () => {
    const rows = makeChainRows(1);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("audit routes edge cases", () => {
  it("handles verifyChain throwing an unexpected error", async () => {
    verifyChain.mockRejectedValue(new Error("DB connection lost"));

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(500);

    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("handles chain query failure gracefully", async () => {
    mockPool.query.mockRejectedValue(new Error("relation does not exist"));

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(500);

    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});