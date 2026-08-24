# Synthetic Monitor Failure Runbook

**Alert:** `SyntheticDonationCheckFailing` / `SyntheticMonitorSilent`
**Severity:** page / warn
**Owner:** Platform team

---

## What is the synthetic monitor?

`scripts/synthetic-monitor.js` is an active health probe that executes a
complete end-to-end donation check every 5 minutes:

1. Verifies the synthetic donor account exists on Stellar Testnet (funds via Friendbot if needed)
2. Calls `GET /fee_stats` on Horizon to verify the Horizon endpoint is reachable
3. Calls `getLedgerEntries` on the Soroban RPC to verify the RPC endpoint is up
4. If `@stellar/stellar-sdk` is available, simulates a `donate()` transaction against the IndigoPay contract

Results are exposed as Prometheus metrics (`synthetic_donation_success`,
`synthetic_donation_duration_seconds`) and scraped by Prometheus every 60 s.

---

## SyntheticDonationCheckFailing

**Condition:** `synthetic_donation_success{job="synthetic-monitor"} == 0` for 10 consecutive minutes.

**This means:** The last several synthetic checks have failed. Real donors may already be affected.

### Step 1 — Check Stellar infrastructure status

- [Stellar Status Page](https://status.stellar.org) — look for Horizon or Soroban RPC incidents
- [Horizon Testnet Health](https://horizon-testnet.stellar.org/fee_stats) — should return 200
- [Soroban RPC Testnet](https://soroban-testnet.stellar.org) — try a `curl` or Postman POST

### Step 2 — Check the synthetic monitor itself

**GitHub Actions (scheduled workflow):**

```bash
# View recent runs
gh run list --workflow=synthetic-monitor.yml --repo Stellar-IndigoPay/Stellar-IndigoPay

# View failing run logs
gh run view <RUN_ID> --log
```

**Kubernetes CronJob:**

```bash
kubectl get cronjobs -n stellar-indigopay
kubectl get jobs -n stellar-indigopay -l app=synthetic-monitor
kubectl logs -n stellar-indigopay -l app=synthetic-monitor --tail=50
```

### Step 3 — Verify the contract is responsive

```bash
stellar contract invoke \
  --id CCG3QSD7FWTZ5W7NG2N7UDYWYVXF3I2NY5JGT3QPTZ6KHOIKUHMMJ6BT \
  --source deployer --network testnet \
  -- get_global_stats
```

If this fails, the Soroban RPC or contract itself is degraded.

### Step 4 — Check the synthetic donor account

```bash
# Replace with SYNTHETIC_DONOR_PUBLIC_KEY
curl "https://horizon-testnet.stellar.org/accounts/<PUBLIC_KEY>"
```

If the account doesn't exist or has zero XLM, refund it:

```bash
curl "https://friendbot.stellar.org?addr=<PUBLIC_KEY>"
```

### Step 5 — Manual synthetic check

```bash
cd /path/to/Stellar-IndigoPay
RUN_ONCE=true \
  SYNTHETIC_SECRET_KEY=<secret> \
  CONTRACT_ID=CCG3QSD7FWTZ5W7NG2N7UDYWYVXF3I2NY5JGT3QPTZ6KHOIKUHMMJ6BT \
  node scripts/synthetic-monitor.js
```

Exit 0 = check passed. Exit 1 = check failed (inspect stdout/stderr).

---

## SyntheticMonitorSilent

**Condition:** `absent(synthetic_donation_last_timestamp)` OR last timestamp > 15 minutes ago.

**This means:** The monitor itself has stopped emitting metrics. This is a monitor-of-the-monitor failure.

### Steps

1. Check the GitHub Actions scheduled workflow — it should run every 5 minutes.
   If it's not running, check if the workflow was disabled or the repo is out of quota.

2. Check the Prometheus Push Gateway target (if configured):
   `curl $PROMETHEUS_PUSH_URL/metrics/job/synthetic-monitor`

3. Check the Kubernetes CronJob:
   ```bash
   kubectl get cronjobs -n stellar-indigopay synthetic-monitor
   kubectl describe cronjob synthetic-monitor -n stellar-indigopay
   ```

4. Check Prometheus scrape targets: open `http://prometheus:9090/targets?job=synthetic-monitor`
   and verify the target is UP.

5. If the Docker Compose monitoring stack is in use:
   ```bash
   docker compose -f monitoring/docker-compose.monitoring.yml logs synthetic-monitor
   ```

---

## SyntheticDonationCheckSlow

**Condition:** p99 duration > 30 s for 15 consecutive minutes.

**This means:** Checks are completing (not failing) but taking a very long time — indicative of
Horizon/RPC degradation under load, not a full outage.

### Steps

1. Check `synthetic_donation_duration_seconds` histogram in the Business Overview dashboard.
2. Compare against Horizon and Soroban RPC p99 latency trends.
3. Check for scheduled Stellar network maintenance at https://status.stellar.org.
4. If p99 approaches the 60s scrape interval, consider increasing `SYNTHETIC_AMOUNT_STROOPS`
   timeout or filing a Stellar infrastructure issue.

---

## Escalation

If Stellar Testnet infrastructure is confirmed degraded and beyond our control:
1. Silence the alert for 2 hours via Alertmanager or `amtool silence add`.
2. Open a [Stellar Discord](https://discord.gg/stellardev) or [GitHub issue](https://github.com/stellar/stellar-core/issues) if the degradation persists > 1 hour.

For production (Mainnet) failures, escalate immediately to the platform team on-call via PagerDuty.
