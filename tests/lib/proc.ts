import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface Proc {
  child: ChildProcess;
  logs: () => string;
  stop: () => Promise<void>;
}

/** Spawn a long-running process with a minimal env (PATH/HOME only + extras), capturing output for diagnostics. */
export function start(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): Proc {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
  const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let out = "";
  const cap = (d: Buffer) => {
    out += d.toString();
    if (out.length > 200_000) out = out.slice(-100_000);
  };
  child.stdout?.on("data", cap);
  child.stderr?.on("data", cap);
  return {
    child,
    logs: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const t = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        try {
          process.kill(-child.pid!, "SIGTERM"); // whole process group (next start spawns children)
        } catch {
          child.kill("SIGTERM");
        }
      }),
  };
}

export async function waitFor(url: string, p: Proc, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (p.child.exitCode !== null) throw new Error(`process exited (${p.child.exitCode}) before ${url} came up:\n${p.logs().slice(-4000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url} (${last}):\n${p.logs().slice(-4000)}`);
}

export async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}
