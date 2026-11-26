"use client";
/**
 * Singleton WebSocket client for `/ws` with exponential-backoff reconnect, channel
 * ref-counting and automatic resubscribe. Silent when the API is down (demo mode).
 */
import type { WsChannel, WsClientMessage, WsEnvelope } from "@sealed/shared";
import { WS_URL } from "./config";

type Listener = (msg: WsEnvelope) => void;

class LiveSocket {
  private ws: WebSocket | null = null;
  private channels = new Map<WsChannel, number>();
  private listeners = new Set<Listener>();
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  connected = false;

  private ensure() {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
    if (this.ws || this.reconnectTimer) return;
    this.closedByUs = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      const chans = [...this.channels.keys()];
      if (chans.length) this.send({ op: "subscribe", channels: chans });
      this.pingTimer = setInterval(() => this.send({ op: "ping" }), 25_000);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsEnvelope | { type: "pong" };
        if (msg.type === "pong") return;
        for (const l of this.listeners) l(msg as WsEnvelope);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onerror = () => {
      /* onclose handles reconnect; swallow to keep console clean */
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.closedByUs && this.channels.size > 0) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 1000 * 2 ** this.retry) + Math.random() * 500;
    this.retry++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensure();
    }, delay);
  }

  private send(m: WsClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  subscribe(chans: WsChannel[], fn: Listener): () => void {
    const added: WsChannel[] = [];
    for (const c of chans) {
      const n = this.channels.get(c) ?? 0;
      this.channels.set(c, n + 1);
      if (n === 0) added.push(c);
    }
    this.listeners.add(fn);
    this.ensure();
    if (added.length) this.send({ op: "subscribe", channels: added });
    return () => {
      this.listeners.delete(fn);
      const removed: WsChannel[] = [];
      for (const c of chans) {
        const n = (this.channels.get(c) ?? 1) - 1;
        if (n <= 0) {
          this.channels.delete(c);
          removed.push(c);
        } else this.channels.set(c, n);
      }
      if (removed.length) this.send({ op: "unsubscribe", channels: removed });
      if (this.channels.size === 0) {
        this.closedByUs = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.ws?.close();
      }
    };
  }
}

let socket: LiveSocket | null = null;
export function liveSocket(): LiveSocket {
  if (!socket) socket = new LiveSocket();
  return socket;
}
