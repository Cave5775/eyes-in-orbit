import { describe, expect, it, vi } from 'vitest';
import { beginStream } from '../src/lib/stream-start';

describe('beginStream', () => {
  it('starts the stream after the initial load and then loads again from the cursor, so nothing in between is lost', async () => {
    const order: string[] = [];
    let release!: () => void;
    const initial = new Promise<void>((r) => (release = r)).then(() => void order.push('initial load done'));
    const done = beginStream(initial, () => order.push('stream start'), async () => void order.push('incremental load'));
    expect(order).toEqual([]);
    release();
    await done;
    expect(order).toEqual(['initial load done', 'stream start', 'incremental load']);
  });

  it('a failing incremental load is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(beginStream(Promise.resolve(), () => undefined, () => Promise.reject(new Error('x')))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
