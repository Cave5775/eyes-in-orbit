import type { ClientMessage, ServerMessage } from '@eio/core';
import type { ConnState } from '../state/store';

const MAX_BACKOFF_MS = 15_000;

/** `/stream` WebSocket with exponential-backoff reconnect and topic re-subscription. */
export class StreamClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private topics = new Set<string>();
  private closed = false;
  private everOpened = false;

  constructor(
    private onMessage: (m: ServerMessage, reconnected: boolean) => void,
    private onState: (s: ConnState) => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Replace the subscription set; only the difference is sent. */
  setTopics(next: Set<string>): void {
    const add = [...next].filter((t) => !this.topics.has(t));
    const del = [...this.topics].filter((t) => !next.has(t));
    this.topics = next;
    if (add.length) this.send({ op: 'subscribe', topics: add });
    if (del.length) this.send({ op: 'unsubscribe', topics: del });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/stream`);
    this.ws = ws;
    let reconnect = false;
    ws.onopen = () => {
      reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.onState('live');
      if (this.topics.size) this.send({ op: 'subscribe', topics: [...this.topics] });
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMessage, reconnect);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.onState('reconnecting');
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}
