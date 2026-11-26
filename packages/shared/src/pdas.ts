import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants.js";

const enc = (s: string) => new TextEncoder().encode(s);
const pk = (k: PublicKey | string) => (typeof k === "string" ? new PublicKey(k) : k);

export function programId(id: string = PROGRAM_ID): PublicKey {
  return new PublicKey(id);
}

function find(seeds: Uint8Array[], pid: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, pid);
}

/** Deterministic PDA derivations. Seeds mirror the Anchor `#[account(seeds = ...)]` constraints exactly. */
export const pdas = {
  protocol: (pid = programId()) => find([enc(SEEDS.protocol)], pid),
  creditPool: (quoteMint: PublicKey | string, pid = programId()) => find([enc(SEEDS.creditPool), pk(quoteMint).toBytes()], pid),
  launch: (tokenMint: PublicKey | string, pid = programId()) => find([enc(SEEDS.launch), pk(tokenMint).toBytes()], pid),
  bid: (launch: PublicKey | string, bidder: PublicKey | string, pid = programId()) =>
    find([enc(SEEDS.bid), pk(launch).toBytes(), pk(bidder).toBytes()], pid),
  escrow: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.escrow), pk(launch).toBytes()], pid),
  vault: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.vault), pk(launch).toBytes()], pid),
  feeCollector: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.feeCollector), pk(launch).toBytes()], pid),
  pool: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.pool), pk(launch).toBytes()], pid),
  poolQuote: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.poolQuote), pk(launch).toBytes()], pid),
  poolToken: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.poolToken), pk(launch).toBytes()], pid),
  antiSnipe: (launch: PublicKey | string, wallet: PublicKey | string, pid = programId()) =>
    find([enc(SEEDS.antiSnipe), pk(launch).toBytes(), pk(wallet).toBytes()], pid),
  position: (launch: PublicKey | string, owner: PublicKey | string, pid = programId()) =>
    find([enc(SEEDS.position), pk(launch).toBytes(), pk(owner).toBytes()], pid),
  rewardsVault: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.rewardsVault), pk(launch).toBytes()], pid),
  mintAuthority: (launch: PublicKey | string, pid = programId()) => find([enc(SEEDS.mintAuthority), pk(launch).toBytes()], pid),
};
