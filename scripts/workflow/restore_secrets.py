#!/usr/bin/env python3
"""
scripts/workflow/restore_secrets.py

Roll a secret rotation back to the previous value (Workstream 3 of #1100).

Part of the rotation protocol's rollback guarantee: if a freshly-rotated
secret causes authentication failures (or a health check fails), operators
return to the previous value without a re-key. Because the consumers accept
current + previous + next simultaneously, restoring `PREVIOUS` as `CURRENT`
is safe — tokens/signatures that used the promoted value remain verifiable via
the `_NEXT` slot until it fully leaves double-write.

Behavior (compare with update_secrets.py promotion):
  • For each secret, set <name> back to the staged `current` (the value that
    was demoted to PREVIOUS), and keep the promoted value available as
    <name>_NEXT so it stays verifiable until retired.
  • On `--writer aws`, writes the restored set to AWS Secrets Manager.
  • On `--writer stdout`, prints the restored map.

Usage:
  python scripts/workflow/restore_secrets.py \
      --input /tmp/rotated.json \
      --writer aws \
      --secrets-manager-path stellar-indigopay/prod
"""

import argparse
import json
import sys


def restore(payload):
    secrets = payload.get("secrets", payload)
    restored = {}
    for name, entry in secrets.items():
        # current holds the OLD value (pre-rotation); restore it.
        restored[name] = entry["current"]
        # Keep the promoted value verifiable until it is purged.
        restored[f"{name}_NEXT"] = entry["next"]
    return restored


def write_aws(restored, path):
    import boto3  # deferred import

    client = boto3.client("secretsmanager")
    try:
        current = json.loads(client.get_secret_value(SecretId=path)["SecretString"])
    except Exception:
        current = {}
    merged = {**current, **restored}
    client.update_secret(SecretId=path, SecretString=json.dumps(merged, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True,
                        help="Path to the JSON payload from rotate_secrets.py")
    parser.add_argument("--writer", default="stdout", choices=["stdout", "aws"],
                        help="Where to apply the restored values")
    parser.add_argument("--secrets-manager-path", default="",
                        help="AWS Secrets Manager secret id (with --writer aws)")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    restored = restore(payload)
    if args.writer == "aws":
        if not args.secrets_manager_path:
            raise SystemExit("--secrets-manager-path is required with --writer aws")
        write_aws(restored, args.secrets_manager_path)
        print(f"[restore_secrets] Rolled back to previous values in {args.secrets_manager_path}")
    else:
        print(json.dumps(restored, indent=2))

    print("[restore_secrets] Promoted value retained as NEXT for verification")


if __name__ == "__main__":
    sys.exit(main())