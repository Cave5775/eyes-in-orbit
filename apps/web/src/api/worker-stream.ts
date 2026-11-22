import type { ClientMessage } from '@eio/core';
import type { ConnState } from '../state/store';
import type { WorkerEvent } from '../workers/data.protocol';
import type { DataLink } from './data-link';

/**
 * The pushed side of the data worker, with the surface the old `/stream` client had: `start`, `stop` and `setTopics` (only the
 * difference to the current set is sent). There is no connection to lose, so the state is `live` from `start` on and nothing
 * reconnects; `reconnected` is always false.
 */
export class WorkerStream {
  private topics = new Set<string>();
  private off: (() => void) | undefined;

  constructor(
    private link: DataLink,
    private onMessage: (m: WorkerEvent, reconnected: boolean) => void,
    private onState: (s: ConnState) => void,
  ) {}

  start(): void {
    this.off?.();
    this.off = this.link.onEvent((m) => this.onMessage(m, false));
    this.link.send({ kind: 'start' });
    this.onState('live');
    if (this.topics.size) this.send({ op: 'subscribe', topics: [...this.topics] });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    this.link.send({ kind: 'stop' });
  }

  /** Replace the subscription set; only the difference is sent. */
  setTopics(next: Set<string>): void {
    const add = [...next].filter((t) => !this.topics.has(t));
    const del = [...this.topics].filter((t) => !next.has(t));
    this.topics = next;
    if (!this.off) return; // not started: `start` sends the whole set
    if (add.length) this.send({ op: 'subscribe', topics: add });
    if (del.length) this.send({ op: 'unsubscribe', topics: del });
  }

  private send(msg: ClientMessage): void {
    this.link.send({ kind: 'client', msg });
  }
}
