/** A tiny typed event emitter (the Hub's `node:events` replacement). Listener errors propagate to the emitter, as in Node. */
export class Emitter<Events extends { [K in keyof Events]: unknown }> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return this;
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): this {
    this.listeners.get(event)?.delete(fn as (payload: never) => void);
    return this;
  }

  /** Call the listeners registered now, in registration order; returns whether there were any. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): boolean {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const fn of [...set]) (fn as (p: Events[K]) => void)(payload);
    return true;
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
