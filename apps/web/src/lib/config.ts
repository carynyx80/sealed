import type { Network } from "@sealed/shared";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4000/ws";
const rawNet = process.env.NEXT_PUBLIC_NETWORK;
export const NETWORK: Network = rawNet === "mainnet" || rawNet === "localnet" ? rawNet : "devnet";
export const IS_MAINNET = NETWORK === "mainnet";
