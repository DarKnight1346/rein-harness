import {describe, expect, it} from 'vitest';
import {CHOICE_TABS, TAB_TITLES} from '../src/ui/ConfigureScreen.js';
import {keyInfo} from '../src/store/configKeys.js';

describe('/settings tabs', () => {
  it('fits in seven tabs, with every grouped setting a real config key', () => {
    expect(TAB_TITLES).toEqual(['Status line', 'Sidebar', 'General', 'Agents', 'Accounts', 'Safety', 'Advanced']);
    for (const d of CHOICE_TABS) {
      expect(keyInfo(d.key), d.key).toBeDefined();
      expect(d.choices.length, d.key).toBeGreaterThan(1);
    }
    for (const g of ['General', 'Agents', 'Accounts', 'Safety']) expect(CHOICE_TABS.some((d) => d.group === g), g).toBe(true);
  });
});
