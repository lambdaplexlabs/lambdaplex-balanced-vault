# Lambdaplex Balanced Vault

Solidity smart contracts for the Lambdaplex “pair vault” system on Hedera EVM:
- **`PLEXPairVault`** — single BASE/QUOTE vault with share-based accounting, inventory-aware deposits/withdrawals, streaming airdrop rewards, management fee accrual via share-minting, and emergency mode.
- **`AirdropDistributor`** — custody + accounting for reward tokens, and pays user claims on behalf of vaults.
- **`SupraRegistry`** (adapter) — wraps a Supra feed contract to provide `getPair()` + `verifyOracleProofV2()` using Hedera/HIP conventions.
- **Mocks** — `MockSupraPriceFeed`, `ERC20Mock`, etc. for unit tests.

> ⚠️ This repo is intended for audit and production deployment review. Always run the full test suite and review the security assumptions below before deploying.

---

## High-level architecture

### 1) PLEXPairVault (single pair vault)
A vault holds two assets:
- **BASE**: HTS or native HBAR (`address(0)`)
- **QUOTE**: HTS or native HBAR (`address(0)`)

Users deposit assets and receive **shares**. Shares represent a pro-rata claim on the vault’s inventory **by QUOTE-value**, based on an oracle price.

Core features:
- **Share accounting**
  - `totalShares` tracks total shares outstanding.
  - `userShares[user]` tracks per-user total shares.
  - Deposits are tracked as “lots” (`Deposit`) to support partial withdrawals and lockup behavior.
- **Deposit policy**
  - When vault is **balanced** (within tolerance), deposits are accepted **50/50 by value**.
  - When vault is **imbalanced**, deposits first accept only the **underweight** token until closer to balanced, then accept additional liquidity 50/50 by value.
- **Withdrawal policy**
  - Withdrawals pay the **overweight** side first (by value), then pay any remaining owed value 50/50 by value.
- **Management fee**
  - Continuous management fee is implemented by **minting fee-shares** to `ownerFeeShares` over time.
  - Fee changes are **scheduled** with a **1 week delay** and rate-change cooldown.
- **Streaming rewards (airdrops)**
  - Rewards are streamed linearly over `VESTING_SECS` (7 days).
  - Rewards accrue to **eligible shares only**: `eligibleShares = totalShares - ownerFeeShares`.
  - Users claim rewards through the vault, which instructs the distributor to transfer tokens.
- **Emergency mode**
  - Emergency mode disables deposits and allows **oracle-free pro-rata withdrawals**.
  - Intended for oracle failure / emergency operations.

---

## Oracle (Supra) integration

`PLEXPairVault` uses a pinned oracle registry address:
- `supra = ISupraRegistry(0x00000000000000000000000000000000000003f7)` (for local testing)

The vault expects `supra.verifyOracleProofV2(args)` to return a single price pair, and `supra.getPair(pairId)` to return token identities + decimals. The vault also performs:
- pair identity checks (BASE/QUOTE matches)
- staleness checks (`STALE_PRICE`)
- decimal normalization: Supra returns “whole token for whole token”, so token decimals are accounted for in `_getPriceAndScale()`.

---

## AirdropDistributor

The distributor:
- holds reward tokens
- tracks how much is **credited** to a vault and how much is **claimed**
- only allows funding with tokens explicitly enabled by `isTokenAllowed[token]`

Important behaviors:
- `fund(vault, token, amount)` transfers tokens into the distributor and credits the vault
- then calls back: `vault.onAirdropFunded(token, netAmount)` (nonReentrant)
- `claimTo(token, to, amount)` can be called only by the vault (after your changes), and pays out from the credited balance

---

## Install / Build / Test

### Prerequisites
- Node.js (LTS recommended)
- Yarn or npm
- Hardhat

### Install dependencies
```bash
yarn install
# or
npm install
```

## Testing

1. In testing terminal, run `npx hardhat test <pathToFile>`

## Licensing

The primary license for Lambdaplex Balanced Vault is the MIT License (`MIT`).
