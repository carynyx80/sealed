# Offchain ledger API (owner: ledger-engine-agent)

Double-entry ledger in BigInt atoms. Every value movement is ONE balanced transaction
(Σ entries per asset = 0), idempotent on `idempotencyKey` (unique), executed in a serializable DB
transaction with `SELECT … FOR UPDATE` row locks on every touched account (Postgres) or under a global
mutex with copy-on-write rollback (memory). Non-system accounts can never go negative.

```ts
import { getLedger, credit, debitForWithdrawal, lock, unlock, settleWithdrawal, balances, liabilities, LedgerError } from "../ledger.js";
// or: ctx.offchain?.ledger (same instance). getLedger() throws until the runtime is built (buildServer).
```

## Assets
`AssetId` from `@sealed/shared`: quote symbols (`"SOL" | "USDC" | "NVDAx" …`, decimals from `QUOTE_ASSETS`)
and launched tokens `tok:<launchId>` (6 decimals). Helpers: `assetDecimals(asset)`, `toAtoms(ui, decimals)`,
`fromAtoms(atoms, decimals)`.

## Accounts (owner, asset, kind)
| owner | kind | meaning |
|---|---|---|
| `system` | `company_custody` | asset side of real holdings in the company wallet. **Negative** balance = assets held. Only account (with `token_issuance`) allowed to go negative. |
| `system` | `token_issuance:<launch>` | mint for `tok:<launch>` (negative = supply issued) |
| wallet | `user_available` | spendable balance |
| wallet | `user_locked` | reserved for pending withdrawals (custody) |
| wallet | `bid_escrow:<launch>` | quote locked in an open sealed bid |
| wallet | `staked:<launch>` | staked launch tokens |
| `system` | `auction_escrow:<launch>`, `auction_tokens:<launch>`, `pool_quote:<launch>`, `pool_token:<launch>`, `buyback_vault:<launch>`, `fee_collector:<launch>`, `rewards:<launch>` | per-launch engine accounts |
| `system` | `credit_pool`, `treasury`, `platform_ops`, `burned` | per asset |

## Functions (all amounts `bigint` atoms; all return `Promise<PostResult>` = `{ txId, replayed }` unless noted)
- `credit(wallet, asset, atoms, idempotencyKey, meta?)` — deposit: `company_custody → user_available`. Use the deposit key (`dep:<signature>:<ix>`) as the idempotency key so a deposit is credited exactly once.
- `debitForWithdrawal(wallet, asset, atoms, idempotencyKey, meta?)` — reserve on request: `user_available → user_locked`. Throws `LedgerError("INSUFFICIENT_FUNDS")`.
- `lock(...)` — same movement as `debitForWithdrawal` (generic hold).
- `unlock(wallet, asset, atoms, key, meta?)` — `user_locked → user_available` (rejected/failed withdrawal).
- `settleWithdrawal(wallet, asset, atoms, key, meta?)` — payout broadcast & confirmed: `user_locked → company_custody` (assets leave custody).
- `creditSystem(kind, asset, atoms, key, meta?)` — admin seeding of a system account, e.g. `creditSystem("credit_pool", "USDC", …)`: `company_custody → system:<kind>` (only after real funds were deposited to the company wallet).
- `balances(wallet): Promise<WalletBalance[]>` — `{ asset, available, locked, staked }` bigint; `locked = user_locked + Σ bid_escrow:*`.
- `liabilities(asset): Promise<bigint>` — everything the company owes for that asset (users + system pools) = `−balance(company_custody)`. Proof-of-reserves: compare with on-chain balance of the company wallet.
- `balanceOf(owner, asset, kind): Promise<bigint>`
- `verify(): Promise<InvariantReport>` — `{ ok, unbalancedTxs, balanceMismatches, negativeBalances }`.
- `getLedger().post({ idempotencyKey, kind, launchId?, meta?, legs })` — generic multi-leg transaction (engine use).

Replaying an existing idempotency key with the same legs returns `{ replayed: true }` and moves nothing;
with different legs it throws `LedgerError("IDEMPOTENCY_CONFLICT")`.

Errors: `LedgerError` with `.code` ∈ `INSUFFICIENT_FUNDS | UNBALANCED | IDEMPOTENCY_CONFLICT | INVALID` and
`.statusCode` (409/400) so Fastify returns a clean error.

## Engine helpers for account routes
`ctx.offchain.engine.accountBalances(wallet): Promise<BalanceRow[]>` (UI units, symbols/tickers resolved) and
`ctx.offchain.engine.sniperFlags(wallet): Promise<string[]>`.

## Auth
Trade routes use `requireAuth` from `auth/requireAuth.ts` (custody-agent) and read `req.wallet`.

## Engine (engine/*, runtime.ts, readModel.ts)
- `createOffchainRuntime()` builds `{ repo, ledger, engine }` (Postgres `PrismaRepo` when DATABASE_URL works;
  `MemoryRepo` off-mainnet; mainnet without DATABASE_URL → refuses to start; mainnet with DB down → `ctx.offchain = null`,
  trade routes 503, API still boots).
- Scheduler (`startOffchainScheduler`, every `OFFCHAIN_TICK_MS`, default 2000): commit→reveal (+ auto-reveals from
  sealed envelopes) → clear (shared `computeClearing`/`settleBid`) + graduate in ONE serializable tx → drips when due →
  `distributeFees` (shared `splitFees`) → live→flywheel flip.
- Deterministic ledger keys: `commit:<l>:<w>`, `clear:<l>`, `graduate:<l>`, `claim:<l>:<w>`, `drip:<l>:<n>`,
  `fees:<l>:<n>`, `swap:<w>:<Idempotency-Key>`, `stake:<l>:<w>:<Idempotency-Key>`, `rewards:<l>:<w>:<claimedTotal>`.
- `CompositeStore` (readModel.ts) serves every existing GET route / WS snapshot from: demo world (DEMO_MODE, even when
  the primary store is Postgres) ∪ primary store ∪ offchain launches (`isDemo=false`).
