/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sealed/shared", "@sealed/defi"],
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, os: false, path: false };
    }
    // Optional native deps pulled in by wallet adapters / ws.
    config.externals = [...(Array.isArray(config.externals) ? config.externals : []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

export default nextConfig;
