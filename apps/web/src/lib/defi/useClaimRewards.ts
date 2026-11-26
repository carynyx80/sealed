"use client";
// Owned by defi-integrations-agent. Holder rewards for the connected wallet:
// GET /api/rewards/:mint/:wallet; claim builds a claim_rewards tx (demo launches simulate the claim).
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { API_ROUTES, type HolderReward, type LaunchSummary } from "@sealed/shared";
import { buildTransaction, ensureAtaIx, programErrorName } from "@sealed/defi";
import { apiFetch, demoSignature, errorMessage, sleep } from "./config";
import { getSealedClient, launchKeys } from "./program";

export function useClaimRewards(launch: LaunchSummary) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [reward, setReward] = useState<HolderReward | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = publicKey?.toBase58() ?? null;

  const refresh = useCallback(async () => {
    if (!wallet) {
      setReward(null);
      return;
    }
    setLoading(true);
    try {
      setReward(await apiFetch<HolderReward>(API_ROUTES.rewards(launch.mint, wallet)));
      setError(null);
    } catch (e) {
      setReward(null);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [launch.mint, wallet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(async (): Promise<string> => {
    if (!publicKey) throw new Error("Connect a wallet to claim");
    if (reward && !reward.eligible) throw new Error("This wallet bought in the graduation slot and is not eligible for rewards");
    setLoading(true);
    setError(null);
    try {
      if (launch.isDemo) {
        await sleep(900);
        const signature = demoSignature("claim");
        setReward((r) => (r ? { ...r, claimed: r.claimed + r.claimable, claimable: 0 } : r));
        return signature;
      }
      if (!sendTransaction) throw new Error("Wallet cannot send transactions");
      const keys = launchKeys(launch);
      const client = await getSealedClient(connection, publicKey);
      // Rewards are paid in quote; make sure the holder's quote ATA exists (idempotent).
      const ixs = [
        ensureAtaIx(publicKey, publicKey, keys.quoteMint, keys.quoteTokenProgram).ix,
        await client.claimRewardsIx(keys, publicKey),
      ];
      const { tx, blockhash, lastValidBlockHeight } = await buildTransaction(connection, publicKey, ixs);
      const signature = await sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`claim_rewards failed: ${JSON.stringify(conf.value.err)}`);
      await refresh();
      return signature;
    } catch (e) {
      const code = programErrorName(e);
      setError(code ? `${code}: ${errorMessage(e)}` : errorMessage(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [publicKey, reward, launch, sendTransaction, connection, refresh]);

  return {
    reward,
    loading,
    claim,
    error,
    refresh,
  };
}
