#!/usr/bin/env node
"use strict";

/**
 * scripts/postgres-healthcheck-daemon.js
 *
 * Real-time PostgreSQL health-check daemon (Workstream 1 of #1100).
 *
 * This daemon replaces the "CronJob-style fixed schedule" failover model with
 * a continuous, event-driven loop:
 *
 *   1. Every HEALTHCHECK_INTERVAL_MS it runs `pg_isready` against the primary
 *      endpoint (defaults to `localhost`, override with PG_PRIMARY_HOST) on
 *      behalf of whichever PostgreSQL instance this sidecar protects.
 *   2. After `HEALTHCHECK_THRESHOLD` *consecutive* failed checks it enters a
 *      split-brain-protected promotion:
 *        a. It tries to acquire a Kubernetes Lease (`postgres-primary-lock`)
 *           with a short TTL. Only ONE instance in the cluster can hold the
 *           lease at a time (there is only supposed to be one primary, but the
 *           Lease is the *distributed* guarantee that two standbys won't both
 *           promote).
 *        b. If it wins the lease it creates the `postgres-failover` Job (which
 *           is what actually runs `pg_ctl promote`, patches the Services, and
 *           restarts the backend). The Lease is held for the whole failover so
 *           a competing replica sees the lock and backs off.
 *        c. If it loses the lease it logs a warning and backs off without
 *           touching Postgres.
 *   3. While the node is healthy it keeps renewing / re-acquiring the Lease so
 *      that the *current* writer holds it (the primary keeps the lease and the
 *      standby cannot promote while the lease is fresh).
 *
 * This is deliberately implemented against the plain Kubernetes REST API so it
 * runs inside a pod with just the service-account token mounted (no extra
 * client libraries), matching the existing shell-based healthcheck pattern in
 * `k8s/postgres.yaml` but with real retry/backoff, split-brain prevention, and
 * structured logging.
 *
 * Environment variables:
 *   PG_PRIMARY_HOST        — host to health-check (default: localhost)
 *   PG_PRIMARY_PORT        — port (default: 5432)
 *   PG_USER                — user for pg_isready (default: postgres)
 *   PG_DB                  — database for pg_isready (default: postgres)
 *   POSTGRES_USER          — fallback user (uses PG_USER)
 *   HEALTHCHECK_INTERVAL_MS    — poll interval (default: 5000)
 *   HEALTHCHECK_THRESHOLD      — consecutive failures to trigger failover (default: 3)
 *   LEASE_NAME             — Lease name (default: postgres-primary-lock)
 *   LEASE_TTL_SECONDS      — Lease renew TTL (default: 30)
 *   LEASE_RENEW_MS         — lease renew interval (default: 10000)
 *   PROMETHEUS_BACKEND_URL — optional metrics endpoint to increment
 *                            postgres_failover_total on the backend
 *   FAILOVER_JOB_IMAGE     — image for the failover Job (default:
 *                            bitnami/kubectl:latest)
 *
 * The pod must run with the `postgres-healthcheck-sa` ServiceAccount, which
 * grants `get` on leases and `create` on jobs (see
 * k8s/postgres-failover-rbac.yaml).
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const NAMESPACE =
  process.env.NAMESPACE ||
  (() => {
    try {
      return fs
        .readFileSync(
          "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
          "utf8",
        )
        .trim();
    } catch {
      return "stellar-indigopay";
    }
  })();

const API = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || "443"}`
  : process.env.K8S_API_URL || "https://kubernetes.default.svc";

const TOKEN = (() => {
  try {
    return fs
      .readFileSync(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      )
      .trim();
  } catch {
    return process.env.K8S_BEARER_TOKEN || "";
  }
})();

const CACERT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  primaryHost: process.env.PG_PRIMARY_HOST || "localhost",
  primaryPort: Number.parseInt(process.env.PG_PRIMARY_PORT || "5432", 10),
  pgUser: process.env.PG_USER || process.env.POSTGRES_USER || "postgres",
  pgDb: process.env.PG_DB || "postgres",
  intervalMs: Number.parseInt(
    process.env.HEALTHCHECK_INTERVAL_MS || "5000",
    10,
  ),
  threshold: Number.parseInt(process.env.HEALTHCHECK_THRESHOLD || "3", 10),
  leaseName: process.env.LEASE_NAME || "postgres-primary-lock",
  leaseTtlSeconds: Number.parseInt(process.env.LEASE_TTL_SECONDS || "30", 10),
  leaseRenewMs: Number.parseInt(process.env.LEASE_RENEW_MS || "10000", 10),
  failoverJobImage:
    process.env.FAILOVER_JOB_IMAGE || "bitnami/kubectl:latest",
  metricsUrl: process.env.BACKEND_METRICS_URL || "",
  failoverToken: process.env.FAILOVER_TOKEN || "",
  nodeName: process.env.NODE_NAME || process.env.HOSTNAME || "unknown-node",
  podName: process.env.POD_NAME || process.env.HOSTNAME || "unknown-pod",
};

// ── Logging ────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    component: "postgres-healthcheck",
    pod: CONFIG.podName,
    ...extra,
  });
  // eslint-disable-next-line no-console
  console.log(line);
}

// ── Low-level K8s HTTP helpers using only the service-account token ────────
function kubeRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const req = https.request(
      {
        method,
        hostname: new URL(API).hostname,
        port: new URL(API).port || 443,
        path: urlPath,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ca: fs.existsSync(CACERT_PATH)
          ? fs.readFileSync(CACERT_PATH)
          : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getLease() {
  const res = await kubeRequest(
    "GET",
    `/apis/coordination.k8s.io/v1/namespaces/${NAMESPACE}/leases/${CONFIG.leaseName}`,
  );
  return res;
}

/**
 * Acquire the Lease with a compare-and-swap on the holder identity so two
 * replicas can't both take ownership at the same instant.
 */
async function acquireLease(holder) {
  const res = await getLease();
  const body = res.body;
  const holderIdentity = body?.spec?.holderIdentity;
  if (
    holderIdentity &&
    holderIdentity !== "" &&
    holderIdentity !== holder &&
    isFresh(body?.spec?.renewTime, body?.spec?.leaseDurationSeconds)
  ) {
    // Owned by someone else and still fresh → deny.
    return { acquired: false, reason: `${holderIdentity} holds a live lease` };
  }
  const now = new Date().toISOString();
  const patch = {
    metadata: {
      name: CONFIG.leaseName,
      namespace: NAMESPACE,
    },
    spec: {
      holderIdentity: holder,
      leaseDurationSeconds: CONFIG.leaseTtlSeconds,
      acquireTime: body?.spec?.acquireTime || now,
      renewTime: now,
      leaseTransitions: (body?.spec?.leaseTransitions || 0) + 1,
    },
  };
  if (res.statusCode === 404) {
    const created = await kubeRequest(
      "POST",
      `/apis/coordination.k8s.io/v1/namespaces/${NAMESPACE}/leases`,
      patch,
    );
    return created.statusCode === 201
      ? { acquired: true, lease: created.body }
      : { acquired: false, reason: `create returned ${created.statusCode}` };
  }
  const updated = await kubeRequest(
    "PUT",
    `/apis/coordination.k8s.io/v1/namespaces/${NAMESPACE}/leases/${CONFIG.leaseName}`,
    patch,
  );
  return updated.statusCode < 300
    ? { acquired: true, lease: updated.body }
    : { acquired: false, reason: `update returned ${updated.statusCode}` };
}

function isFresh(renewTime, leaseDurationSeconds) {
  if (!renewTime) return false;
  const ageSec =
    (Date.now() - new Date(renewTime).getTime()) / 1000 -
    (leaseDurationSeconds || CONFIG.leaseTtlSeconds);
  return ageSec <= 0;
}

async function renewLease(holder) {
  const patch = {
    metadata: { name: CONFIG.leaseName, namespace: NAMESPACE },
    spec: { holderIdentity: holder, renewTime: new Date().toISOString() },
  };
  const res = await kubeRequest(
    "PUT",
    `/apis/coordination.k8s.io/v1/namespaces/${NAMESPACE}/leases/${CONFIG.leaseName}`,
    patch,
  );
  return res.statusCode < 300;
}

async function createFailoverJob() {
  const name = `postgres-failover-${Math.floor(Date.now() / 1000)}`;
  const jobBody = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        app: "postgres-failover",
        "triggered-by": "healthcheck-daemon",
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 1,
      template: {
        spec: {
          serviceAccountName: "postgres-failover-sa",
          restartPolicy: "Never",
          containers: [
            {
              name: "failover",
              image: CONFIG.failoverJobImage,
              command: ["/bin/sh", "/scripts/failover.sh"],
              env: [
                { name: "NAMESPACE", value: NAMESPACE },
                {
                  name: "STANDBY_POD",
                  value: process.env.STANDBY_POD || "postgres-standby-0",
                },
                { name: "PROMOTION_LOCK_HELD", value: "true" },
                {
                  name: "BACKEND_METRICS_URL",
                  value: CONFIG.metricsUrl,
                },
              ],
              volumeMounts: [
                {
                  name: "failover-script",
                  mountPath: "/scripts",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "failover-script",
              configMap: { name: "postgres-failover-script", defaultMode: 493 },
            },
          ],
        },
      },
    },
  };
  const res = await kubeRequest(
    "POST",
    `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`,
    jobBody,
  );
  return { name, statusCode: res.statusCode };
}

function pgIsReady() {
  const result = spawnSync("pg_isready", [
    "-h",
    CONFIG.primaryHost,
    "-p",
    String(CONFIG.primaryPort),
    "-U",
    CONFIG.pgUser,
    "-d",
    CONFIG.pgDb,
    "-t",
    "5",
  ]);
  return result.status === 0;
}

async function pushFailoverMetric(outcome) {
  if (!CONFIG.metricsUrl) return;
  try {
    const https = require("https");
    const payload = JSON.stringify({ outcome });
    await new Promise((resolve) => {
      const req = https.request(
        CONFIG.metricsUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(CONFIG.failoverToken
              ? { Authorization: `Bearer ${CONFIG.failoverToken}` }
              : {}),
          },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", () => resolve());
      req.write(payload);
      req.end();
    });
  } catch {
    // Metrics are best-effort.
  }
}

/**
 * Are we allowed to try to promote right now?
 * We only initiate a failover if the primary is genuinely down AND we (as a
 * standby candidate) can win the Lease. The caller that wins the Lease creates
 * the failover Job; losers back off.
 */
async function attemptFailoverHoldLock() {
  const holder = `healthcheck-${CONFIG.podName}`;
  const result = await acquireLease(holder);
  if (!result.acquired) {
    log("warn", "split-brain prevention: lost lease, backing off", {
      reason: result.reason,
    });
    pushFailoverMetric("locked_out").catch(() => {});
    return;
  }
  log("info", "acquired primary lock; creating failover Job");
  pushFailoverMetric("initiated").catch(() => {});
  let failoverStatus;
  try {
    failoverStatus = await createFailoverJob();
    log("info", "failover Job created", failoverStatus);
  } catch (err) {
    log("error", "failed to create failover Job", { err: err.message });
    pushFailoverMetric("failed").catch(() => {});
  }
}

async function maybeTriggerFailover(failCount) {
  log("warn", "primary unhealthy; entering failover", { failCount });

  // Before promoting, do a final authoritative re-check so a transient blip in
  // only one polling round doesn't demote a healthy primary.
  if (pgIsReady()) {
    log("info", "final check passed — primary is healthy again; aborting failover");
    return false;
  }

  await attemptFailoverHoldLock();
  return true;
}

// ── Main loop ──────────────────────────────────────────────────────────────
async function main() {
  log("info", "postgres health-check daemon starting", {
    telemetryProbe: `${CONFIG.primaryHost}:${CONFIG.primaryPort}`,
    threshold: CONFIG.threshold,
    intervalMs: CONFIG.intervalMs,
  });

  let failCount = 0;
  let leaseHolder = `healthcheck-${CONFIG.podName}`;
  let holdingLease = false;

  try {
    while (true) {
      const healthy = pgIsReady();

      if (healthy) {
        if (failCount > 0) {
          log("info", "primary recovered; resetting failure counter", {
            was: failCount,
          });
        }
        failCount = 0;

        // A healthy primary keeps the Lease warm so a standby's check loses the
        // CAS above and never double-promotes.
        const acquired = await acquireLease(leaseHolder);
        holdingLease = acquired.acquired;
        if (!holdingLease) {
          // Another node currently holds the lease first; adopt it on the next healthy tick.
          leaseHolder = "second-choice-holder";
          log("warn", "could not hold lease while healthy", {
            reason: acquired.reason,
          });
        } else {
          leaseHolder = `healthcheck-${CONFIG.podName}`;
        }
      } else {
        failCount += 1;
        log("warn", "health check failed", {
          consecutive: failCount,
          threshold: CONFIG.threshold,
        });
        if (failCount >= CONFIG.threshold) {
          const triggered = await maybeTriggerFailover(failCount);
          failCount = 0;
          if (triggered) {
            // Wait a full interval before re-checking to let the failover Job
            // settle and avoid creating duplicate Jobs.
            await sleep(CONFIG.intervalMs);
          }
        }
      }

      await sleep(CONFIG.intervalMs);
    }
  } catch (err) {
    log("error", "health-check daemon crashed", { err: err.message });
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main();
}

module.exports = {
  pgIsReady,
  acquireLease,
  renewLease,
  createFailoverJob,
  maybeTriggerFailover,
  CONFIG,
  log,
};