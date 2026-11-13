import { create } from 'zustand';

interface DataStreamsState {
  open: boolean;
  /** the feed shown on the right; null until one is chosen (the popup then picks the first) */
  feedId: string | null;
  /** open the popup, optionally on one feed (the health indicator does this for the row that was clicked) */
  openOn(feedId?: string): void;
  showFeed(feedId: string): void;
  close(): void;
  toggle(): void;
}

/** Whether the Data streams popup (ui/DataStreams.tsx) is open and which feed it shows. Not persisted. */
export const useDataStreams = create<DataStreamsState>((set) => ({
  open: false,
  feedId: null,
  openOn: (feedId) => set((s) => ({ open: true, feedId: feedId ?? s.feedId })),
  showFeed: (feedId) => set({ feedId }),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
