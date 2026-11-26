import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { launchChannel, type WsChannel, type WsEnvelope, type WsEvent } from "@sealed/shared";
import type { AppContext } from "../context.js";
import { getStatsCached } from "../routes/stats.js";

const ChannelSchema = z.union([z.literal("global"), z.string().regex(/^launch:[1-9A-HJ-NP-Za-km-z]{32,44}$/)]);
const ClientMessageSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), channels: z.array(ChannelSchema).max(100) }),
  z.object({ op: z.literal("unsubscribe"), channels: z.array(ChannelSchema).max(100) }),
  z.object({ op: z.literal("ping") }),
]);

/** Event types that are mirrored onto "global" in addition to their launch channel. */
const GLOBAL_TYPES = new Set<WsEvent["type"]>([
  "launch.created",
  "auction.phase_changed",
  "auction.cleared",
  "auction.bid_committed",
  "auction.bid_revealed",
  "vault.drip",
  "credit.flywheel_activated",
  "stats.updated",
]);

function launchIdOf(evt: WsEvent): string | null {
  switch (evt.type) {
    case "launch.created":
    case "launch.updated":
      return evt.data.id;
    case "stats.updated":
      return null;
    default:
      return (evt.data as { launchId?: string }).launchId ?? null;
  }
}

export function channelsFor(evt: WsEvent): WsChannel[] {
  const out: WsChannel[] = [];
  if (GLOBAL_TYPES.has(evt.type)) out.push("global");
  const id = launchIdOf(evt);
  if (id) out.push(launchChannel(id));
  return out;
}

/** Minimal surface of the `ws` WebSocket used by the hub. */
export interface WebSocket {
  readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", fn: (data: { toString(): string }) => void): void;
  on(event: "close" | "error" | "pong", fn: () => void): void;
}

interface Client {
  socket: WebSocket;
  channels: Set<string>;
  alive: boolean;
}

export class WsHub {
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;

  constructor(private ctx: AppContext, private log: FastifyBaseLogger) {}

  get size() {
    return this.clients.size;
  }

  start(statsIntervalMs = 3000) {
    this.unsub = this.ctx.bus.subscribe((evt) => this.broadcast(evt));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.socket.terminate();
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        try {
          c.socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
    this.heartbeat.unref();
    this.statsTimer = setInterval(async () => {
      if (!this.clients.size) return;
      try {
        this.broadcast({ type: "stats.updated", data: await getStatsCached(this.ctx) });
      } catch {
        /* ignore */
      }
    }, statsIntervalMs);
    this.statsTimer.unref();
  }

  stop() {
    this.unsub?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const c of this.clients) {
      try {
        c.socket.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  broadcast(evt: WsEvent) {
    const ts = Math.floor(Date.now() / 1000);
    for (const channel of channelsFor(evt)) {
      let payload: string | null = null;
      for (const c of this.clients) {
        if (!c.channels.has(channel) || c.socket.readyState !== 1) continue;
        payload ??= JSON.stringify({ ...evt, channel, ts } as WsEnvelope);
        c.socket.send(payload);
      }
    }
  }

  private send(c: Client, evt: WsEvent, channel: WsChannel) {
    if (c.socket.readyState !== 1) return;
    c.socket.send(JSON.stringify({ ...evt, channel, ts: Math.floor(Date.now() / 1000) } as WsEnvelope));
  }

  /** Initial snapshot on subscribe so clients render immediately without waiting for the next tick. */
  private async snapshot(c: Client, channel: WsChannel) {
    try {
      if (channel === "global") {
        this.send(c, { type: "stats.updated", data: await getStatsCached(this.ctx) }, "global");
      } else {
        const launch = await this.ctx.store.getLaunch(channel.slice("launch:".length));
        if (launch) this.send(c, { type: "launch.updated", data: launch }, channel);
      }
    } catch {
      /* ignore */
    }
  }

  handle(socket: WebSocket) {
    const client: Client = { socket, channels: new Set(), alive: true };
    this.clients.add(client);
    socket.on("pong", () => (client.alive = true));
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
    socket.on("message", (raw) => {
      client.alive = true;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }
      const parsed = ClientMessageSchema.safeParse(msg);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: "error", error: "invalid message", details: parsed.error.issues.map((i) => i.message) }));
        return;
      }
      const m = parsed.data;
      if (m.op === "ping") {
        socket.send(JSON.stringify({ type: "pong", ts: Math.floor(Date.now() / 1000) }));
      } else if (m.op === "subscribe") {
        for (const ch of m.channels as WsChannel[]) {
          if (!client.channels.has(ch)) {
            client.channels.add(ch);
            void this.snapshot(client, ch);
          }
        }
      } else {
        for (const ch of m.channels) client.channels.delete(ch);
      }
    });
  }
}

export async function registerWs(app: FastifyInstance, hub: WsHub) {
  app.get("/ws", { websocket: true }, (socket) => hub.handle(socket as unknown as WebSocket));
}
