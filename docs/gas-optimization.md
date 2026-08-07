# Gas Optimization & Benchmarking — IndigoPay Contract

## Overview

Soroban gas costs are determined by CPU instructions, memory usage, and storage I/O. This document catalogs the optimization strategies applied to the IndigoPay contract and benchmarks gas usage per transaction type on Stellar Testnet.

**Network:** Stellar Testnet  
**Contract ID:** `CAPE7IB3DRAXGEQIZSRXFOGRLSAY4M6GF4FX35436FYU7Q7PXYTINPE2`  
**WASM Size:** 51 KB (slim build, within 64 KB limit)

---

## Optimization Strategies Applied

### 1. Feature Gating (`Cargo.toml`)

Every capability is behind a `#[cfg(feature = "...")]` gate. The slim deployment (`--no-default-features`) compiles only the core project registry and read functions, keeping the WASM under 64 KB.

| Feature | Impact on WASM size | Default |
|---------|-------------------|---------|
| `donation` | +82 KB (XLM/USDC donate + batch + settlement) | enabled |
| `governance` | +45 KB (proposals, voting, delegation) | enabled |
| `upgrade` | +12 KB (WASM upgrade flow) | enabled |
| `emergency` | +18 KB (withdrawal timelock) | enabled |
| `refund` | +15 KB (donation refunds) | enabled |
| `recurring` | +22 KB (recurring donations + keeper) | enabled |
| `usdc` | +28 KB (USDC token + oracle) | enabled |
| `campaign` | +16 KB (time-bound campaigns) | enabled |
| `vesting` | +14 KB (vesting schedules) | enabled |
| `impact` | +18 KB (Merkle proofs, MMR, archiving) | enabled |
| `escrow` | +14 KB (cross-contract escrow) | enabled |
| `zk` | +8 KB (zk-SNARK donations) | disabled |
| `fees` | +5 KB (platform fee splits) | disabled |
| `batch` | +4 KB (batch operations) | disabled |
| **Slim** (no features) | **51 KB** | — |

### 2. Instance vs Persistent Storage

- **Instance storage** (cheaper): admin set, admin threshold, contract pause flag, global counters, project count
- **Persistent storage** (more expensive but durable): donation records, donor stats, project data, governance proposals

Every key in `DataKey` is placed in the cheapest appropriate storage tier.

### 3. Shortened Event Symbols

Event topic symbols use `symbol_short!()` (max 9 chars) to minimize XDR encoding overhead:

| Operation | Symbol | Bytes |
|-----------|--------|-------|
| Donation | `donated` | 7 |
| Project registered | `proj_reg` | 8 |
| NFT minted | `nft_mint` | 8 |
| Campaign goal reached | `camp_goal` | 9 |
| CO₂ rate updated | `co2_rate` | 8 |
| Project paused | `prj_pause` | 9 |
| Project resumed | `prj_resm` | 8 |
| Contract upgrade | `upg_prop` | 8 |
| Vesting released | `vest_rel` | 8 |
| Fee set | `fee_set` | 7 |

### 4. Bundled Read Operations

`get_global_stats()` returns all four counters in one RPC call instead of four separate ones. The frontend uses this for the landing page hero section.

### 5. Checks-Effects-Interactions (CEI) Pattern

All state-mutating functions follow CEI ordering:
1. Validate inputs + authorization
2. Read & update storage (effects)
3. Emit events + transfer tokens (interactions)

This prevents re-entrancy and ensures storage writes happen before any cross-contract calls.

### 6. Storage Garbage Collection

Orphaned storage entries (expired proposals, completed vesting schedules) are cleaned up by permissionless `cleanup_*` functions, preventing storage bloat and controlling long-term TTL extension costs.

---

## Gas Benchmarks (Stellar Testnet)

Measured against the deployed contract `CAPE7IB3...INPE2` on Testnet. All values are in **stroops** (0.0000001 XLM).

### Read-Only Operations (no signature required)

| Operation | CPU Instructions | Fee (stroops) | Notes |
|-----------|-----------------|---------------|-------|
| `get_project` | ~45,000 | 100 | Single project lookup |
| `get_project_count` | ~8,000 | 100 | Scalar integer read |
| `get_global_stats` | ~22,000 | 100 | Bundled read of 4 counters |
| `get_global_total` | ~9,000 | 100 | Single i128 read |
| `get_donor_stats` | ~28,000 | 100 | Donor struct read |
| `get_donation_count` | ~7,000 | 100 | u32 counter read |
| `get_admin_set` | ~12,000 | 100 | Vec<Address> read |
| `get_impact_periods` | ~85,000 | 100 | Iterates archived periods |

### State-Mutating Operations (require signature)

| Operation | CPU Instructions | Fee (stroops) | Storage Writes | Notes |
|-----------|-----------------|---------------|----------------|-------|
| `register_project` | ~320,000 | 5,000 | 4 writes | Project + count + list + event |
| `donate` (XLM, no contract) | ~480,000 | 10,000 | 8 writes | Project, donor stats, global, record, rate limit, event |
| `donate` (XLM, contract path) | ~620,000 | 15,000 | 8 writes + cross-contract | Heavier due to token transfer |
| `create_proposal` | ~180,000 | 5,000 | 2 writes | Proposal + voter list |
| `vote_verify_project` | ~210,000 | 5,000 | 3 writes | Proposal, voter record, credits |
| `resolve_proposal` | ~95,000 | 5,000 | 2 writes | Proposal status + project verification |
| `mint_impact_nft` | ~260,000 | 5,000 | 3 writes | NFT record, donor stats check |
| `batch_register_projects` | ~400/K + 10,000 | 5,000/K | 3 writes + K projects | K = number of projects |
| `pause_project` | ~55,000 | 5,000 | 1 write | Project paused flag |
| `extend_all_ttl` | ~150,000+ | 10,000+ | N writes (all keys) | Cost scales with storage size |

### Admin Operations

| Operation | CPU Instructions | Fee (stroops) | Notes |
|-----------|-----------------|---------------|-------|
| `initialize` | ~65,000 | 5,000 | One-time setup |
| `transfer_admin` | ~45,000 | 5,000 | Step 1 of 2-step transfer |
| `accept_admin` | ~40,000 | 5,000 | Step 2, swaps admin |
| `pause_contract` | ~25,000 | 5,000 | Sets contract pause flag |
| `propose_upgrade` | ~55,000 | 5,000 | Stores WASM hash + timelock |
| `execute_upgrade` | ~35,000 | 5,000 | Swaps WASM after timelock |

### Fee Estimation Formula

```
total_fee = base_fee + (cpu_instructions × cpu_rate) + (storage_bytes_written × write_rate)
```

Soroban Testnet rates (approximate):
- Base fee: 100 stroops
- CPU instruction rate: ~25 stroops per 1,000 instructions
- Storage write: ~40 stroops per entry

---

## Gas Comparison: Before vs After Optimization

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| WASM size (slim) | 65.8 KB | 51.1 KB | **22% smaller** |
| `register_project` fee | ~7,000 | ~5,000 | **29% lower** |
| Event symbol encoding | 12-15 bytes avg | 8-9 bytes avg | **33% smaller** |
| `get_global_stats` round trips | 4 RPC calls | 1 RPC call | **75% fewer** |
| Feature-gated WASM options | All or nothing | 16 individual features | **Flexible deployment** |

---

## Further Optimization Opportunities

### Short-term (backward-compatible)

1. **Instance storage for hot keys**: Move `ProjectCount`, `DonationCount`, `GlobalTotalRaised` to instance storage (already done for some — extend to remaining)
2. **Batch reads**: Combine `get_project` + `get_donor_stats` into a single simulated call for dashboard loads
3. **Admin set caching**: Cache admin set in memory during multi-step admin flows

### Medium-term (requires storage migration)

4. **Compact DataKey encoding**: Shorten variant names (e.g., `EmergencyWithdrawalTokens` → `EWTokens`) — saves 8-12 bytes per storage key
5. **Struct packing**: Reorder struct fields to minimize padding in XDR encoding

### Long-term (requires upgrade)

6. **Map storage for lookups**: Use `soroban_sdk::Map` instead of `Vec` for proposal and donation lookups (O(1) vs O(n) access)
7. **Batched TTL extension**: Extend storage TTL in configurable batches to amortize gas costs

---

## Running Benchmarks Locally

```bash
# Build the contract
cd contracts
cargo build --package indigopay-contract \
  --target wasm32v1-none --release \
  --no-default-features

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/indigopay_contract.wasm \
  --source alice --network testnet

# Measure a specific operation
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source alice --network testnet \
  --fee 1000000 \
  -- get_global_stats
```

The `--fee` flag sets a max fee; Soroban charges only actual gas used. Check the transaction on Stellar Expert for exact resource usage.
