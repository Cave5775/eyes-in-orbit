import { BodyRegistry, defaultBodies } from './bodies';
import { convert } from './frames';
import { providerFromSpec } from './providers';
import type { EntityRecord, FrameId, ProviderContext, StateProvider, StateVector } from './types';

/**
 * Holds entities and their live providers, resolves parent references (relative providers)
 * and answers `stateOf(id, t)` in any frame. Shared by server and client.
 */
export class EntityGraph implements ProviderContext {
  private records = new Map<string, EntityRecord>();
  private providers = new Map<string, StateProvider>();
  private resolving = new Set<string>();

  constructor(private bodies: BodyRegistry = defaultBodies) {}

  upsert(rec: EntityRecord): void {
    const prev = this.records.get(rec.id);
    this.records.set(rec.id, rec);
    if (rec.provider) {
      // avoid rebuilding when the spec object is unchanged
      if (!prev || prev.provider !== rec.provider) this.providers.set(rec.id, providerFromSpec(rec.provider));
    } else this.providers.delete(rec.id);
  }

  remove(id: string): void {
    this.records.delete(id);
    this.providers.delete(id);
  }

  get(id: string): EntityRecord | undefined {
    return this.records.get(id);
  }

  provider(id: string): StateProvider | undefined {
    return this.providers.get(id);
  }

  all(): EntityRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }

  stateOf = (id: string, t: number): StateVector | null => {
    const p = this.providers.get(id);
    if (!p) return null;
    if (this.resolving.has(id)) return null; // cycle guard
    this.resolving.add(id);
    try {
      return p.stateAt(t, this);
    } finally {
      this.resolving.delete(id);
    }
  };

  stateIn(id: string, t: number, frame: FrameId): StateVector | null {
    const s = this.stateOf(id, t);
    return s ? convert(s, frame, t, this.bodies) : null;
  }
}
