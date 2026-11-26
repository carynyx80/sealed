"use client";
// Owned by defi-integrations-agent.
// Commit a sealed bid. Demo mode (launch.isDemo) → real keccak commitment + POST /api/auctions/:id/demo-bid.
// Devnet/mainnet → commit_bid tx via wallet, salt stored encrypted in the BidVault, optional auto-reveal
// envelope sealed to the relayer (POST /api/relayer/reveals).
// privateDeposit (helius-privacy-agent): fund the escrow from a Helius Privacy Ring confidential balance.
//   Demo → simulated ring: top up the shielded balance if needed, confidential-transfer to the escrow, mark the bid.
//   Devnet/mainnet → the real adapter; fails closed before any tx while the program escrow cannot be funded
//   confidentially (see docs/PRIVACY.md).
import { useCallback, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { API_ROUTES, QUOTE_ASSETS, type AuctionResponse, type LaunchSummary, type RelayerPubkeyResponse } from "@sealed/shared";
import {
  BidVault,
  buildAutoRevealEnvelope,
  buildTransaction,
  defaultVaultStorage,
  deriveVaultKey,
  gridFromUi,
  isWsol,
  prepareSealedBid,
  priceTicksUi,
  programErrorName,
  simulatedViewingKey,
  uiToAtoms,
  wrapSolIxs,
  EscrowFundingUnsupportedError,
} from "@sealed/defi";
import { apiFetch, demoSignature, errorMessage } from "./config";
import { getSealedClient, launchKeys } from "./program";
import { fetchPrivacyStatus, heliusRing, privacyOwner, simulatedRing } from "../privacy/ring";
import { invalidateShieldedBalance, setPrivacyOp } from "../privacy/usePrivacyRing";

export interface CommitArgs { maxPrice: number; amount: number; deposit: number; autoReveal: boolean; /** Fund the deposit from a Helius Privacy Ring confidential balance (hides deposit size). */ privateDeposit?: boolean }
export interface CommitResult {
  signature: string;
  commitmentHex: string;
  autoRevealQueued: boolean;
  /** Deposit was funded from a (possibly simulated) Helius Privacy Ring confidential balance. */
  privatelyFunded?: boolean;
  /** Ring funding signature (prefixed `simring` when simulated). */
  privacySignature?: string;
}
export type SealedBidStatus = "idle" | "hashing" | "signing" | "submitting" | "done" | "error";

/* ----------------------------------------------------------------------------------- vault sessions */

const vaults = new Map<string, Promise<BidVault>>();

function walletVault(wallet: string, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<BidVault> {
  let v = vaults.get(wallet);
  if (!v) {
    v = BidVault.unlock({ wallet, signMessage, storage: defaultVaultStorage() });
    v.catch(() => vaults.delete(wallet));
    vaults.set(wallet, v);
  }
  return v;
}

/** Demo without a wallet: a per-device pseudo-bidder and a device-local secret (demo only, never real funds). */
const DEMO_ID_KEY = "sealed-demo-identity:v1";
function demoIdentity(): { bidder: string; secret: Uint8Array } {
  const fresh = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(96));
    return { bidder: new PublicKey(bytes.slice(0, 32)).toBase58(), secret: bytes.slice(32) };
  };
  try {
    const raw = localStorage.getItem(DEMO_ID_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { bidder: string; secret: number[] };
      return { bidder: j.bidder, secret: new Uint8Array(j.secret) };
    }
    const id = fresh();
    localStorage.setItem(DEMO_ID_KEY, JSON.stringify({ bidder: id.bidder, secret: Array.from(id.secret) }));
    return id;
  } catch {
    return fresh();
  }
}

async function demoVault(): Promise<{ bidder: string; vault: BidVault }> {
  const id = demoIdentity();
  let v = vaults.get(`demo:${id.bidder}`);
  if (!v) {
    v = deriveVaultKey(id.secret, id.bidder).then((k) => BidVault.fromKey(id.bidder, k, defaultVaultStorage()));
    vaults.set(`demo:${id.bidder}`, v);
  }
  return { bidder: id.bidder, vault: await v };
}

/* -------------------------------------------------------------------------------------------- hook */

export function useSealedBid(launch: LaunchSummary) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const [status, setStatus] = useState<SealedBidStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const quoteDecimals = QUOTE_ASSETS[launch.quoteAsset].decimals;
  const priceTicks = useMemo(
    () => priceTicksUi({ floorPrice: launch.auction.floorPrice, tickSize: launch.auction.tickSize }, quoteDecimals),
    [launch.auction.floorPrice, launch.auction.tickSize, quoteDecimals],
  );

  const commit = useCallback(
    async (a: CommitArgs): Promise<CommitResult> => {
      if (busy.current) throw new Error("A bid is already being submitted");
      busy.current = true;
      setError(null);
      try {
        if (!(a.amount > 0)) throw new Error("Bid amount must be greater than 0");
        if (a.deposit < a.amount) throw new Error("Deposit must cover the bid amount");
        if (launch.status !== "commit") throw new Error("The commit window is closed");

        setStatus("hashing");
        const grid = gridFromUi(launch.auction, quoteDecimals);
        const maxPrice = uiToAtoms(a.maxPrice, quoteDecimals);
        const bidAmount = uiToAtoms(a.amount, quoteDecimals);
        const deposit = uiToAtoms(a.deposit, quoteDecimals);
        const now = Math.floor(Date.now() / 1000);

        /* ---------------------------------------------------------------------------------- demo */
        if (launch.isDemo) {
          const demo = publicKey && signMessage ? null : await demoVault();
          const bidder = publicKey?.toBase58() ?? demo!.bidder;
          const prepared = prepareSealedBid({ bidder, grid, maxPrice, bidAmount, deposit });
          setStatus("signing");
          let privacySignature: string | undefined;
          if (a.privateDeposit) {
            // Simulated Privacy Ring: no real funds. Top up the shielded balance (a real ring deposit is public),
            // then a confidential transfer into the escrow — only sender/recipient would be visible.
            const ring = simulatedRing();
            const owner = privacyOwner(publicKey?.toBase58());
            try {
              setPrivacyOp("proving");
              const have = await ring.decryptBalance(owner, launch.quoteAsset, simulatedViewingKey(owner));
              if (have < deposit) await ring.shield({ owner, symbol: launch.quoteAsset, atoms: deposit - have });
              setPrivacyOp("submitting");
              const funded = await ring.fundEscrow({ owner, launchId: launch.id, symbol: launch.quoteAsset, atoms: deposit, commitmentHex: prepared.commitmentHex });
              privacySignature = funded.signature;
              invalidateShieldedBalance(owner, launch.quoteAsset);
              setPrivacyOp("done");
            } catch (e) {
              setPrivacyOp("error", errorMessage(e));
              throw e;
            }
          }
          const vault = demo?.vault ?? (await walletVault(bidder, signMessage!));
          await vault.save({
            launchId: launch.id, bidder, network: launch.network, commitmentHex: prepared.commitmentHex,
            maxPrice: prepared.maxPrice.toString(), bidAmount: bidAmount.toString(), deposit: deposit.toString(),
            saltHex: prepared.saltHex, tick: prepared.tick, createdTs: now,
          });
          setStatus("submitting");
          await apiFetch<AuctionResponse>(API_ROUTES.demoBid(launch.id), {
            method: "POST",
            body: JSON.stringify({ wallet: publicKey?.toBase58(), commitment: prepared.commitmentHex, deposit: a.deposit }),
          });
          const signature = demoSignature(prepared.commitmentHex);
          await vault.update(launch.id, { txSignature: signature });
          setStatus("done");
          return { signature, commitmentHex: prepared.commitmentHex, autoRevealQueued: false, privatelyFunded: !!privacySignature, privacySignature };
        }

        /* ------------------------------------------------------------------------- devnet/mainnet */
        if (!publicKey || !sendTransaction) throw new Error("Connect a wallet to bid");
        if (a.autoReveal && !signMessage) throw new Error("This wallet cannot sign messages; disable auto-reveal");
        if (!signMessage) throw new Error("This wallet cannot sign messages (needed to encrypt your bid salt)");
        const bidder = publicKey.toBase58();
        const prepared = prepareSealedBid({ bidder, grid, maxPrice, bidAmount, deposit });

        if (a.privateDeposit) {
          // Checked BEFORE the vault write and any transaction so nothing is half-done.
          const ring = await fetchPrivacyStatus();
          if (!ring.available || ring.simulated) {
            throw new Error(`Private deposits need the Helius Privacy Ring on ${launch.network}: ${ring.reason ?? "unavailable"}. Turn off private deposit to bid publicly.`);
          }
          const client = heliusRing();
          if (!client.capabilities().fundProgramEscrow) {
            throw new Error(`${new EscrowFundingUnsupportedError().message} Turn off private deposit to bid publicly.`);
          }
          // TODO(contracts): once commit_bid_shielded ships (docs/PRIVACY.md §5) build it here:
          //   client.fundEscrow(...) → commit_bid_shielded(commitment, ring receipt). The public commit_bid below
          //   would transfer the deposit in the clear, so never fall through to it.
          throw new Error("commit_bid_shielded is not available in this client build. Turn off private deposit to bid publicly.");
        }

        setStatus("signing");
        // 1. Persist the encrypted preimage BEFORE sending, so a landed tx can never lose its salt.
        const vault = await walletVault(bidder, signMessage);
        await vault.save({
          launchId: launch.id, bidder, network: launch.network, commitmentHex: prepared.commitmentHex,
          maxPrice: prepared.maxPrice.toString(), bidAmount: bidAmount.toString(), deposit: deposit.toString(),
          saltHex: prepared.saltHex, tick: prepared.tick, createdTs: now,
        });

        // 2. Build commit_bid (wrap SOL first when the quote asset is wSOL).
        const keys = launchKeys(launch);
        const client = await getSealedClient(connection, publicKey);
        const ixs = isWsol(keys.quoteMint) ? wrapSolIxs(publicKey, deposit) : [];
        ixs.push(await client.commitBidIx(keys, publicKey, prepared.commitment, deposit));
        const { tx, blockhash, lastValidBlockHeight } = await buildTransaction(connection, publicKey, ixs);

        setStatus("submitting");
        const signature = await sendTransaction(tx, connection);
        await vault.update(launch.id, { txSignature: signature });
        const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (conf.value.err) throw new Error(`commit_bid failed: ${JSON.stringify(conf.value.err)}`);

        // 3. Optional auto-reveal: seal the preimage to the relayer's x25519 key, authorised by a wallet signature.
        let autoRevealQueued = false;
        if (a.autoReveal) {
          try {
            const rk = await apiFetch<RelayerPubkeyResponse>(API_ROUTES.relayerPubkey);
            const envelope = await buildAutoRevealEnvelope({ launchId: launch.id, prepared, relayerPubkeyB64: rk.pubkey, signMessage });
            await apiFetch<{ accepted: true; id: string }>(API_ROUTES.relayerReveals, { method: "POST", body: JSON.stringify(envelope) });
            autoRevealQueued = true;
            await vault.update(launch.id, { autoRevealQueued: true });
          } catch (e) {
            // The bid is committed and the salt is safe locally; the user can reveal manually.
            setError(`Bid committed, but auto-reveal could not be queued: ${errorMessage(e)}`);
          }
        }
        setStatus("done");
        return { signature, commitmentHex: prepared.commitmentHex, autoRevealQueued };
      } catch (e) {
        const code = programErrorName(e);
        setError(code ? `${code}: ${errorMessage(e)}` : errorMessage(e));
        setStatus("error");
        throw e;
      } finally {
        busy.current = false;
      }
    },
    [launch, quoteDecimals, publicKey, sendTransaction, signMessage, connection],
  );

  return {
    status,
    error,
    commit,
    /** Price ticks the bidder may choose from (UI units). */
    priceTicks,
  };
}
