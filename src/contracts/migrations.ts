import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Schema migration safety: migrations that lock big tables, that need a backfill they don't have,
 * that can't be undone, or that break the code still running during a deploy. SQL (Postgres first,
 * MySQL where it differs), Rails, Django and Alembic migrations, read as text.
 */
export type Risk = 'lock' | 'backfill' | 'irreversible' | 'breaks-running-code';
export type Finding = {file: string; line: number; risk: Risk; what: string; instead: string};

const MIGRATION = /(?:^|\/)(?:migrations?|migrate|alembic\/versions|db\/migrate|flyway|changelog)\/[^/]+\.(?:sql|rb|py|js|ts)$|(?:^|\/)V\d+[\w.]*__\w+\.sql$|\.(?:up|down)\.sql$/i;
export const isMigration = (file: string) => MIGRATION.test(file.replace(/\\/g, '/')) && !/__init__\.py$/.test(file);

type Rule = {re: RegExp; risk: Risk; what: string; instead: string; unless?: RegExp};

const SQL: Rule[] = [
  {re: /\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?\w+\s+[\w() ,]+?\bnot\s+null\b/i, unless: /\bdefault\b/i, risk: 'backfill', what: 'adds a NOT NULL column without a default: fails on a table that has rows', instead: 'add it nullable (or with a default), backfill in batches, then SET NOT NULL'},
  {re: /\badd\s+(?:column\s+)?\w+\s+[^,;]*\bdefault\s+(?:now\(\)|current_timestamp|random\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\)|clock_timestamp\(\))/i, risk: 'lock', what: 'adds a column with a volatile default: Postgres rewrites the whole table under an exclusive lock', instead: 'add the column without a default (or a constant one), then backfill'},
  {re: /\bcreate\s+(?:unique\s+)?index\b(?!\s+concurrently)/i, unless: /\balgorithm\s*=\s*inplace|\block\s*=\s*none/i, risk: 'lock', what: 'creates an index without CONCURRENTLY: writes to the table block until it is built', instead: 'CREATE INDEX CONCURRENTLY (outside a transaction); in MySQL, ALGORITHM=INPLACE, LOCK=NONE'},
  {re: /\balter\s+column\s+\w+\s+(?:set\s+data\s+)?type\b|\bmodify\s+(?:column\s+)?\w+\s+\w+/i, risk: 'lock', what: "changes a column's type: rewrites the table under an exclusive lock, and running code may not handle the new type", instead: 'add a new column of the new type, dual-write and backfill, then switch (expand/contract)'},
  {re: /\balter\s+column\s+\w+\s+set\s+not\s+null\b/i, risk: 'lock', what: 'SET NOT NULL scans the whole table under an exclusive lock', instead: 'ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL (Postgres 12+ skips the scan)'},
  {re: /\badd\s+(?:constraint\s+\w+\s+)?(?:foreign\s+key|check)\b/i, unless: /\bnot\s+valid\b/i, risk: 'lock', what: 'adds a foreign key or check constraint that is validated at once: scans the table while holding locks', instead: 'add it NOT VALID, then VALIDATE CONSTRAINT in a separate step'},
  {re: /\bdrop\s+(?:column|table)\b/i, risk: 'irreversible', what: 'drops a column or table: the data is gone, and code still running that reads it fails', instead: 'stop reading and writing it first (deploy that), keep a backup, then drop it in a later migration'},
  {re: /\btruncate\b/i, risk: 'irreversible', what: 'TRUNCATE deletes every row', instead: 'make sure this is meant; back the data up first'},
  {re: /\brename\s+(?:column\s+\w+\s+)?to\b|\brename\s+column\b|\brename\s+table\b/i, risk: 'breaks-running-code', what: 'renames a column or table: code still running from the previous deploy breaks at once', instead: 'add the new name, dual-write, move readers, then drop the old one (expand/contract), or use a view'},
  {re: /^\s*(?:update|delete\s+from)\s+\w+(?![^;]*\bwhere\b)/im, risk: 'backfill', what: 'updates or deletes every row inside the migration: one long transaction holding row locks', instead: 'backfill in batches in a separate job (resumable, throttled), not in the schema migration'},
  {re: /\block\s+table\b|\bvacuum\s+full\b|\bcluster\s+\w+/i, risk: 'lock', what: 'takes an exclusive lock on the whole table', instead: 'avoid it on a live table, or schedule it for a maintenance window'},
];

const RAILS: Rule[] = [
  {re: /\badd_column\b[^\n]*\bnull:\s*false\b/, unless: /\bdefault:/, risk: 'backfill', what: 'add_column with null: false and no default: fails on a table that has rows', instead: 'add it nullable, backfill in batches, then change_column_null … false'},
  {re: /\badd_index\b/, unless: /algorithm:\s*:concurrently/, risk: 'lock', what: 'add_index without algorithm: :concurrently blocks writes while it builds', instead: 'add_index …, algorithm: :concurrently (with disable_ddl_transaction!)'},
  {re: /\bchange_column\b(?!_null|_default)/, risk: 'lock', what: "change_column rewrites the table, and running code may not handle the new type", instead: 'add a new column, dual-write and backfill, then switch'},
  {re: /\bchange_column_null\b[^\n]*\bfalse\b/, risk: 'lock', what: 'change_column_null … false scans the table under a lock', instead: 'add a NOT VALID check constraint, validate it, then change_column_null'},
  {re: /\badd_foreign_key\b/, unless: /validate:\s*false/, risk: 'lock', what: 'add_foreign_key validates at once, scanning both tables under locks', instead: 'add_foreign_key …, validate: false, then validate_foreign_key in a later migration'},
  {re: /\b(?:remove_column|drop_table)\b/, risk: 'irreversible', what: 'removes a column or table: data is lost, and running code that reads it fails', instead: 'add it to ignored_columns and deploy first; drop it later'},
  {re: /\b(?:rename_column|rename_table)\b/, risk: 'breaks-running-code', what: 'renames a column or table: code still running from the previous deploy breaks', instead: 'expand/contract: a new column, dual-write, move readers, drop the old'},
];

const DJANGO: Rule[] = [
  {re: /migrations\.AddField\([\s\S]*?\)\s*,?\s*\n/, unless: /null\s*=\s*True|default\s*=|ManyToMany/, risk: 'backfill', what: 'AddField without null=True or a default: fails (or locks the table) on existing rows', instead: 'add it with null=True, backfill, then a later AlterField to null=False'},
  {re: /migrations\.AddIndex\(/, risk: 'lock', what: 'AddIndex blocks writes while it builds', instead: 'AddIndexConcurrently (django.contrib.postgres.operations), with atomic = False'},
  {re: /migrations\.AlterField\(/, risk: 'lock', what: 'AlterField can rewrite the table (a type change) or scan it under a lock (null=False)', instead: 'check the SQL with sqlmigrate; for type changes, add a new field and move over'},
  {re: /migrations\.(?:RemoveField|DeleteModel)\(/, risk: 'irreversible', what: 'removes a field or model: data is lost, and running code that reads it fails', instead: 'stop using it in code and deploy first; remove it in a later migration'},
  {re: /migrations\.(?:RenameField|RenameModel)\(/, risk: 'breaks-running-code', what: 'renames a field or model: code from the previous deploy breaks', instead: 'expand/contract: add the new field, dual-write, move readers, remove the old'},
];

const ALEMBIC: Rule[] = [
  {re: /op\.add_column\([^\n]*nullable\s*=\s*False/, unless: /server_default\s*=/, risk: 'backfill', what: 'add_column with nullable=False and no server_default: fails on a table that has rows', instead: 'add it nullable, backfill, then alter_column(nullable=False)'},
  {re: /op\.create_index\(/, unless: /postgresql_concurrently\s*=\s*True/, risk: 'lock', what: 'create_index without postgresql_concurrently=True blocks writes while it builds', instead: 'create_index(…, postgresql_concurrently=True) inside op.get_context().autocommit_block()'},
  {re: /op\.alter_column\([^\n]*type_\s*=/, risk: 'lock', what: "alter_column(type_=…) rewrites the table, and running code may not handle the new type", instead: 'add a new column, dual-write and backfill, then switch'},
  {re: /op\.(?:drop_column|drop_table)\(/, risk: 'irreversible', what: 'drops a column or table: data is lost, and running code that reads it fails', instead: 'stop using it and deploy first; drop it later'},
  {re: /op\.alter_column\([^\n]*new_column_name\s*=|op\.rename_table\(/, risk: 'breaks-running-code', what: 'renames a column or table: code from the previous deploy breaks', instead: 'expand/contract instead of a rename'},
];

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** SQL statements with the line each starts on (comments removed, keeping line numbers). */
function statements(sql: string): {text: string; line: number}[] {
  const clean = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: {text: string; line: number}[] = [];
  let start = 0;
  for (let i = 0; i <= clean.length; i++) {
    if (i === clean.length || clean[i] === ';') {
      const text = clean.slice(start, i);
      if (text.trim()) out.push({text: text.trimStart(), line: lineOf(clean, start + (text.length - text.trimStart().length))});
      start = i + 1;
    }
  }
  return out;
}

function applyRules(file: string, units: {text: string; line: number}[], rules: Rule[]): Finding[] {
  const out: Finding[] = [];
  for (const u of units)
    for (const r of rules) {
      const m = r.re.exec(u.text);
      if (!m || r.unless?.test(u.text)) continue;
      out.push({file, line: u.line + lineOf(u.text, m.index) - 1, risk: r.risk, what: r.what, instead: r.instead});
    }
  return out;
}

/** Ruby/Python migrations: one unit per line (Django's AddField spans lines: one per operation). */
function codeUnits(text: string, django: boolean): {text: string; line: number}[] {
  if (django) return [...text.matchAll(/migrations\.\w+\([\s\S]*?\n\s*\),?\s*\n|migrations\.\w+\([^\n]*\),?\s*\n/g)].map((m) => ({text: m[0], line: lineOf(text, m.index!)}));
  return text.split('\n').map((t, i) => ({text: t, line: i + 1}));
}

/** Up/down migrations whose down step is missing or empty: they can't be rolled back. */
function irreversible(root: string, file: string, text: string): Finding[] {
  const f = (what: string): Finding[] => [{file, line: 1, risk: 'irreversible', what, instead: 'write the down step, or say in the migration why it cannot be undone'}];
  if (/\.up\.sql$/i.test(file) && !existsSync(path.join(root, file.replace(/\.up\.sql$/i, '.down.sql')))) return f('has no matching .down.sql: it can’t be rolled back');
  if (/--\s*\+(?:migrate|goose)\s+Up/i.test(text) && !/--\s*\+(?:migrate|goose)\s+Down\s*\n\s*\S/i.test(text)) return f('has an Up section and no (or an empty) Down section');
  if (/\bexports\.up\b|export\s+async\s+function\s+up\b/.test(text) && !/\bexports\.down\b|export\s+async\s+function\s+down\b/.test(text)) return f('has up() and no down()');
  if (/^def upgrade\(/m.test(text) && /^def downgrade\(\)[^:]*:\s*\n\s+pass\s*$/m.test(text)) return f('has an empty downgrade()');
  if (/\bdef up\b/.test(text) && !/\bdef down\b/.test(text)) return f('has up and no down (and isn’t a reversible change)');
  return [];
}

export function lintMigration(root: string, file: string, text: string): Finding[] {
  const rel = file.replace(/\\/g, '/');
  if (/\.rb$/.test(rel)) return [...applyRules(rel, codeUnits(text, false), RAILS), ...irreversible(root, rel, text)];
  if (/\.py$/.test(rel)) {
    const django = /from django\.db import migrations|migrations\.Migration/.test(text);
    return [...applyRules(rel, codeUnits(text, django), django ? DJANGO : ALEMBIC), ...applyRules(rel, statements([...text.matchAll(/(?:RunSQL|op\.execute)\(\s*(?:"""|'''|"|')([\s\S]*?)(?:"""|'''|"|')/g)].map((m) => m[1]).join(';\n')), SQL).map((x) => ({...x, line: 1})), ...irreversible(root, rel, text)];
  }
  if (/\.(?:js|ts)$/.test(rel)) {
    const sql = [...text.matchAll(/(?:raw|query|execute)\(\s*[`'"]([\s\S]*?)[`'"]/g)].map((m) => m[1]).join(';\n');
    return [...applyRules(rel, statements(sql), SQL).map((x) => ({...x, line: 1})), ...irreversible(root, rel, text)];
  }
  if (/\.down\.sql$/i.test(rel)) return []; // a down step is meant to undo
  return [...applyRules(rel, statements(text), SQL), ...irreversible(root, rel, text)];
}

/** /migrations: migration files the branch adds or changes against its base. */
export async function branchMigrations(root: string): Promise<{base: string; findings: Finding[]; files: string[]}> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '';
  const head = (await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).trim().replace('refs/remotes/', '') || 'origin/main';
  const mb = (await git('merge-base', 'HEAD', head)).trim();
  const files = [...new Set([...(await git('diff', '--name-only', '--diff-filter=AM', mb || 'HEAD')).split('\n'), ...(await git('ls-files', '--others', '--exclude-standard')).split('\n')])].filter((f) => f && isMigration(f));
  const findings = files.flatMap((f) => {
    try {
      return lintMigration(root, f, readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return [];
    }
  });
  return {base: mb ? head : 'HEAD', findings, files};
}

const LABEL: Record<Risk, string> = {lock: 'locks', backfill: 'needs a backfill', irreversible: 'irreversible', 'breaks-running-code': 'breaks running code'};

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  ${f.file}:${f.line}  [${LABEL[f.risk]}] ${f.what}\n      instead: ${f.instead}`).join('\n');
}

/** migration-check: what the request's migrations risk, for the agent. */
export function migrationNote(findings: Finding[]): string | undefined {
  if (!findings.length) return undefined;
  return `The migrations you wrote have risks on a live database:\n${formatFindings(findings)}\nFix the ones that apply to this database and table size. If one is deliberate (a small table, a maintenance window, an irreversible step that is intended), say so to the user instead.`;
}
