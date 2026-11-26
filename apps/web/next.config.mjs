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
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, os: false, path: false };
    }
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...walletAliases };
    // Optional native deps pulled in by wallet adapters / ws.
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
