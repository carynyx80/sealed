"use client";
/**
 * Mainnet stand-in for ./demoStore (swapped in by next.config.mjs when NEXT_PUBLIC_NETWORK is mainnet), so the
 * demo simulator (createDemoWorld / tickDemoWorld from @sealed/shared) is never part of a mainnet client bundle.
 * Behaves exactly like demoStore.ts with DEMO_ENABLED === false: nothing is ever built, ticked or shown.
 */
import type * as Real from "./demoStore";

export class DemoDisabledError extends Error {
  constructor() {
    super("Demo data is disabled on mainnet");
    this.name = "DemoDisabledError";
  }
}

const disabled = (): never => {
  throw new DemoDisabledError();
};

export const getDemoWorld: typeof Real.getDemoWorld = disabled;
export const subscribeDemo: typeof Real.subscribeDemo = () => () => undefined;
export const demoVersion: typeof Real.demoVersion = () => 0;
export const findDemoLaunch: typeof Real.findDemoLaunch = () => undefined;
export const demoProtocolStats: typeof Real.demoProtocolStats = disabled;
export const demoRevenue: typeof Real.demoRevenue = disabled;
export const createDemoLaunch: typeof Real.createDemoLaunch = disabled;
export const noteDemoBid: typeof Real.noteDemoBid = () => undefined;

// Compile-time guard: fails typecheck if demoStore.ts gains an export this stub does not provide.
type MissingExports = Exclude<keyof typeof Real, keyof typeof import("./demoStore.disabled")>;
export const __demoStubComplete: [MissingExports] extends [never] ? true : MissingExports = true;
