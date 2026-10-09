import {describe, expect, it} from 'vitest';
import {linkedBody, type RepoPr} from '../src/pr/linked.js';

const pr = (repo: string, n: number, body = ''): RepoPr => ({repo, dir: `/ws/${repo}`, number: n, url: `https://github.com/acme/${repo}/pull/${n}`, title: `Orders v2 in ${repo}`, state: 'OPEN', body});

describe('linked PRs', () => {
  it('adds a related-PRs section listing the other repos, and replaces it on later runs', () => {
    const all = [pr('api', 12, 'Adds the v2 endpoint.'), pr('web', 40), pr('billing', 7)];
    const once = linkedBody(all[0]!.body, all[0]!, all);
    expect(once).toBe(
      'Adds the v2 endpoint.\n\n<!-- rein:linked-prs -->\n### Related pull requests\n\n- web: https://github.com/acme/web/pull/40 (Orders v2 in web)\n- billing: https://github.com/acme/billing/pull/7 (Orders v2 in billing)\n\n_Merge together: these change the same feature across repos._\n<!-- /rein:linked-prs -->\n',
    );
    const again = linkedBody(once, all[0]!, all.slice(0, 2));
    expect(again.match(/<!-- rein:linked-prs -->/g)).toHaveLength(1);
    expect(again).not.toMatch(/billing/);
    expect(linkedBody('', all[1]!, all)).toMatch(/^<!-- rein:linked-prs -->/);
  });
});
