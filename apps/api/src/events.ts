import { EventEmitter } from "node:events";
import type { WsEvent } from "@sealed/shared";

/** In-process bus: stores and workers publish WsEvents, the WS hub routes them to channels. */
export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(100);
  }
  publish(evt: WsEvent): void {
    this.ee.emit("event", evt);
  }
  subscribe(fn: (evt: WsEvent) => void): () => void {
    this.ee.on("event", fn);
    return () => this.ee.off("event", fn);
  }
}
