# What powers Sealed

| Component | What it does here | Status |
|---|---|---|
| Solana | Settlement: custodial deposits/withdrawals; whole launch in onchain mode | devnet; deposits pending `HELIUS_API_KEY` on Railway |
| Anchor 0.32 | `sealed_launchpad` program, PDAs, events, IDL | on-chain, tests passing (build OK, 15/15 Rust, 18/18 anchor); not deployed |
| SPL Token / @solana/spl-token 0.4.9 | escrow, vault, pool, rewards accounts; PDA mint authority; burns | on-chain, tests passing; not deployed |
| @solana/web3.js 1.98 | keys, PDAs, connections everywhere | tests passing |
| Helius RPC | RPC from `HELIUS_API_KEY`; deposit detection; indexer | deposit watcher built + tested; key not set on Railway |
| Helius Privacy Rings | confidential amounts; status probe + indexer proxy real | simulated in demo; escrow planned |
| Internal CPMM pool | graduation venue, 1% fee, locked liquidity, anti-snipe | live in demo |
| Jupiter v6 | quote-asset conversion before pool swaps | implemented, tests passing |
| Raydium | optional CPMM/LaunchLab adapter (addresses + plan), not called by protocol | optional, not wired |
| Solana Wallet Adapter | connect, signMessage (SIWS, bid vault, reveal auth), sendTransaction | live in demo |
| Next.js 15.0.8 / React 19.0.9 on Vercel | web app + `/docs` (www.sealedsol.xyz) | live |
| Fastify on Railway (Node 22) | REST, WS hub, workers, custodial engine, `/llms.txt`; Dockerfile + railway.json | live; API suite 87/87 |
| Postgres + Prisma | store of record; custodial double-entry ledger | ledger off-chain, tests passing; live on Railway Postgres |
| Redis | short-TTL cache, keeper queue; memory fallback | tests passing |
| tweetnacl | x25519 sealing of auto-reveals, ed25519 checks | tests passing |
| @noble/hashes keccak_256 | bid commitment | tests passing |
| WebCrypto HKDF + AES-GCM | encrypted bid salts in IndexedDB | tests passing |
| framer-motion 11, Tailwind 3.4 | motion and design tokens (DESIGN.md) | live |
| TypeScript 5.6 strict, Zod 3.23, @sealed/shared | the typed contract; docs import constants directly | tests passing |
