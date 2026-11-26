/**
 * Optional Raydium CPMM migration adapter (server side). Graduation seeds the program's internal locked pool
 * (see packages/shared/src/program.ts); this adapter only looks up whether a Raydium pool exists for a pair so
 * the API/agents can surface an external venue. Network failures return null.
 */
export interface RaydiumPoolInfo {
  id: string;
  mintA: string;
  mintB: string;
  tvl: number;
  price: number;
  type: string;
}

export async function findRaydiumPool(mintA: string, mintB: string, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<RaydiumPoolInfo | null> {
  const base = (opts.baseUrl ?? "https://api-v3.raydium.io").replace(/\/$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const q = new URLSearchParams({ mint1: mintA, mint2: mintB, poolType: "all", poolSortField: "liquidity", sortType: "desc", pageSize: "1", page: "1" });
    const res = await fetch(`${base}/pools/info/mint?${q.toString()}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { data?: Array<{ id: string; mintA: { address: string }; mintB: { address: string }; tvl: number; price: number; type: string }> } };
    const p = body.data?.data?.[0];
    return p ? { id: p.id, mintA: p.mintA.address, mintB: p.mintB.address, tvl: p.tvl, price: p.price, type: p.type } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
