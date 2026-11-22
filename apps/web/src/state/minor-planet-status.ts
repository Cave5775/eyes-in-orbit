import { create } from 'zustand';
import type { MinorPlanetStatus } from '../api/types';

/** What the engine says about the opt-in minor-planet download (pushed as `minorPlanets` messages; see `Api.minorPlanetsStatus`). */
export const useMinorPlanetStatus = create<{ status: MinorPlanetStatus; set(s: MinorPlanetStatus): void }>((set) => ({
  status: { state: 'none' },
  set: (status) => set({ status }),
}));

/** The line shown next to the layer switch and the Download button's label. */
export function describeMinorPlanets(s: MinorPlanetStatus): { text: string; button: string } {
  switch (s.state) {
    case 'downloading':
      return {
        text: s.phase === 'storing' ? 'Saving the orbits in this browser…' : s.phase === 'checking' ? 'Checking for a newer file…'
          : 'Downloading and unpacking about 70 MB from the Minor Planet Center…',
        button: '',
      };
    case 'ready': return { text: `${(s.count ?? 0).toLocaleString('en')} orbits stored in this browser${s.fetchedAt ? `, from ${new Date(s.fetchedAt).toISOString().slice(0, 10)}` : ''}`, button: 'Refresh' };
    case 'failed': return { text: `Download failed: ${s.error ?? 'unknown error'}${s.count ? `; the ${s.count.toLocaleString('en')} stored orbits are kept` : ''}`, button: 'Retry' };
    default: return { text: 'Not downloaded yet (about 70 MB, only when you ask)', button: 'Download' };
  }
}
