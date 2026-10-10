/** Files with the same hand edit before the agent is pointed at a codemod. */
export const NUDGE_AT = 4;

/**
 * The `codemod-nudge` experiment: the same text change (what an edit replaces, minus the context
 * around it) made by hand in several files within one request is a job for a script, which is
 * faster, consistent and reviewable, so the agent is told so, once per change.
 */
export class RepeatEdits {
  private files = new Map<string, Set<string>>();
  private nudged = new Set<string>();

  reset(): void {
    this.files.clear();
    this.nudged.clear();
  }

  /** After a successful edit: a note when this change has now been made by hand in NUDGE_AT files. */
  after(args: any, file: string): string | undefined {
    const edits: {old_string?: unknown; new_string?: unknown}[] = Array.isArray(args?.edits) ? args.edits : [args];
    for (const e of edits) {
      const key = shape(e?.old_string, e?.new_string);
      if (!key) continue;
      const set = this.files.get(key) ?? new Set<string>();
      set.add(file);
      this.files.set(key, set);
      if (set.size >= NUDGE_AT && !this.nudged.has(key)) {
        this.nudged.add(key);
        const [from, to] = key.split('\u0000');
        return `You've now made the same change by hand in ${set.size} files (\`${from}\` → \`${to}\`). If more files need it, stop editing one by one: write a codemod (jscodeshift or ts-morph for JS/TS, OpenRewrite for Java, Comby for any language, or a small script), run it on all of them at once, then review its diff.`;
      }
    }
    return undefined;
  }
}

/** The part an edit actually changes: old and new with their shared start and end removed. */
export function shape(oldS: unknown, newS: unknown): string | undefined {
  if (typeof oldS !== 'string' || typeof newS !== 'string' || oldS === newS) return undefined;
  let a = 0;
  while (a < oldS.length && a < newS.length && oldS[a] === newS[a]) a++;
  let b = 0;
  while (b < oldS.length - a && b < newS.length - a && oldS[oldS.length - 1 - b] === newS[newS.length - 1 - b]) b++;
  // Widen to whole tokens, so `fetchJson(` → `http.get(` rather than `fetchJs` → `http.ge`.
  while (a > 0 && /\w/.test(oldS[a - 1]!)) a--;
  while (b > 0 && /\w/.test(oldS[oldS.length - b]!)) b--;
  const from = oldS.slice(a, oldS.length - b).trim();
  const to = newS.slice(a, newS.length - b).trim();
  if (!from || from.length > 120 || to.length > 120 || from.split('\n').length > 3) return undefined;
  return `${from}\u0000${to}`;
}
