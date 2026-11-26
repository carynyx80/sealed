import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pin the wallet-adapter React packages to ONE physical copy. pnpm can materialise several copies of the same
 * version (one per peer-dependency set, e.g. after a react bump); if two copies end up in the client bundle, the
 * WalletProvider and `useWallet()` read different React contexts and every hook logs "You have tried to read
 * publicKey on a WalletContext without providing one".
 */
const singleton = (pkg) => {
  try {
    return realpathSync(path.join(here, "node_modules", pkg));
  } catch {
    return null;
  }
};
const walletAliases = Object.fromEntries(
  ["@solana/wallet-adapter-react", "@solana/wallet-adapter-react-ui"]
    .map((p) => [p, singleton(p)])
    .filter(([, v]) => v),
);

/** Same parsing as src/lib/config.ts parseNetwork(): mainnet builds never ship the client-side demo simulator. */
const buildNetwork = (process.env.NEXT_PUBLIC_NETWORK ?? "").trim().toLowerCase();
const isMainnetBuild = buildNetwork === "mainnet" || buildNetwork === "mainnet-beta";
const demoStoreStub = path.join(here, "src/lib/demoStore.disabled.ts");

const isProd = process.env.VERCEL_ENV === "production" || (process.env.NODE_ENV === "production" && !process.env.VERCEL_ENV);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a production build go to a separate folder (e.g. NEXT_DIST_DIR=.next-perf) without touching the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  transpilePackages: ["@sealed/shared", "@sealed/defi"],
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  // Apex → www (Vercel also does this at the domain level; this is a fallback).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "sealedsol.xyz" }],
        destination: "https://www.sealedsol.xyz/:path*",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, os: false, path: false };
    }
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...walletAliases };
    // Optional native deps pulled in by wallet adapters / ws.
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    // Helius Privacy Rings SDK (lazy chunk): @lightprotocol/hasher.rs "browser-fat" inlines its wasm, but its
    // wasm-bindgen init keeps an unused `new URL("*.wasm", import.meta.url)` default that webpack can't resolve.
    config.module.rules.push({ test: /[\\/]@lightprotocol[\\/]hasher\.rs[\\/].*\.m?js$/, parser: { url: false } });
    // Tree-shaking: the workspace packages and src/lib are plain ES modules with no import-time side effects, but
    // their package.json files don't say so, so webpack kept every module behind a barrel (`@sealed/shared`,
    // `@sealed/defi`, `@/lib/custody`) — e.g. Anchor + zod + spl-token in every page's layout chunk.
    config.module.rules.push({ test: /[\\/]packages[\\/](shared|defi)[\\/]dist[\\/].*\.js$/, sideEffects: false });
    config.module.rules.push({ test: /\.tsx?$/, include: path.join(here, "src", "lib"), sideEffects: false });
    // Mainnet: swap the demo world for its no-op stub (see src/lib/demoStore.disabled.ts).
    if (isMainnetBuild) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^(\.\/|@\/lib\/)demoStore$/, demoStoreStub));
    }
    return config;
  },
};

export default nextConfig;
