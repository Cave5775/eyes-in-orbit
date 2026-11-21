import { describe, expect, it } from 'vitest';
import { engineConfig } from '../../../src/engine/config';
import { notam, satnogs, webcastOcr } from '../../../src/engine/connectors/stubs';

describe('placeholder connectors', () => {
  it('report a fixed note, never run, and mention whether their setting is present', () => {
    for (const c of [satnogs, notam, webcastOcr]) {
      expect(c.run).toBeUndefined();
      expect(c.stub!(engineConfig())).toMatch(/^Not implemented/);
    }
    expect(satnogs.stub!(engineConfig())).toMatch(/is optional and not set/);
    expect(satnogs.stub!(engineConfig({ satnogsToken: 't' }))).toMatch(/is set/);
    expect(webcastOcr.stub!(engineConfig({ webcastUrl: 'u' }))).toMatch(/WEBCAST_URL is set/);
  });
});
