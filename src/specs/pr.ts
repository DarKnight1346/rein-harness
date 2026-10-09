/** The /pr digest's "Specs and plans" section: the spec and plan files a branch changes, so they're reviewed with it. */
export function specSection(files: string[]): string {
  const specs = [...new Set(files.map((f) => f.match(/^\.rein\/specs\/([^/]+)\//)?.[1]).filter((s): s is string => !!s))];
  const plans = files.filter((f) => f.startsWith('.rein/plans/'));
  return [
    '## Specs and plans',
    ...specs.map((s) => `- Spec \`${s}\`: \`.rein/specs/${s}/\` (requirements, design, tasks${files.includes(`.rein/specs/${s}/trace.md`) ? '; `trace.md` links each requirement to the code' : ''})`),
    ...plans.map((p) => `- Plan \`${p}\``),
  ].join('\n');
}
