"use strict";

/**
 * src/services/signingSecretProvider.js
 *
 * Multi-version secret key store (Workstream 3 of #1100).
 *
 * Secret rotation with zero-downtime requires that a consuming service can
 * accept a secret that is being rotated during the transition window. This
 * provider models each secret as a small set of versions with an explicit
 * *current* key plus optional `previous` and `next` versions (the dual-version
 * rotation protocol described in #1100):
 *
 *   Step 1 — rotate:  the NEW value is deployed as `NEXT`; consumers accept it
 *                     for signing *and* verification while the OLD value stays
 *                     current, so signatures/credentials never become invalid.
 *   Step 2 — promote: `NEXT` becomes `CURRENT`; the old `CURRENT` is demoted to
 *                     `PREVIOUS` (still accepted for verification, no longer
 *                     issued).
 *   Step 3 — purge:   after the grace period `PREVIOUS` is removed.
 *
 * Version keys are derived from env vars of the shape:
 *
 *   JWT_SECRET                    → current
 *   JWT_SECRET_PREVIOUS           → previous (accepted, not issued)
 *   JWT_SECRET_NEXT               → next     (accepted and issued after promote)
 *
 * The provider never stores plaintext anywhere except the process environment
 * (which already holds the current secrets). It exposes:
 *
 *   - currentKey(name)              → the one version currently used for *issuing*
 *   - keysForAcceptance(name)       → every version valid for *verification*
 *   - describe(name)                → { current, next, previous } key ids (kidding)
 *   - registeredSecretNames()       → the canonical secret names this provider knows
 *   - getRenderedStatus()           → last-rotation metadata for /api/admin/secrets/status
 *
 * Each version is identified by a short `kid` derived from the SHA-256 of its
 * value so JWTs and webhook signatures can carry which key signed them, letting
 * a verifier pick the right version deterministically.
 */

const crypto = require("crypto");

const SECRET_NAMES = [
  "JWT_SECRET",
  "WEBHOOK_SIGNING_SECRET",
  "ADMIN_API_KEY",
  "RECURRING_SIGNER_SECRET",
];

/** A short stable identifier for a secret value ('kid'). */
function keyIdFor(secretValue) {
  if (!secretValue) return null;
  return crypto.createHash("sha256").update(secretValue).digest("hex").slice(0, 16);
}

/** True if we have a real value (not empty/missing) for the current key. */
function hasCurrent(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function envOrNull(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Return the current (issue-only) key for a named secret.
 *
 * @param {string} name - One of registeredSecretNames().
 * @returns {string} The current key value for issuing.
 * @throws {Error} If the secret has no configured current value.
 */
function currentKey(name) {
  if (!hasCurrent(name)) {
    throw new Error(
      `signingSecretProvider: no current value configured for "${name}". ` +
        `Set ${name} in the environment (e.g. the stellar-indigopay-secrets Secret).`,
    );
  }
  return process.env[name];
}

/**
 * Return every version acceptable for verification, current first.
 *
 * Signatures/tokens created with the previous or next key will still verify
 * during the rotation window (this is the core of zero-downtime rotation).
 *
 * @param {string} name - One of registeredSecretNames().
 * @returns {Array<{key: string, kid: string|null, version: string}>}
 */
function keysForAcceptance(name) {
  const keys = [];
  if (hasCurrent(name)) {
    keys.push({ key: currentKey(name), kid: keyIdFor(currentKey(name)), version: "current" });
  }
  const previous = envOrNull(`${name}_PREVIOUS`);
  if (previous) {
    keys.push({ key: previous, kid: keyIdFor(previous), version: "previous" });
  }
  const next = envOrNull(`${name}_NEXT`);
  if (next) {
    keys.push({ key: next, kid: keyIdFor(next), version: "next" });
  }
  return keys;
}

/**
 * Describe a secret's current rotation state (no values, only fingerprints).
 *
 * @param {string} name - One of registeredSecretNames().
 * @returns {{ name: string, current: string|null, previous: string|null, next: string|null }}
 */
function describe(name) {
  return {
    name,
    current: hasCurrent(name) ? keyIdFor(currentKey(name)) : null,
    previous: keyIdFor(envOrNull(`${name}_PREVIOUS`)),
    next: keyIdFor(envOrNull(`${name}_NEXT`)),
  };
}

/** Load rendered status for all known secrets (for the admin status endpoint). */
function getRenderedStatus() {
  return registeredSecretNames()
    .map(describe)
    .map((entry) => ({
      name: entry.name,
      currentKid: entry.current,
      previousKid: entry.previous,
      nextKid: entry.next,
    }));
}

/**
 * Return the canonical list of secret names this provider manages.
 *
 * @returns {string[]}
 */
function registeredSecretNames() {
  // Filter to only the secrets relevant to this process's runtime so tests and
  // dev environments don't report "unset" entries for optional secrets.
  return SECRET_NAMES.filter((name) => hasCurrent(name) || envOrNull(`${name}_NEXT`) || envOrNull(`${name}_PREVIOUS`));
}

module.exports = {
  currentKey,
  keysForAcceptance,
  describe,
  getRenderedStatus,
  registeredSecretNames,
  keyIdFor,
};