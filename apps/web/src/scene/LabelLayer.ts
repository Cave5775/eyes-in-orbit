/** What the layer draws: a box with its top-left corner at (x, y) CSS px inside the host. */
export interface LabelItem {
  id: string;
  text: string;
  x: number;
  y: number;
  /** 0..1, default 1 */
  opacity?: number;
  /** extra CSS class (`cls` of the planner, `l-selected` ...) */
  cls?: string;
}

interface Node {
  el: HTMLDivElement;
  tx: number;
  ty: number;
  op: number;
  cls: string;
  text: string;
  tint: string;
  shown: boolean;
}

/**
 * Absolutely positioned DOM labels over the canvas. Nodes are pooled and keyed by label id, so a label keeps its element
 * from frame to frame and only the properties that changed are written (no per-frame DOM churn, no layout: transforms
 * and opacity only). Used for the object labels (scene/SceneController.ts via lib/labels.ts) and the path phase labels.
 */
export class LabelLayer {
  private live = new Map<string, Node>();
  private next = new Map<string, Node>();
  private free: Node[] = [];

  /** `tintOf` gives a label's colour (a CSS colour, e.g. `var(--c-debris)`) from its id; it is written as `--tint` when it changes */
  constructor(private readonly host: HTMLElement, private readonly baseClass: string, private readonly tintOf?: (id: string) => string | undefined) {}

  /** Show the first `n` of `items`; everything shown before and not in them is hidden. */
  update(items: readonly LabelItem[], n: number): void {
    for (let i = 0; i < n; i++) {
      const l = items[i];
      let node = this.live.get(l.id);
      if (node) this.live.delete(l.id);
      else node = this.free.pop() ?? this.create();
      this.next.set(l.id, node);
      const tx = Math.round(l.x), ty = Math.round(l.y);
      if (node.tx !== tx || node.ty !== ty) {
        node.tx = tx;
        node.ty = ty;
        node.el.style.transform = `translate(${tx}px, ${ty}px)`;
      }
      const op = Math.round((l.opacity ?? 1) * 100) / 100;
      if (node.op !== op) {
        node.op = op;
        node.el.style.opacity = String(op);
      }
      const cls = l.cls ?? '';
      if (node.cls !== cls) {
        node.cls = cls;
        node.el.className = cls ? `${this.baseClass} ${cls}` : this.baseClass;
      }
      if (this.tintOf) {
        const tint = this.tintOf(l.id) ?? '';
        if (node.tint !== tint) {
          node.tint = tint;
          node.el.style.setProperty('--tint', tint);
        }
      }
      if (node.text !== l.text) {
        node.text = l.text;
        node.el.textContent = l.text;
      }
      if (!node.shown) {
        node.shown = true;
        node.el.style.display = 'block';
      }
    }
    for (const node of this.live.values()) {
      node.shown = false;
      node.el.style.display = 'none';
      this.free.push(node);
    }
    this.live.clear();
    [this.live, this.next] = [this.next, this.live];
  }

  /** Number of labels currently shown. */
  get size(): number {
    return this.live.size;
  }

  dispose(): void {
    for (const node of [...this.live.values(), ...this.free]) node.el.remove();
    this.live.clear();
    this.free.length = 0;
  }

  private create(): Node {
    const el = document.createElement('div');
    el.className = this.baseClass;
    el.style.display = 'none';
    this.host.appendChild(el);
    return { el, tx: NaN, ty: NaN, op: NaN, cls: '', text: '', tint: '', shown: false };
  }
}
