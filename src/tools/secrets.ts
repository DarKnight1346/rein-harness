/**
 * Secret scanning (config `secretScan`): credentials an agent is about to write into a file, by their
 * well-known shapes, plus quoted values assigned to secret-looking names that look random enough to
 * be real. Also used to mask them in saved conversations.
 */
export type SecretHit = {kind: string; match: string};

const PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/** `password = "…"`, `apiKey: '…'`: the quoted value, if it's long and random enough to be a real one. */
const ASSIGNED = /\b([A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\b\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi;

/** Shannon entropy in bits per character: real keys sit around 4+, words and placeholders well below. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|your[_-]|changeme|example|placeholder|dummy|test|fake|redacted)/i;

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({kind, match: m[0]});
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const value = m[2]!;
    // Words only (password-input-field) aren't keys: real ones mix in digits or capitals.
    if (PLACEHOLDER.test(value) || /^[a-z_.-]+$/.test(value) || /^[A-Z_.-]+$/.test(value) || entropy(value) < 3.5 || hits.some((h) => h.match.includes(value) || value.includes(h.match))) continue;
    hits.push({kind: `secret in ${m[1]}`, match: value});
  }
  return hits;
}

/** What a write or edit adds: text in the new content that wasn't in the old (so moving a secret isn't flagged as new). */
export function addedText(tool: string, args: any): string {
  if (tool === 'write') return String(args?.content ?? '');
  if (tool !== 'edit') return '';
  const edits = Array.isArray(args?.edits) ? args.edits : [args];
  return edits.map((e: any) => {
    const added = String(e?.new_string ?? '');
    const old = String(e?.old_string ?? '');
    return added.split('\n').filter((l) => !old.includes(l)).join('\n');
  }).join('\n');
}

/** Mask secrets in text (saved conversations): keep the first 4 characters so you can tell which key it was. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const h of findSecrets(text)) if (h.kind !== 'private key') out = out.split(h.match).join(`${h.match.slice(0, 4)}…[secret: ${h.kind}]`);
  return out;
}

/** The agent's note (warn) or the refusal (block) for secrets an edit adds. */
export function secretMessage(hits: SecretHit[], file: string, block: boolean): string {
  const what = [...new Set(hits.map((h) => h.kind))].join(', ');
  return block
    ? `blocked: this change would add what looks like a credential (${what}) to ${file}. Read it from an environment variable or a secrets manager instead, or ask the user to add it themselves.`
    : `<secret_scan>This change adds what looks like a credential (${what}) to ${file}. If it's real, move it to an environment variable or a secrets manager and keep it out of the repo; if it's a fake for tests, say so in your reply.</secret_scan>`;
}
