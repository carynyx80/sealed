# Cross-agent contract (read before building)

- Shared package: `@sealed/shared` (packages/shared/src). Build: `pnpm --filter @sealed/shared build`. Do not edit it; if you need a change, describe it in your final report.
- Program id: `71geDPZMKfjJnKE4an15QyyH5TyFG1w7XEL5tUkp5Tpy` (keypair at programs/sealed-launchpad/target/deploy/sealed_launchpad-keypair.json).
- Ports: API `http://localhost:4000` (WS `ws://localhost:4000/ws`), web `http://localhost:3000`.
- Web env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_NETWORK` (devnet|mainnet|localnet), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_PROGRAM_ID`.
- API env: `PORT`, `DEMO_MODE` (default true when no RPC/DB), `DATABASE_URL` (optional → memory), `REDIS_URL` (optional → memory), `SOLANA_RPC_URL`, `HELIUS_API_KEY`, `NETWORK`, `PROGRAM_ID`, `RELAYER_SECRET_KEY` (base58 ed25519 fee payer), `RELAYER_BOX_SEED` (hex 32, x25519), `KEEPER_SECRET_KEY`, `CORS_ORIGIN`.
- DTO amounts are UI units (numbers); on-chain/tx code uses bigint atoms. Prices = quote per whole token (tokens have 6 decimals).
- Clearing math: `computeClearing` / `settleBid` in clearing.ts are canonical. Fee split: `splitFees` in fees.ts. Commitment: commitment.ts (80-byte preimage, keccak256).
- Web boundary owned by defi agent (stubs exist with final signatures): `components/wallet/SolanaProviders.tsx`, `components/wallet/ConnectButton.tsx`, `components/swap/OneClickJupiterSwap.tsx`, `lib/defi/useSealedBid.ts`, `lib/defi/useClaimRewards.ts`.
- Toolchain: pnpm at ~/.local/bin/pnpm (v12; `export PATH=~/.local/bin:$PATH`). Solana CLI: `export PATH=~/.local/share/solana/install/active_release/bin:$PATH`. anchor-cli 0.32.2. No Postgres/Redis/Docker locally.
- Concurrent installs: several agents share one pnpm workspace. If `pnpm install` fails with a lock/ENOENT race, wait ~20s and retry. Never delete node_modules or pnpm-lock.yaml.
