import { run } from '../util/proc.js';
/** GitHub Issues through the `gh` CLI you're logged into: Rein never handles a token. */
export function githubTracker(cfg, gh = 'gh') {
    if (!cfg.project || !/^[\w.-]+\/[\w.-]+$/.test(cfg.project))
        throw new Error('github: set project to "owner/repo"');
    const repo = cfg.project;
    const label = cfg.label || 'rein';
    const call = async (args, input) => {
        const r = await run(gh, args, { timeoutMs: 30_000, input });
        if (r.code !== 0)
            throw new Error(`gh ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
        return r.stdout;
    };
    return {
        kind: 'github',
        label,
        async list() {
            const out = await call(['issue', 'list', '--repo', repo, '--assignee', '@me', '--label', label, '--state', 'open', '--limit', '20', '--json', 'number,title,body,url']);
            return JSON.parse(out).map((i) => ({ key: `github:${repo}#${i.number}`, ref: `#${i.number}`, title: i.title, body: i.body ?? '', url: i.url, handle: i.number }));
        },
        async comment(issue, markdown) {
            await call(['issue', 'comment', String(issue.handle), '--repo', repo, '--body-file', '-'], markdown);
        },
    };
}
