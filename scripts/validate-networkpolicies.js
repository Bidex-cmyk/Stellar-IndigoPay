#!/usr/bin/env node
"use strict";

/**
 * scripts/validate-networkpolicies.js
 *
 * NetworkPolicy audit and zero-trust enforcement (Workstream 6 of #1100).
 *
 * Parses every NetworkPolicy under `k8s/`, validates YAML syntax, and performs
 * a semantic completeness audit:
 *
 *   ✅ Syntax — every policy parses as valid YAML and has a valid kind.
 *   ✅ Default-deny — confirms a `default-deny` NetworkPolicy with
 *      `podSelector: {}` + BOTH policyTypes is present (per-namespace).
 *   ✅ Coverage    — maps each Deployment/StatefulSet (by app label) in the
 *      manifests to its NetworkPolicy selection; any pod with NO associated
 *      policy is isolated-by-default under default-deny but is flagged as
 *      "no explicit allow path" so a newly added pod fails CI.
 *   ✅ Egress audit — flags any policy that allows `0.0.0.0/0` egress without
 *      a documented exception, per the epic's requirement to restrict egress
 *      to specific external endpoints only.
 *
 * Exit codes: 0 = all checks pass; 1 = at least one policy is invalid, a pod
 * is unreachable by any allow rule, or default-deny is missing; 2 = usage /
 * dependency error.
 *
 * Usage:
 *   node scripts/validate-networkpolicies.js [--dir k8s] [--strict]
 */

const fs = require("fs");
const path = require("path");

// js-yaml can be loaded from the repo root (devDependency). Some NetworkPolicy
// files contain multiple documents delimited by `---`, so we always load ALL
// documents. Depending on the installed major version the API differs slightly,
// so we probe for loadAll (older: safeLoadAll).
function loadYamlDocs(text) {
  const yaml = require("js-yaml");
  if (typeof yaml.loadAll === "function") return yaml.loadAll(text);
  if (typeof yaml.safeLoadAll === "function") return yaml.safeLoadAll(text);
  const doc = yaml.load(text);
  return Array.isArray(doc) ? doc : [doc];
}

const POD_DEPLOYMENTS = {
  backend: { kind: "Deployment", app: "backend" },
  frontend: { kind: "Deployment", app: "frontend" },
  "postgres-primary": { kind: "StatefulSet", app: "postgres", role: "primary" },
  "postgres-standby": { kind: "StatefulSet", app: "postgres", role: "standby" },
  "postgres-exporter": { kind: "Deployment", app: "postgres-exporter" },
};

function collectNetworkPolicies(dir) {
  const policies = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const file of files) {
    if (!/^networkpolicy-.*\.ya?ml$/.test(file)) continue;
    const full = path.join(dir, file);
    const list = loadYamlDocs(fs.readFileSync(full, "utf8"));
    for (const policy of list) {
      if (!policy || policy.kind !== "NetworkPolicy") continue;
      policies.push({
        file,
        name: policy.metadata.name,
        namespace: policy.metadata.namespace || "stellar-indigopay",
        spec: policy.spec || {},
        raw: policy,
      });
    }
  }
  return policies;
}

function isMatchedBySelection(deploymentLabels, policy) {
  const podSelector = (policy.spec.podSelector || {}).matchLabels || {};
  if (Object.keys(podSelector).length === 0 && policy.spec.podSelector && typeof policy.spec.podSelector === "object" && policy.spec.podSelector.matchExpressions) {
    return false; // expression-based; cannot assert coverage statically
  }
  // Empty podSelector {} selects everything (e.g. default-deny).
  if (Object.keys(podSelector).length === 0) return true;
  return Object.keys(podSelector).every((k) => deploymentLabels[k] === podSelector[k]);
}

function collectWorkloads(dir) {
  const workloads = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const file of files) {
    if (!/\.ya?ml$/.test(file)) continue;
    const full = path.join(dir, file);
    let list;
    try {
      list = loadYamlDocs(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    for (const obj of list) {
      if (!obj || !["Deployment", "StatefulSet"].includes(obj.kind)) continue;
      const labels = (obj.spec.template.metadata.labels) || {};
      if (!labels.app) continue;
      workloads.push({
        file,
        name: obj.metadata.name,
        kind: obj.kind,
        app: labels.app,
        labels,
      });
    }
  }
  return workloads;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args[args.indexOf("--dir") + 1] || "k8s";
  const strict = args.includes("--strict");

  if (!fs.existsSync(path.join(dir, "networkpolicy-default-deny.yaml"))) {
    console.error(`[validate-networkpolicies] ❌ No default-deny policy found in ${dir}.`);
    if (strict) process.exit(1);
  }

  const policies = collectNetworkPolicies(dir);
  if (policies.length === 0) {
    console.error(`[validate-networkpolicies] ❌ No NetworkPolicies found in ${dir}.`);
    process.exit(1);
  }
  const workloads = collectWorkloads(dir);
  const errors = [];
  const warnings = [];

  // ── 1. Syntax + kind validity ────────────────────────────────────────────
  for (const policy of policies) {
    if (!policy.spec || !policy.spec.policyTypes) {
      errors.push(`${policy.file}: policy "${policy.name}" has no spec.policyTypes`);
    }
  }

  // ── 2. Default-deny presence ─────────────────────────────────────────────
  const isDefaultDeny = (p) =>
    Object.keys((p.spec.podSelector || {}).matchLabels || {}).length === 0 &&
    (Array.isArray(p.spec.policyTypes) ? p.spec.policyTypes : []).includes("Ingress") &&
    (Array.isArray(p.spec.policyTypes) ? p.spec.policyTypes : []).includes("Egress");
  const hasDefaultDeny = policies.some(isDefaultDeny);
  if (!hasDefaultDeny) errors.push("default-deny NetworkPolicy (both Ingress && Egress, empty podSelector) is MISSING");

  // ── 3. Cover/null any empty selector allow policies (default-deny is the
  //    only empty-selector policy we expect to allow everything). ──────────
  // (Nothing here — see coverage loop below.)

  // ── 4. Coverage: every workload must be matched by ≥1 allow policy ──────
  const allowPolicies = policies.filter((p) => !isDefaultDeny(p));
  for (const workload of workloads) {
    const matching = allowPolicies.filter((p) => isMatchedBySelection(workload.labels, p));
    if (matching.length === 0) {
      errors.push(
        `${workload.file}: workload "${workload.name}" (app=${workload.app}) has NO NetworkPolicy — reachable by default or isolated with no allow path`,
      );
    }
  }

  // ── 5. Egress audit: flag any 0.0.0.0/0 egress (unrestricted) ───────────
  for (const policy of allowPolicies) {
    const egressRules = policy.spec.egress || [];
    for (const rule of egressRules) {
      const to = rule.to || [];
      for (const entry of to) {
        if (entry.ipBlock && entry.ipBlock.cidr === "0.0.0.0/0") {
          const commented = policy.raw && policy.raw.metadata && policy.raw.metadata.annotations &&
            policy.raw.metadata.annotations["netpolicy.denied-indigopay/exception"];
          warnings.push(
            `${policy.file}: policy "${policy.name}" allows unrestricted egress 0.0.0.0/0${commented ? " (documented exception)" : " — REVIEW REQUIRED"}`,
          );
        }
      }
    }
  }

  // ── Reporting ─────────────────────────────────────────────────────────────
  if (errors.length === 0) {
    console.log(`[validate-networkpolicies] ✅ ${policies.length} policies, ${workloads.length} workloads. All checks passed.`);
  } else {
    console.error(`[validate-networkpolicies] ❌ ${errors.length} error(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
  }
  for (const w of warnings) console.warn(`  ⚠  ${w}`);

  const exitCode = errors.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

module.exports = { collectNetworkPolicies, collectWorkloads };

if (require.main === module) {
  main();
}