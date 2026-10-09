import {describe, expect, it} from 'vitest';
import {activeExperiments, addDefaultExperiments, DEFAULT_EXPERIMENTS, HEADLESS_EXPERIMENTS} from '../src/store/config.js';

describe('experiments', () => {
  it('turns the measured ones on by default; -name turns one off, others are added', () => {
    expect(activeExperiments({experiments: []})).toEqual(DEFAULT_EXPERIMENTS);
    const on = activeExperiments({experiments: ['-shell-cap', 'keep-going']});
    expect(on).not.toContain('shell-cap');
    expect(on).toContain('keep-going');
    expect(on).toContain('outline-reads');
    expect(activeExperiments({experiments: []})).not.toContain('no-todo'); // interactive keeps the task list
    addDefaultExperiments(HEADLESS_EXPERIMENTS); // what `rein -p` does
    expect(activeExperiments({experiments: []})).toContain('cache-5m');
    expect(activeExperiments({experiments: ['-cache-5m']})).not.toContain('cache-5m');
  });
});
