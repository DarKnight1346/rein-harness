import {describe, expect, it} from 'vitest';
import {compareVersions} from '../src/commands/update.js';

describe('self-update versions', () => {
  it('compares x.y.z with pre-releases', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('self-update from npm', () => {
  it('detects install kind from the install root', async () => {
    const {mkdtempSync, mkdirSync} = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const {installKind} = await import('../src/commands/update.js');
    const base = mkdtempSync(path.join(os.tmpdir(), 'rein-kind-'));
    const npmRoot = path.join(base, 'lib', 'node_modules', 'rein-harness');
    mkdirSync(npmRoot, {recursive: true});
    process.env.REIN_INSTALL_ROOT = npmRoot;
    expect(installKind()).toBe('npm');
    const checkout = path.join(base, 'src-checkout');
    mkdirSync(path.join(checkout, '.git'), {recursive: true});
    process.env.REIN_INSTALL_ROOT = checkout;
    expect(installKind()).toBe('checkout');
    delete process.env.REIN_INSTALL_ROOT;
  });
});
