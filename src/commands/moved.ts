/**
 * Commands and skills that moved out of Rein into marketplace items, which ship their own code.
 * Typing one says which item brings it back.
 */
const ITEMS: [item: string, name: string, commands: string[]][] = [
  ['contracts', 'Contracts and migrations', ['contracts', 'migrations', 'deadcode', 'flags', 'codemod', 'expand-contract', 'contract-tests', 'migrate:java21', 'migrate:python3', 'migrate:react-hooks']],
  ['system', 'Multi-repo systems', ['services', 'symbols', 'refs', 'impact', 'changeset', 'codemap', 'stack']],
  ['quality', 'Test quality', ['affected', 'build', 'coverage', 'mutate']],
  ['tour', 'Onboarding tours', ['tour']],
];
export const MOVED: Record<string, {item: string; name: string}> = Object.fromEntries(ITEMS.flatMap(([item, name, commands]) => commands.map((c) => [c, {item, name}])));

export const movedMessage = (name: string) => {
  const m = MOVED[name];
  return m ? `/${name} moved to the marketplace, in the ${m.name} item: /marketplace install ${m.item} brings it back.` : undefined;
};
