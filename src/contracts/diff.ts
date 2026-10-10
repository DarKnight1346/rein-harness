import {parse as parseYaml} from 'yaml';

/**
 * Contract-change detector: compares two versions of an API contract and classifies each change as
 * breaking (a consumer written against the old one can fail) or safe. OpenAPI 3 / Swagger 2 (YAML or
 * JSON), protobuf, GraphQL SDL and Avro schemas, parsed here without external tools.
 */
export type Change = {kind: 'breaking' | 'safe'; where: string; what: string};
export type ContractKind = 'openapi' | 'protobuf' | 'graphql' | 'avro';

export function contractKind(file: string, text?: string): ContractKind | undefined {
  if (/\.proto$/i.test(file)) return 'protobuf';
  if (/\.(?:graphql|gql)$/i.test(file)) return 'graphql';
  if (/\.avsc$/i.test(file)) return 'avro';
  if (/\.(?:ya?ml|json)$/i.test(file) && (/(?:openapi|swagger)/i.test(file) || (text !== undefined && /(?:^|[{,])\s*["']?(?:openapi|swagger)["']?\s*:/m.test(text)))) return 'openapi';
  return undefined;
}

export function diffContract(kind: ContractKind, before: string, after: string): Change[] {
  if (kind === 'openapi') return diffOpenApi(before, after);
  if (kind === 'protobuf') return diffProto(before, after);
  if (kind === 'graphql') return diffGraphql(before, after);
  return diffAvro(before, after);
}

const B = (where: string, what: string): Change => ({kind: 'breaking', where, what});
const S = (where: string, what: string): Change => ({kind: 'safe', where, what});

// ---------- OpenAPI ----------

type Obj = Record<string, any>;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function loadDoc(text: string): Obj {
  try {
    return (parseYaml(text) ?? {}) as Obj; // YAML is a superset of JSON
  } catch {
    return {};
  }
}

/** Follows local `$ref`s (#/components/schemas/X, #/definitions/X), at most a few levels deep. */
function deref(doc: Obj, s: any, depth = 0): any {
  if (!s || typeof s !== 'object' || depth > 8) return s;
  if (typeof s.$ref === 'string' && s.$ref.startsWith('#/')) {
    const target = s.$ref
      .slice(2)
      .split('/')
      .reduce((o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return deref(doc, target, depth + 1);
  }
  return s;
}

const typeOf = (s: any) => (s ? [s.type, s.format].filter(Boolean).join('/') || (s.items ? 'array' : s.properties ? 'object' : '') : '');

/** Compares two schemas; `dir` is which way data flows: request (client → server) or response. */
function diffSchema(da: Obj, db: Obj, a: any, b: any, where: string, dir: 'request' | 'response', out: Change[], depth = 0): void {
  a = deref(da, a);
  b = deref(db, b);
  if (!a || !b || depth > 6) return;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta && tb && ta !== tb) {
    out.push(B(where, `type changed from ${ta} to ${tb}`));
    return;
  }
  const pa = (a.properties ?? {}) as Obj;
  const pb = (b.properties ?? {}) as Obj;
  const ra = new Set<string>(a.required ?? []);
  const rb = new Set<string>(b.required ?? []);
  for (const k of Object.keys(pa)) {
    if (!(k in pb)) out.push(dir === 'response' ? B(`${where}.${k}`, 'response field removed') : rb.has(k) ? B(`${where}.${k}`, 'request field removed') : S(`${where}.${k}`, 'optional request field removed'));
    else diffSchema(da, db, pa[k], pb[k], `${where}.${k}`, dir, out, depth + 1);
  }
  for (const k of Object.keys(pb)) {
    if (k in pa) continue;
    out.push(dir === 'request' && rb.has(k) ? B(`${where}.${k}`, 'new required request field') : S(`${where}.${k}`, `${dir} field added`));
  }
  for (const k of rb) if (dir === 'request' && k in pa && !ra.has(k)) out.push(B(`${where}.${k}`, 'request field became required'));
  for (const k of ra) if (dir === 'response' && k in pb && !rb.has(k)) out.push(B(`${where}.${k}`, 'response field is no longer always present'));
  const ea = Array.isArray(a.enum) ? a.enum.map(String) : undefined;
  const eb = Array.isArray(b.enum) ? b.enum.map(String) : undefined;
  if (ea && eb) {
    const gone = ea.filter((v: string) => !eb.includes(v));
    const added = eb.filter((v: string) => !ea.includes(v));
    if (gone.length) out.push(dir === 'request' ? B(where, `enum values removed: ${gone.join(', ')}`) : S(where, `enum values no longer returned: ${gone.join(', ')}`));
    if (added.length) out.push(dir === 'response' ? B(where, `new enum values clients may not handle: ${added.join(', ')}`) : S(where, `enum values added: ${added.join(', ')}`));
  }
  if (a.items || b.items) diffSchema(da, db, a.items, b.items, `${where}[]`, dir, out, depth + 1);
}

function diffOpenApi(before: string, after: string): Change[] {
  const da = loadDoc(before);
  const db = loadDoc(after);
  const out: Change[] = [];
  const pa = (da.paths ?? {}) as Obj;
  const pb = (db.paths ?? {}) as Obj;
  for (const p of Object.keys(pa)) {
    for (const m of METHODS) {
      const oa = pa[p]?.[m];
      if (!oa) continue;
      const ob = pb[p]?.[m];
      const op = `${m.toUpperCase()} ${p}`;
      if (!ob) {
        out.push(B(op, 'operation removed'));
        continue;
      }
      const params = (o: Obj, item: Obj, d: Obj) => [...(item?.parameters ?? []), ...(o.parameters ?? [])].map((x: any) => deref(d, x)).filter((x: any) => x?.name);
      const qa = params(oa, pa[p], da);
      const qb = params(ob, pb[p], db);
      const key = (x: any) => `${x.in}:${x.name}`;
      for (const x of qa) {
        const y = qb.find((q: any) => key(q) === key(x));
        if (!y) out.push(x.in === 'path' || x.required ? B(`${op} ${x.in} ${x.name}`, 'parameter removed') : S(`${op} ${x.in} ${x.name}`, 'optional parameter removed'));
        else {
          if (y.required && !x.required) out.push(B(`${op} ${x.in} ${x.name}`, 'parameter became required'));
          diffSchema(da, db, x.schema, y.schema, `${op} ${x.in} ${x.name}`, 'request', out);
        }
      }
      for (const y of qb) if (!qa.some((x: any) => key(x) === key(y))) out.push(y.required ? B(`${op} ${y.in} ${y.name}`, 'new required parameter') : S(`${op} ${y.in} ${y.name}`, 'optional parameter added'));
      const body = (o: Obj, d: Obj) => {
        const rb = deref(d, o.requestBody);
        const content = rb?.content ?? {};
        const mt = content['application/json'] ?? Object.values(content)[0];
        return {schema: (mt as Obj)?.schema ?? (o.parameters ?? []).map((x: any) => deref(d, x)).find((x: any) => x?.in === 'body')?.schema, required: !!rb?.required};
      };
      const ba = body(oa, da);
      const bb = body(ob, db);
      if (bb.schema && !ba.schema && bb.required) out.push(B(`${op} body`, 'new required request body'));
      diffSchema(da, db, ba.schema, bb.schema, `${op} body`, 'request', out);
      const ra = (oa.responses ?? {}) as Obj;
      const rbs = (ob.responses ?? {}) as Obj;
      for (const code of Object.keys(ra)) {
        if (!(code in rbs)) {
          if (/^2/.test(code)) out.push(B(`${op} ${code}`, 'success response removed'));
          continue;
        }
        const schemaOf = (r: any, d: Obj) => {
          const x = deref(d, r);
          return (x?.content?.['application/json'] ?? Object.values(x?.content ?? {})[0] as Obj)?.schema ?? x?.schema;
        };
        diffSchema(da, db, schemaOf(ra[code], da), schemaOf(rbs[code], db), `${op} ${code}`, 'response', out);
      }
      for (const code of Object.keys(rbs)) if (!(code in ra)) out.push(S(`${op} ${code}`, 'response added'));
    }
  }
  for (const p of Object.keys(pb)) for (const m of METHODS) if (pb[p]?.[m] && !pa[p]?.[m]) out.push(S(`${m.toUpperCase()} ${p}`, 'operation added'));
  return out;
}

// ---------- protobuf ----------

type ProtoField = {name: string; number: number; type: string; label: string};
type ProtoDoc = {pkg: string; messages: Map<string, {fields: ProtoField[]; reserved: Set<string>}>; enums: Map<string, Map<string, number>>; rpcs: Map<string, string>};

function stripComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * A block's own statements: nested message and enum blocks dropped (they're parsed on their own),
 * a oneof's fields kept (they belong to the message). Scanned by brace depth.
 */
function ownLines(body: string): string {
  let out = '';
  let i = 0;
  const head = /\b(message|enum|oneof)\s+\w+\s*\{/y;
  while (i < body.length) {
    head.lastIndex = i;
    const m = /\w/.test(body[i - 1] ?? '') ? null : head.exec(body);
    if (!m) {
      out += body[i++];
      continue;
    }
    let depth = 1;
    let j = head.lastIndex;
    for (; j < body.length && depth; j++) depth += body[j] === '{' ? 1 : body[j] === '}' ? -1 : 0;
    if (m[1] === 'oneof') out += body.slice(head.lastIndex, j - 1);
    i = j;
  }
  return out;
}

/** Blocks `keyword Name { … }`, nested ones named Outer.Inner. */
function blocks(text: string, prefix = ''): {kind: string; name: string; body: string}[] {
  const out: {kind: string; name: string; body: string}[] = [];
  const re = /\b(message|enum|service)\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    const body = text.slice(re.lastIndex, i - 1);
    const name = `${prefix}${m[2]}`;
    // The block's own lines, without nested blocks.
    const own = ownLines(body);
    out.push({kind: m[1]!, name, body: own});
    if (m[1] === 'message') out.push(...blocks(body, `${name}.`));
    re.lastIndex = i;
  }
  return out;
}

function parseProto(text: string): ProtoDoc {
  const t = stripComments(text);
  const doc: ProtoDoc = {pkg: t.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? '', messages: new Map(), enums: new Map(), rpcs: new Map()};
  for (const b of blocks(t)) {
    if (b.kind === 'message') {
      const fields = [...b.body.matchAll(/(?:^|;)\s*(optional|repeated|required)?\s*((?:map\s*<[^>]+>)|[\w.]+)\s+(\w+)\s*=\s*(\d+)/gm)]
        .filter((m) => m[2] !== 'reserved' && m[2] !== 'option')
        .map((m) => ({label: m[1] ?? '', type: m[2]!.replace(/\s+/g, ''), name: m[3]!, number: Number(m[4])}));
      const reserved = new Set<string>();
      for (const r of b.body.matchAll(/(?:^|;)\s*reserved\s+([^;]+);/gm)) for (const part of r[1]!.split(',')) reserved.add(part.trim().replace(/^"|"$/g, ''));
      doc.messages.set(b.name, {fields, reserved});
    } else if (b.kind === 'enum') {
      doc.enums.set(b.name, new Map([...b.body.matchAll(/(?:^|;)\s*(\w+)\s*=\s*(-?\d+)/gm)].map((m) => [m[1]!, Number(m[2])])));
    } else {
      for (const r of b.body.matchAll(/\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g))
        doc.rpcs.set(`${b.name}.${r[1]}`, `(${r[2] ?? ''}${r[3]}) returns (${r[4] ?? ''}${r[5]})`.replace(/\s+/g, ' '));
    }
  }
  return doc;
}

function diffProto(before: string, after: string): Change[] {
  const a = parseProto(before);
  const b = parseProto(after);
  const out: Change[] = [];
  if (a.pkg !== b.pkg) out.push(B('package', `package renamed from ${a.pkg || '(none)'} to ${b.pkg || '(none)'}`));
  for (const [name, ma] of a.messages) {
    const mb = b.messages.get(name);
    if (!mb) {
      out.push(B(name, 'message removed'));
      continue;
    }
    for (const f of ma.fields) {
      const byNumber = mb.fields.find((x) => x.number === f.number);
      const where = `${name}.${f.name} (= ${f.number})`;
      if (!byNumber) {
        const reserved = mb.reserved.has(String(f.number)) || mb.reserved.has(f.name) || [...mb.reserved].some((r) => /^(\d+)\s+to\s+(\d+|max)$/.test(r) && f.number >= Number(r.split(/\s+to\s+/)[0]) && (r.endsWith('max') || f.number <= Number(r.split(/\s+to\s+/)[1])));
        out.push(reserved ? S(where, 'field removed (its number is reserved)') : B(where, 'field removed without reserving its number: a later field could reuse it'));
        continue;
      }
      if (byNumber.type !== f.type) out.push(B(where, `type changed from ${f.type} to ${byNumber.type}`));
      if (byNumber.name !== f.name) out.push(B(where, `field renamed to ${byNumber.name} (breaks JSON and text format)`));
      if ((byNumber.label === 'repeated') !== (f.label === 'repeated')) out.push(B(where, `changed ${f.label === 'repeated' ? 'from' : 'to'} repeated`));
      if (byNumber.label === 'required' && f.label !== 'required') out.push(B(where, 'became required'));
    }
    for (const f of mb.fields) if (!ma.fields.some((x) => x.number === f.number)) out.push(f.label === 'required' ? B(`${name}.${f.name} (= ${f.number})`, 'new required field') : S(`${name}.${f.name} (= ${f.number})`, 'field added'));
  }
  for (const name of b.messages.keys()) if (!a.messages.has(name)) out.push(S(name, 'message added'));
  for (const [name, ea] of a.enums) {
    const eb = b.enums.get(name);
    if (!eb) {
      out.push(B(name, 'enum removed'));
      continue;
    }
    for (const [v, n] of ea) {
      if (!eb.has(v)) out.push(B(`${name}.${v}`, 'enum value removed'));
      else if (eb.get(v) !== n) out.push(B(`${name}.${v}`, `enum number changed from ${n} to ${eb.get(v)}`));
    }
    for (const v of eb.keys()) if (!ea.has(v)) out.push(S(`${name}.${v}`, 'enum value added'));
  }
  for (const [rpc, sig] of a.rpcs) {
    const now = b.rpcs.get(rpc);
    if (!now) out.push(B(rpc, 'rpc removed'));
    else if (now !== sig) out.push(B(rpc, `rpc signature changed from ${sig} to ${now}`));
  }
  for (const rpc of b.rpcs.keys()) if (!a.rpcs.has(rpc)) out.push(S(rpc, 'rpc added'));
  return out;
}

// ---------- GraphQL ----------

type GqlField = {type: string; args: Map<string, {type: string; hasDefault: boolean}>};
type GqlType = {kind: string; fields: Map<string, GqlField>; values: Set<string>};

function parseGraphql(text: string): Map<string, GqlType> {
  const t = text.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""|"[^"\n]*"/g, '');
  const types = new Map<string, GqlType>();
  for (const m of t.matchAll(/\b(?:extend\s+)?(type|input|interface|enum)\s+(\w+)[^{]*\{([^}]*)\}/g)) {
    const kind = m[1]!;
    const body = m[3]!;
    const ty: GqlType = types.get(m[2]!) ?? {kind, fields: new Map(), values: new Set()};
    if (kind === 'enum') for (const v of body.match(/\b[A-Z_][A-Z0-9_]*\b/g) ?? []) ty.values.add(v);
    else
      for (const f of body.matchAll(/(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([\w[\]!]+)(\s*=\s*[^\s,)]+)?/g)) {
        const args = new Map<string, {type: string; hasDefault: boolean}>();
        for (const a of (f[2] ?? '').matchAll(/(\w+)\s*:\s*([\w[\]!]+)(\s*=)?/g)) args.set(a[1]!, {type: a[2]!, hasDefault: !!a[3]});
        ty.fields.set(f[1]!, {type: f[3]!, args});
      }
    types.set(m[2]!, ty);
  }
  return types;
}

const nonNull = (t: string) => t.endsWith('!');
const bare = (t: string) => t.replace(/!/g, '');

function diffGraphql(before: string, after: string): Change[] {
  const a = parseGraphql(before);
  const b = parseGraphql(after);
  const out: Change[] = [];
  for (const [name, ta] of a) {
    const tb = b.get(name);
    if (!tb) {
      out.push(B(name, `${ta.kind} removed`));
      continue;
    }
    const input = ta.kind === 'input';
    for (const v of ta.values) if (!tb.values.has(v)) out.push(B(`${name}.${v}`, 'enum value removed'));
    for (const v of tb.values) if (!ta.values.has(v)) out.push(S(`${name}.${v}`, 'enum value added'));
    for (const [f, fa] of ta.fields) {
      const fb = tb.fields.get(f);
      const where = `${name}.${f}`;
      if (!fb) {
        out.push(B(where, input ? 'input field removed' : 'field removed'));
        continue;
      }
      if (bare(fa.type) !== bare(fb.type)) out.push(B(where, `type changed from ${fa.type} to ${fb.type}`));
      else if (input && !nonNull(fa.type) && nonNull(fb.type)) out.push(B(where, 'input field became required'));
      else if (!input && nonNull(fa.type) && !nonNull(fb.type)) out.push(B(where, 'field became nullable'));
      for (const [arg, x] of fa.args) {
        const y = fb.args.get(arg);
        if (!y) out.push(B(`${where}(${arg})`, 'argument removed'));
        else if (bare(x.type) !== bare(y.type)) out.push(B(`${where}(${arg})`, `argument type changed from ${x.type} to ${y.type}`));
        else if (!nonNull(x.type) && nonNull(y.type) && !y.hasDefault) out.push(B(`${where}(${arg})`, 'argument became required'));
      }
      for (const [arg, y] of fb.args) if (!fa.args.has(arg)) out.push(nonNull(y.type) && !y.hasDefault ? B(`${where}(${arg})`, 'new required argument') : S(`${where}(${arg})`, 'argument added'));
    }
    for (const [f, fb] of tb.fields) if (!ta.fields.has(f)) out.push(input && nonNull(fb.type) ? B(`${name}.${f}`, 'new required input field') : S(`${name}.${f}`, 'field added'));
  }
  for (const [name, tb] of b) if (!a.has(name)) out.push(S(name, `${tb.kind} added`));
  return out;
}

// ---------- Avro ----------

/** Avro schema evolution, from the readers' side: data written with the old schema must still read (backward compatible). */
function diffAvro(before: string, after: string): Change[] {
  let a: any;
  let b: any;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return [];
  }
  const out: Change[] = [];
  const tname = (t: any): string => (typeof t === 'string' ? t : Array.isArray(t) ? `[${t.map(tname).join(', ')}]` : t?.type === 'array' ? `array<${tname(t.items)}>` : t?.type === 'map' ? `map<${tname(t.values)}>` : t?.name ?? t?.type ?? '?');
  const promotable: Record<string, string[]> = {int: ['long', 'float', 'double'], long: ['float', 'double'], float: ['double'], string: ['bytes'], bytes: ['string']};
  const walk = (x: any, y: any, where: string) => {
    if (!x || !y) return;
    if (x.type === 'record' && y.type === 'record') {
      const fx = new Map<string, any>((x.fields ?? []).map((f: any) => [f.name, f]));
      const fy = new Map<string, any>((y.fields ?? []).map((f: any) => [f.name, f]));
      for (const [n, f] of fx) {
        const g = fy.get(n) ?? [...fy.values()].find((h: any) => (h.aliases ?? []).includes(n));
        if (!g) out.push(S(`${where}.${n}`, 'field removed (old data still reads; readers that need it break)'));
        else {
          const ta = tname(f.type);
          const tb = tname(g.type);
          if (ta !== tb && !(promotable[ta] ?? []).includes(tb) && !(Array.isArray(g.type) && g.type.map(tname).includes(ta))) out.push(B(`${where}.${n}`, `type changed from ${ta} to ${tb}`));
          else walk(typeof f.type === 'object' ? f.type : undefined, typeof g.type === 'object' ? g.type : undefined, `${where}.${n}`);
        }
      }
      for (const [n, g] of fy) if (!fx.has(n) && !(g.aliases ?? []).some((al: string) => fx.has(al))) out.push(g.default === undefined ? B(`${where}.${n}`, 'new field without a default: old data has no value for it') : S(`${where}.${n}`, 'field added with a default'));
    } else if (x.type === 'enum' && y.type === 'enum') {
      const gone = (x.symbols ?? []).filter((s: string) => !(y.symbols ?? []).includes(s));
      if (gone.length && y.default === undefined) out.push(B(where, `enum symbols removed: ${gone.join(', ')}`));
      const added = (y.symbols ?? []).filter((s: string) => !(x.symbols ?? []).includes(s));
      if (added.length) out.push(S(where, `enum symbols added: ${added.join(', ')}`));
    } else if (x.type === 'array' && y.type === 'array') walk(x.items, y.items, `${where}[]`);
  };
  walk(a, b, a?.name ?? 'record');
  return out;
}

export function formatChanges(file: string, changes: Change[]): string {
  const breaking = changes.filter((c) => c.kind === 'breaking');
  const safe = changes.filter((c) => c.kind === 'safe');
  if (!changes.length) return `${file}: no contract changes`;
  return [
    `${file}: ${breaking.length ? `${breaking.length} breaking` : 'no breaking changes'}${safe.length ? `, ${safe.length} safe` : ''}`,
    ...breaking.map((c) => `  ✗ ${c.where}: ${c.what}`),
    ...safe.map((c) => `  ✓ ${c.where}: ${c.what}`),
  ].join('\n');
}
