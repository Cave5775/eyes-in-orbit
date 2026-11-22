import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CredentialsSection } from '../src/ui/CredentialsSection';

describe('credentials section', () => {
  it('warns that keys are stored unencrypted in this browser and may go through the relay', () => {
    const html = renderToStaticMarkup(createElement(CredentialsSection, { connector: 'spacetrack' }));
    expect(html).toContain('data-testid="keys-warning"');
    expect(html).toMatch(/unencrypted in this browser profile/);
    expect(html).toMatch(/extensions and scripts running on this site/);
    expect(html).toMatch(/relay/);
    expect(html).not.toMatch(/\.env|local server/);
  });
});
