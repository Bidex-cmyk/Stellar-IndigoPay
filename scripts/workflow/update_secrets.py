#!/usr/bin/env python3
"""
scripts/workflow/update_secrets.py

Apply a dual-version-rotated payload (Workstream 3 of #1100).

Consumes the JSON produced by `rotate_secrets.py` (or a hand-authored payload
of the same shape) and:

  • Writes the promoted set to the secrets manager (`--writer aws`) or prints a
    Kubernetes Secret-patch style JSON (`--writer stdout`, for `kubectl patch`).
  • Emits BOTH the new `CURRENT`/`NEXT` values and the retained `PREVIOUS`
    value so the consuming service keeps verifying the old key during the
    rotation window.

This script performs **Step 2 (promote NEXT → CURRENT)** of the rotation
protocol. The old current is demoted to PREVIOUS and remains valid for
verification; `restore_secrets.py` can roll a promotion back.

The `--audit-out` file records only SHA-256 hashes of the rotated values (never
the plaintext) plus a timestamp, ready to be appended to a `secret_rotations`
tax record — the rotation audit trail.

Usage:
  # Promote a staged payload to CURRENT (and demote old current to PREVIOUS).
  python scripts/workflow/update_secrets.py \
      --input /tmp/rotated.json \
      --writer aws \
      --secrets-manager-path stellar-indigopay/prod \
      --audit-out /tmp/audit.json

  # Render only (no manager write) for a review step.
  python scripts/workflow/update_secrets.py \
      --input /tmp/rotated.json --writer stdout
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def promote(payload):
    """
    Translate a staged payload into the promoted map:

      For each secret, publish:
        <name>            -> NEXT (now the current issuing key)
        <name>_PREVIOUS   -> current (still verified, no longer issued)
        <name>_NEXT       -> (cleared when the promotion is confirmed)
    """
    secrets = payload.get("secrets", payload)
    promoted = {}
    cleared_next = []
    for name, entry in secrets.items():
        promoted[name] = entry["next"]
        promoted[f"{name}_PREVIOUS"] = entry["current"]
        # NEXT is promoted to CURRENT, so the NEXT slot is vacated.
        promoted[f"{name}_NEXT"] = ""
        cleared_next.append(name)
    return promoted


def build_audit(payload):
    secrets = payload.get("secrets", payload)
    records = []
    now = datetime.now(timezone.utc).isoformat()
    for name, entry in secrets.items():
        records.append({
            "secret_name": name,
            "rotated_at": now,
            "rotated_by": "workflow:update_secrets",
            "version": "current",
            "sha256_of_new_value": entry.get("next_hash") or sha256_hex(entry["next"]),
            "sha256_of_previous_value": entry.get("current_hash") or sha256_hex(entry["current"]),
        })
    return records


def write_aws(promoted, path):
    import boto3  # deferred import

    client = boto3.client("secretsmanager")
    try:
        current = json.loads(client.get_secret_value(SecretId=path)["SecretString"])
    except Exception:
        current = {}
    # Merge: promoted keys win; preserve any unrelated keys already in the store.
    merged = {**current, **promoted}
    # Drop vacated NEXT slots so consumers don't treat an empty string as a key.
    for k in list(merged.keys()):
        if k.endswith("_NEXT") and not merged[k]:
            del merged[k]
    client.update_secret(SecretId=path, SecretString=json.dumps(merged, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True,
                        help="Path to the JSON payload from rotate_secrets.py")
    parser.add_argument("--writer", default="stdout", choices=["stdout", "aws"],
                        help="Where to apply the promoted values")
    parser.add_argument("--secrets-manager-path", default="",
                        help="AWS Secrets Manager secret id (with --writer aws)")
    parser.add_argument("--audit-out", default="",
                        help="Write the rotation audit records to this JSON file")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    promoted = promote(payload)
    if args.writer == "aws":
        if not args.secrets_manager_path:
            raise SystemExit("--secrets-manager-path is required with --writer aws")
        write_aws(promoted, args.secrets_manager_path)
        print(f"[update_secrets] Applied promotion to {args.secrets_manager_path}")
    else:
        # Safety: never echo empty NEXT vacate keys to stdout for clarity.
        printable = {k: v for k, v in promoted.items() if not k.endswith("_NEXT")}
        print(json.dumps(printable, indent=2))

    if args.audit_out:
        with open(args.audit_out, "w", encoding="utf-8") as fh:
            json.dump(build_audit(payload), fh, indent=2)
        print(f"[update_secrets] Wrote {args.audit_out}")

    # Surface the NEXT-slot vacation so the caller knows rotation finished.
    print("[update_secrets] NEXT slots vacated; previous retained for verification")


if __name__ == "__main__":
    sys.exit(main())