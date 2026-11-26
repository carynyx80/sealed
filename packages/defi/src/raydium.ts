import { PublicKey } from "@solana/web3.js";
import { TOKEN_UNIT, type Network } from "@sealed/shared";

/**
 * OPTIONAL Raydium CPMM / LaunchLab migration adapter.
 *
 * The canonical graduation venue is the program's INTERNAL constant-product pool (see @sealed/shared program.ts):
 * liquidity there is permanently locked and every swap routes the 1% fee to the Fee Collector PDA and enforces
 * same-slot anti-snipe on-chain. Moving liquidity to Raydium would forfeit those guarantees, so nothing in the
 * protocol calls this module automatically. It exists for operators who want an *additional* external market
 * (e.g. seeding a mirror CPMM pool with treasury-owned inventory) and for analytics that need Raydium addresses.
 *
 * This module is pure: it derives addresses and produces a human/agent-readable plan. Building the actual
 * Raydium transactions is delegated to `@raydium-io/raydium-sdk-v2` (not a dependency here) using the plan.
 * PDA seeds follow the public raydium-cp-swap program source.
 */

export interface RaydiumConfig {
  network: Network;
  cpmmProgramId: PublicKey;
  launchLabProgramId: PublicKey;
  /** CPMM AmmConfig index (fee tier). Index 0 = 0.25% on mainnet. */
  ammConfigIndex: number;
  /** Lamports Raydium charges to create a CPMM pool (create_pool_fee receiver). */
  createPoolFeeReceiver: PublicKey | null;
}

const CPMM_IDS: Record<Network, string> = {
  mainnet: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  devnet: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  localnet: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
};
const LAUNCHLAB_IDS: Record<Network, string> = {
  mainnet: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  devnet: "LanD8FpTBBvzZFXjTxsAoipkFsxPUCDB4qAqKxYDiNP",
  localnet: "LanD8FpTBBvzZFXjTxsAoipkFsxPUCDB4qAqKxYDiNP",
};
const CREATE_POOL_FEE: Record<Network, string | null> = {
  mainnet: "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8",
  devnet: "G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2",
  localnet: null,
};

export function raydiumConfig(network: Network, overrides: Partial<Omit<RaydiumConfig, "network">> = {}): RaydiumConfig {
  const fee = CREATE_POOL_FEE[network];
  return {
    network,
    cpmmProgramId: overrides.cpmmProgramId ?? new PublicKey(CPMM_IDS[network]),
    launchLabProgramId: overrides.launchLabProgramId ?? new PublicKey(LAUNCHLAB_IDS[network]),
    ammConfigIndex: overrides.ammConfigIndex ?? 0,
    createPoolFeeReceiver: overrides.createPoolFeeReceiver ?? (fee ? new PublicKey(fee) : null),
  };
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Raydium CPMM requires mint0 < mint1 (byte order). */
export function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  const ab = a.toBytes();
  const bb = b.toBytes();
  for (let i = 0; i < 32; i++) {
    if (ab[i] !== bb[i]) return ab[i]! < bb[i]! ? [a, b] : [b, a];
  }
  throw new Error("identical mints");
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

export const raydiumCpmmPdas = {
  ammConfig: (cfg: RaydiumConfig, index = cfg.ammConfigIndex) =>
    PublicKey.findProgramAddressSync([enc("amm_config"), u16be(index)], cfg.cpmmProgramId)[0],
  authority: (cfg: RaydiumConfig) => PublicKey.findProgramAddressSync([enc("vault_and_lp_mint_auth_seed")], cfg.cpmmProgramId)[0],
  poolState: (cfg: RaydiumConfig, ammConfig: PublicKey, mint0: PublicKey, mint1: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("pool"), ammConfig.toBytes(), mint0.toBytes(), mint1.toBytes()], cfg.cpmmProgramId)[0],
  lpMint: (cfg: RaydiumConfig, pool: PublicKey) => PublicKey.findProgramAddressSync([enc("pool_lp_mint"), pool.toBytes()], cfg.cpmmProgramId)[0],
  vault: (cfg: RaydiumConfig, pool: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("pool_vault"), pool.toBytes(), mint.toBytes()], cfg.cpmmProgramId)[0],
  observation: (cfg: RaydiumConfig, pool: PublicKey) => PublicKey.findProgramAddressSync([enc("observation"), pool.toBytes()], cfg.cpmmProgramId)[0],
};

export interface RaydiumCpmmPoolKeys {
  programId: PublicKey;
  ammConfig: PublicKey;
  authority: PublicKey;
  poolState: PublicKey;
  lpMint: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
}

export function deriveCpmmPoolKeys(cfg: RaydiumConfig, mintA: PublicKey | string, mintB: PublicKey | string): RaydiumCpmmPoolKeys {
  const [mint0, mint1] = sortMints(new PublicKey(mintA), new PublicKey(mintB));
  const ammConfig = raydiumCpmmPdas.ammConfig(cfg);
  const poolState = raydiumCpmmPdas.poolState(cfg, ammConfig, mint0, mint1);
  return {
    programId: cfg.cpmmProgramId,
    ammConfig,
    authority: raydiumCpmmPdas.authority(cfg),
    poolState,
    lpMint: raydiumCpmmPdas.lpMint(cfg, poolState),
    mint0,
    mint1,
    vault0: raydiumCpmmPdas.vault(cfg, poolState, mint0),
    vault1: raydiumCpmmPdas.vault(cfg, poolState, mint1),
    observation: raydiumCpmmPdas.observation(cfg, poolState),
  };
}

export interface MigrationPlanInput {
  network: Network;
  tokenMint: PublicKey | string;
  quoteMint: PublicKey | string;
  /** Inventory to seed the external pool with (atoms). Must come from a wallet the operator controls —
   *  NOT from the program's internal pool, which has no remove-liquidity instruction by design. */
  tokenAmount: bigint;
  quoteAmount: bigint;
  /** Who signs and receives the LP tokens. */
  owner: PublicKey | string;
  /** If true, plan to burn the LP tokens so the mirror pool is also permanently locked. */
  burnLp?: boolean;
  /** Unix seconds the pool should open; defaults to immediately. */
  openTime?: number;
  config?: Partial<Omit<RaydiumConfig, "network">>;
}

export interface MigrationStep {
  id: string;
  description: string;
  program: string;
  accounts: Record<string, string>;
}

export interface MigrationPlan {
  venue: "raydium-cpmm";
  optional: true;
  network: Network;
  canonicalVenue: "sealed-launchpad-internal-pool";
  pool: Record<keyof RaydiumCpmmPoolKeys, string>;
  /** Initial price, quote atoms per whole token. */
  initialPrice: bigint;
  /** Amounts in Raydium's mint0/mint1 ordering. */
  amount0: bigint;
  amount1: bigint;
  steps: MigrationStep[];
  warnings: string[];
}

export function buildMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  if (input.tokenAmount <= 0n || input.quoteAmount <= 0n) throw new Error("tokenAmount and quoteAmount must be > 0");
  const cfg = raydiumConfig(input.network, input.config);
  const tokenMint = new PublicKey(input.tokenMint);
  const quoteMint = new PublicKey(input.quoteMint);
  const keys = deriveCpmmPoolKeys(cfg, tokenMint, quoteMint);
  const tokenIs0 = keys.mint0.equals(tokenMint);
  const owner = new PublicKey(input.owner).toBase58();
  const pool = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, (v as PublicKey).toBase58()])) as MigrationPlan["pool"];

  const warnings = [
    "Optional adapter: the protocol's canonical pool is the program's internal CPMM (locked liquidity, on-chain fee routing, anti-snipe).",
    "Trades on Raydium do NOT pay the 1% fee to the Fee Collector PDA and do NOT repay the buyback credit line.",
    "Seed inventory must come from an operator-controlled wallet; the internal pool has no remove-liquidity instruction.",
  ];
  if (input.network !== "mainnet") warnings.push(`Raydium ${input.network} deployment has thin/no liquidity; use for integration testing only.`);
  if (!cfg.createPoolFeeReceiver) warnings.push("No create-pool fee receiver configured for this network; pass config.createPoolFeeReceiver.");

  const steps: MigrationStep[] = [
    {
      id: "create-pool",
      description: `Initialize Raydium CPMM pool (AmmConfig #${cfg.ammConfigIndex}) and deposit initial liquidity`,
      program: cfg.cpmmProgramId.toBase58(),
      accounts: {
        creator: owner, ammConfig: pool.ammConfig, authority: pool.authority, poolState: pool.poolState,
        token0Mint: pool.mint0, token1Mint: pool.mint1, lpMint: pool.lpMint, token0Vault: pool.vault0, token1Vault: pool.vault1,
        observationState: pool.observation, createPoolFee: cfg.createPoolFeeReceiver?.toBase58() ?? "",
      },
    },
  ];
  if (input.burnLp) {
    steps.push({
      id: "burn-lp",
      description: "Burn all LP tokens received so the mirror pool's liquidity is permanently locked",
      program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      accounts: { owner, lpMint: pool.lpMint },
    });
  }

  return {
    venue: "raydium-cpmm",
    optional: true,
    network: input.network,
    canonicalVenue: "sealed-launchpad-internal-pool",
    pool,
    initialPrice: (input.quoteAmount * TOKEN_UNIT) / input.tokenAmount,
    amount0: tokenIs0 ? input.tokenAmount : input.quoteAmount,
    amount1: tokenIs0 ? input.quoteAmount : input.tokenAmount,
    steps,
    warnings,
  };
}
