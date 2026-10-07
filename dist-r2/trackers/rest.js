/**
 * Linear, GitLab, Azure DevOps and Jira over their HTTP APIs (built against their current API
 * references; the tokens come from the vault). Each lists issues assigned to the token's user
 * that carry the label, and comments back.
 */
const need = (v, what) => {
    if (!v)
        throw new Error(`${what} isn't set`);
    return v;
};
async function json(res, what) {
    const text = await res.text();
    if (!res.ok)
        throw new Error(`${what}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    return (text ? JSON.parse(text) : {});
}
// ── Linear (GraphQL) ────────────────────────────────────────────────────────────────────────────
export function linearTracker(cfg, secrets, f = fetch) {
    const key = need(secrets.LINEAR_API_KEY, 'LINEAR_API_KEY (in the vault: /vault set LINEAR_API_KEY)');
    const label = cfg.label || 'rein';
    const gql = async (query, variables) => {
        const r = await json(await f('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) }), 'Linear');
        if (r.errors?.length)
            throw new Error(`Linear: ${r.errors[0].extensions?.code === 'RATELIMITED' ? 'rate limited' : r.errors[0].message}`);
        return r.data;
    };
    return {
        kind: 'linear',
        label,
        async list() {
            const d = await gql(`query($label:String!){ issues(first:50, filter:{ assignee:{isMe:{eq:true}}, labels:{some:{name:{eqIgnoreCase:$label}}}, state:{type:{nin:["completed","canceled","duplicate"]}} }){ nodes{ id identifier title description url team{ key } } } }`, { label });
            return d.issues.nodes
                .filter((i) => !cfg.project || i.team?.key === cfg.project || i.identifier.startsWith(`${cfg.project}-`))
                .map((i) => ({ key: `linear:${i.id}`, ref: i.identifier, title: i.title, body: i.description ?? '', url: i.url, handle: i.id }));
        },
        async comment(issue, markdown) {
            await gql(`mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }`, { i: { issueId: issue.handle, body: markdown } });
        },
    };
}
// ── GitLab (REST v4) ────────────────────────────────────────────────────────────────────────────
export function gitlabTracker(cfg, secrets, f = fetch) {
    const token = need(secrets.GITLAB_TOKEN, 'GITLAB_TOKEN (in the vault: /vault set GITLAB_TOKEN)');
    const base = `${(cfg.url || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`;
    const label = cfg.label || 'rein';
    const headers = { 'private-token': token, 'content-type': 'application/json' };
    return {
        kind: 'gitlab',
        label,
        async list() {
            const q = new URLSearchParams({ scope: 'assigned_to_me', labels: label, state: 'opened', per_page: '50' });
            const path = cfg.project ? `/projects/${encodeURIComponent(cfg.project)}/issues` : '/issues';
            const issues = await json(await f(`${base}${path}?${q}`, { headers }), 'GitLab');
            return issues.map((i) => ({ key: `gitlab:${i.id}`, ref: i.references?.full ?? `#${i.iid}`, title: i.title, body: i.description ?? '', url: i.web_url, handle: { project: i.project_id, iid: i.iid } }));
        },
        async comment(issue, markdown) {
            const h = issue.handle;
            await json(await f(`${base}/projects/${h.project}/issues/${h.iid}/notes`, { method: 'POST', headers, body: JSON.stringify({ body: markdown }) }), 'GitLab comment');
        },
    };
}
// ── Azure DevOps (Boards) ─────────────────────────────────────────────────────────────────────────
/**
 * A work item's HTML description as plain text for the model: entities decoded first, then tags
 * removed until none are left (so a tag hidden inside another can't survive one pass).
 */
export function htmlToText(html) {
    let text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h\d)>/gi, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    for (let prev = ''; prev !== text;) {
        prev = text;
        text = text.replace(/<[^<>]*>/g, '');
    }
    return text.replace(/[<>]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function azureTracker(cfg, secrets, f = fetch) {
    const pat = need(secrets.AZURE_DEVOPS_PAT, 'AZURE_DEVOPS_PAT (in the vault: /vault set AZURE_DEVOPS_PAT)');
    const [org, project] = need(cfg.project, 'project ("org/project")').split('/');
    if (!org || !project)
        throw new Error('azure: set project to "org/project"');
    const base = `${(cfg.url || 'https://dev.azure.com').replace(/\/+$/, '')}/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
    const label = cfg.label || 'rein';
    const headers = { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'content-type': 'application/json' };
    return {
        kind: 'azure',
        label,
        async list() {
            const tag = label.replace(/'/g, "''");
            const q = await json(await f(`${base}/_apis/wit/wiql?api-version=7.1&$top=50`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.Tags] CONTAINS '${tag}' AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') ORDER BY [System.ChangedDate] DESC` }),
            }), 'Azure DevOps query');
            const ids = (q.workItems ?? []).map((w) => w.id);
            if (!ids.length)
                return [];
            const items = await json(await f(`${base}/_apis/wit/workitemsbatch?api-version=7.1`, { method: 'POST', headers, body: JSON.stringify({ ids, fields: ['System.Id', 'System.Title', 'System.Description', 'System.Tags'], errorPolicy: 'omit' }) }), 'Azure DevOps work items');
            return items.value
                .filter((w) => String(w.fields['System.Tags'] ?? '').split(';').map((t) => t.trim().toLowerCase()).includes(label.toLowerCase())) // CONTAINS is a substring match
                .map((w) => ({ key: `azure:${org}/${w.id}`, ref: `#${w.id}`, title: String(w.fields['System.Title'] ?? ''), body: htmlToText(String(w.fields['System.Description'] ?? '')), url: `${base}/_workitems/edit/${w.id}`, handle: w.id }));
        },
        async comment(issue, markdown) {
            // Markdown comments are a preview API; fall back to the stable one (HTML) if it's refused.
            const md = await f(`${base}/_apis/wit/workItems/${issue.handle}/comments?format=markdown&api-version=7.2-preview.4`, { method: 'POST', headers, body: JSON.stringify({ text: markdown }) });
            if (md.ok)
                return;
            const html = escapeHtml(markdown).replace(/\n/g, '<br>');
            await json(await f(`${base}/_apis/wit/workItems/${issue.handle}/comments?api-version=7.1-preview.4`, { method: 'POST', headers, body: JSON.stringify({ text: html }) }), 'Azure DevOps comment');
        },
    };
}
const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'listItem', 'blockquote', 'tableRow', 'panel', 'rule']);
export function adfToText(node) {
    if (!node)
        return '';
    if (node.type === 'text')
        return node.text ?? '';
    if (node.type === 'hardBreak')
        return '\n';
    if (node.type === 'mention' || node.type === 'emoji')
        return node.attrs?.text ?? '';
    const inner = (node.content ?? []).map(adfToText).join('');
    return BLOCKS.has(node.type) ? `${inner}\n\n` : inner;
}
/** Plain text as ADF: paragraphs on blank lines, hard breaks inside them. */
export function textToAdf(text) {
    return {
        type: 'doc',
        // @ts-expect-error ADF's doc carries a version
        version: 1,
        content: text.split(/\n{2,}/).map((p) => {
            const lines = p.split('\n');
            const content = [];
            lines.forEach((l, i) => {
                if (i)
                    content.push({ type: 'hardBreak' });
                if (l)
                    content.push({ type: 'text', text: l });
            });
            return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
        }),
    };
}
export function jiraTracker(cfg, secrets, f = fetch) {
    const token = need(secrets.JIRA_API_TOKEN, 'JIRA_API_TOKEN (in the vault: /vault set JIRA_API_TOKEN)');
    const email = need(cfg.email, 'email (the Atlassian account the token belongs to)');
    const site = need(cfg.url, 'url (https://you.atlassian.net)').replace(/\/+$/, '');
    const label = cfg.label || 'rein';
    const headers = { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json' };
    const quote = (s) => `"${s.replace(/["\\]/g, '\\$&')}"`;
    return {
        kind: 'jira',
        label,
        async list() {
            const jql = `assignee = currentUser() AND labels = ${quote(label)} AND statusCategory != Done${cfg.project ? ` AND project = ${quote(cfg.project)}` : ''} ORDER BY updated DESC`;
            const r = await json(await f(`${site}/rest/api/3/search/jql`, { method: 'POST', headers, body: JSON.stringify({ jql, fields: ['summary', 'description'], maxResults: 50 }) }), 'Jira search');
            return (r.issues ?? []).map((i) => ({ key: `jira:${i.id}`, ref: i.key, title: i.fields.summary ?? '', body: adfToText(i.fields.description).trim(), url: `${site}/browse/${i.key}`, handle: i.key }));
        },
        async comment(issue, markdown) {
            await json(await f(`${site}/rest/api/3/issue/${encodeURIComponent(String(issue.handle))}/comment`, { method: 'POST', headers, body: JSON.stringify({ body: textToAdf(markdown) }) }), 'Jira comment');
        },
    };
}
