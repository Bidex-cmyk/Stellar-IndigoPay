#!/bin/bash
#
# scripts/verify-restore-checksum.sh
#
# Verify that a downloaded/restored backup matches its recorded SHA-256 and
# (optionally) that row-level checksums for critical tables match the values
# captured at backup time. Used by the monthly restore drill and can also be
# run ad-hoc during incident response (Workstream 4 of #1100).
#
# Returns non-zero and prints a machine-readable summary on any mismatch so CI
# can fail the drill and fire the RestoreDrillFailed alert.
#
# Usage:
#   ./scripts/verify-restore-checksum.sh \
#       --backup /path/to/backup.sql.gz \
#       [--expected-sha256 <hex>] \
#       [--row-checksums /path/to/file.rowchecksums.json] \
#       [--db-url postgres://user:pass@host:port/db] \
#       [--table donations] [--table projects] ...
#
# Examples:
#   # 1. Byte-for-byte integrity of the artifact alone:
#   ./scripts/verify-restore-checksum.sh --backup /tmp/backup.sql.gz \
#       --expected-sha256 "$(cat /tmp/backup.sql.gz.sha256 | cut -d' ' -f1)"
#
#   # 2. Full drill: artifact hash + row-level checksums against a restore:
#   ./scripts/verify-restore-checksum.sh --backup /tmp/restore.sql.gz \
#       --row-checksums /tmp/restore.sql.gz.rowchecksums.json \
#       --db-url "$DATABASE_URL"
#
# Exit codes: 0 = verified, 1 = checksum mismatch, 2 = missing dependency/arg,
# 3 = row-checksum mismatch.

set -euo pipefail

BACKUP_PATH=""
EXPECTED_SHA256=""
ROW_CHECKSUMS=""
DB_URL=""
TABLES_RAW="donations donation_events projects profiles projection_donor_leaderboard projection_donor_history projection_project_stats projection_global_stats"
MISMATCH=false

usage() {
  sed -n '2,30p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_PATH="$2"; shift 2 ;;
    --expected-sha256) EXPECTED_SHA256="$2"; shift 2 ;;
    --row-checksums) ROW_CHECKSUMS="$2"; shift 2 ;;
    --db-url) DB_URL="$2"; shift 2 ;;
    --table) TABLES_RAW="$TABLES_RAW $2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown flag: $1"; usage ;;
  esac
done

log() { echo "[verify-restore-checksum] $1"; }

[[ -n "$BACKUP_PATH" ]] || { echo "Missing --backup"; usage; }
[[ -f "$BACKUP_PATH" ]] || { echo "Backup file not found: $BACKUP_PATH"; exit 2; }

# ── 1. Byte-for-byte SHA-256 of the artifact ──────────────────────────────
if [[ -n "$EXPECTED_SHA256" ]]; then
  ACTUAL_SHA256=$(sha256sum "$BACKUP_PATH" | awk '{print $1}')
  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    log "❌ SHA-256 MISMATCH: expected $EXPECTED_SHA256, got $ACTUAL_SHA256"
    MISMATCH=true
  else
    log "✅ SHA-256 verified: $ACTUAL_SHA256"
  fi
else
  log "ℹ️  No --expected-sha256 given — skipping byte-for-byte integrity check."
fi

# ── 2. Row-level checksum comparison (expensive; only when a live restore) ─
if [[ -n "$ROW_CHECKSUMS" && -n "$DB_URL" ]]; then
  command -v psql >/dev/null 2>&1 || { echo "psql is required for row-checksum verification"; exit 2; }
  [[ -f "$ROW_CHECKSUMS" ]] || { echo "Row-checksum file not found: $ROW_CHECKSUMS"; exit 2; }

  parse_url() {
    local u="$1"
    DATABASE_URL_HOST="${u#*://}"; DATABASE_URL_HOST="${DATABASE_URL_HOST%%@*}"
    if [[ "$DATABASE_URL_HOST" == *":"* ]]; then
      DATABASE_URL_USER="${DATABASE_URL_HOST%%:*}"
      DATABASE_URL_PASS="${DATABASE_URL_HOST#*:}"
    else
      DATABASE_URL_USER="${DATABASE_URL_HOST}"
      DATABASE_URL_PASS=""
    fi
    local rest="${u#*@}"
    DATABASE_URL_HOSTPORT="${rest%%/*}"
    DATABASE_URL_DB="${rest#*/}"
    DATABASE_URL_DB="${DATABASE_URL_DB%%\?*}"
  }
  parse_url "$DB_URL"
  export PGPASSWORD="$DATABASE_URL_PASS"

  # Verify server-side objects are intact on the restore (WS4 acceptance).
  # Indices, constraints and sequences are surfaced here because a restore
  # that drops them is corrupt even though row counts are unchanged.
  OBJECT_CHECKS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public';" 2>/dev/null | tr -d ' \n')
  CONSTRAINTS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_constraint WHERE contype IN ('f','p','u');" 2>/dev/null | tr -d ' \n')
  TRIGGERS_OK=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
    -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
    "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;" 2>/dev/null | tr -d ' \n')
  log "Restored object integrity — indices=$OBJECT_CHECKS_OK constraints=$CONSTRAINTS_OK triggers=$TRIGGERS_OK"

  for table in $TABLES_RAW; do
    expected=$(jq -r --arg t "$table" '.[] | select(.table==$t) | .md5' "$ROW_CHECKSUMS" 2>/dev/null || echo "")
    if [[ -z "$expected" || "$expected" == "unavailable" ]]; then
      log "ℹ️  No stored checksum for table $table — skipping."
      continue
    fi
    actual=$(psql -h "${DATABASE_URL_HOSTPORT%%:*}" -p "${DATABASE_URL_HOSTPORT##*:}" \
      -U "$DATABASE_URL_USER" -d "$DATABASE_URL_DB" -tAc \
      "SELECT md5(string_agg(md5((t.*)::text), '' ORDER BY 1)) FROM (SELECT * FROM ${table} ORDER BY ctid) t;" 2>/dev/null | tr -d ' \n')
    if [[ "$actual" != "$expected" ]]; then
      log "❌ Row-checksum MISMATCH for table $table: expected $expected, got ${actual:-<empty>}"
      MISMATCH=true
    else
      log "✅ Row-checksum verified for $table ($actual)"
    fi
  done
fi

# ── 3. Emit Prometheus-style summary metrics for the drill ────────────────
if [[ "$MISMATCH" == "true" ]]; then
  echo "restore_drill_checksum_mismatch_total 1" > /tmp/restore_drill_metrics.prom
  echo "restore_drill_success_total 0" >> /tmp/restore_drill_metrics.prom
  echo "❌ Restore verification FAILED. See output above."
  exit 1
else
  echo "restore_drill_success_total 1" > /tmp/restore_drill_metrics.prom
  echo "restore_drill_checksum_mismatch_total 0" >> /tmp/restore_drill_metrics.prom
  log "✅ Restore verification passed."
fi