"use strict";

/**
 * src/routes/audit.js
 *
 * Public audit-chain verification endpoints.
 *
 * The admin_audit_log table carries a tamper-evident hash chain (see
 * services/auditChain.js). These endpoints let any third party independently
 * verify the chain's integrity and fetch chain segments for offline
 * recomputation — making the log externally verifiable without requiring
 * admin credentials.
 *
 * Endpoints:
 *   GET /api/audit/verify/:table
 *     Runs verifyChain() and returns the integrity verdict.
 *
 *   GET /api/audit/chain/:table?from=X&to=Y&limit=200
 *     Returns a sorted segment of the hash chain with prev_hash and
 *     row_hash values so anyone can recompute the chain offline.
 *
 * Both endpoints are public (no authentication required — public
 * verifiability is the point) but are rate-limited via the per-endpoint
 * Redis limiter configured in middleware/rateLimitConfig.js.
 */

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const logger = require("../logger");
const { verifyChain } = require("../services/auditChain");
const { AppError } = require("../errors");

/**
 * Tables that expose a hash chain for public verification.
 * Adding a table to this set requires that:
 *   1. The table has `prev_hash` and `row_hash` columns.
 *   2. verifyChain() or an equivalent validator exists.
 */
const AUDITABLE_TABLES = new Set(["admin_audit_log"]);

// Column sets returned by the chain endpoint.  MUST include prev_hash and
// row_hash.  All other columns are the canonical fields used in
// computeRowHash() (see auditChain.canonicalize), ordered here as they
// appear in the canonicalization to make offline recomputation
// straightforward.
const CHAIN_COLUMNS = [
  "id",
  "actor",
  "action",
  "target_type",
  "target_id",
  "metadata",
  "ip_address",
  "created_at",
  "prev_hash",
  "row_hash",
];

function validateTable(table) {
  if (!table || !AUDITABLE_TABLES.has(table)) {
    throw new AppError("VALIDATION_ERROR", {
      field: "table",
      detail: `Audit chain not available for table "${table}". Supported: ${[...AUDITABLE_TABLES].join(", ")}`,
    });
  }
}

/**
 * GET /api/audit/verify/:table
 *
 * Runs the hash-chain integrity check on the requested table and returns the
 * verdict.  The response includes:
 *   - valid:       whether the chain is intact
 *   - firstInvalidId: id of the first broken row (only when !valid)
 *   - checked:     number of rows examined
 *   - anchored:    whether verification resumed from a retention anchor
 *     (true when older rows have been pruned)
 *
 * Rate-limited per middleware/rateLimitConfig.js.
 */
router.get("/verify/:table", async (req, res, next) => {
  try {
    validateTable(req.params.table);

    const result = await verifyChain(pool);

    (req.log || logger).info(
      {
        event: "audit_chain_verify_public",
        table: req.params.table,
        valid: result.valid,
        checked: result.checked,
        anchored: result.anchored,
      },
      `Public audit-chain verification for ${req.params.table}: ${result.valid ? "valid" : "INVALID"}`,
    );

    return res.json({ success: true, data: result });
  } catch (e) {
    return next(e);
  }
});

/**
 * GET /api/audit/chain/:table
 *
 * Returns a paginated segment of the hash chain for offline recomputation.
 *
 * Query parameters:
 *   from  — cursor: return rows with id > `from` (lexicographic)
 *   to    — cursor: return rows with id <= `to`
 *   limit — max rows to return (default 100, max 500)
 *
 * Rows are returned in chain order (oldest first) so the caller can walk
 * them in a single pass, recomputing row_hash from the preceding prev_hash.
 * The result includes:
 *   - rows:       array of chain rows with all canonical fields
 *   - prevCursor: id of the first returned row (null if no earlier rows)
 *   - nextCursor: id of the last returned row (null if no later rows)
 *   - total:      a rough estimate of total chain length (for progress UX)
 *
 * Rate-limited per middleware/rateLimitConfig.js.
 */
router.get("/chain/:table", async (req, res, next) => {
  try {
    validateTable(req.params.table);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      500,
    );
    const from = req.query.from || null;
    const to = req.query.to || null;

    // Build a parameterised query.  All user-supplied values are passed
    // through $N placeholders — no raw concatenation.
    const conditions = [];
    const values = [];

    if (from) {
      values.push(from);
      conditions.push(`id > $${values.length}`);
    }
    if (to) {
      values.push(to);
      conditions.push(`id <= $${values.length}`);
    }

    // Column list is drawn from a fixed constant — safe to interpolate.
    // Table name is validated against AUDITABLE_TABLES — user input never
    // reaches the SQL text without whitelist enforcement.
    const cols = CHAIN_COLUMNS.join(", ");
    /* eslint-disable sql-injection/no-sql-injection */
    let query = `SELECT ${cols} FROM ${req.params.table}`;
    if (conditions.length) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY created_at ASC, id ASC";
    values.push(limit + 1);
    query += ` LIMIT $${values.length}`;

    const [chainResult, countResult] = await Promise.all([
      pool.query(query, values),
      pool.query(`SELECT COUNT(*)::bigint AS total FROM ${req.params.table}`),
    ]);
    /* eslint-enable sql-injection/no-sql-injection */

    const rows = chainResult.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    (req.log || logger).info(
      {
        event: "audit_chain_fetch_public",
        table: req.params.table,
        rowCount: page.length,
        fromCursor: from,
        toCursor: to,
        hasMore,
      },
      `Public audit-chain segment fetched for ${req.params.table}: ${page.length} rows`,
    );

    return res.json({
      success: true,
      data: {
        rows: page,
        prevCursor: page.length > 0 ? page[0].id : null,
        nextCursor: hasMore ? page[page.length - 1].id : null,
        total: Number(countResult.rows[0]?.total || 0),
        hasMore,
      },
    });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;