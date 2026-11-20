// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server
// send: viewer/repository/issue/pull-request reads, __type introspection, the five
// mutations, node(id:), and batched operation arrays. No external dependency.

import { store, VIEWER_LOGIN, VIEWER_ID, gid, ungid, FIXED_ISO } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------- tokenizer
type Tok =
  | { kind: 'punct'; v: string }
  | { kind: 'name'; v: string }
  | { kind: 'string'; v: string }
  | { kind: 'int'; v: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', v: '...' }); i += 3; continue; }
    if ('{}()[]:!=$'.includes(c) || c === '@') { toks.push({ kind: 'punct', v: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1]!; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; }
        else { out += src[j]; j += 1; }
      }
      toks.push({ kind: 'string', v: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'int', v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

// ---------------------------------------------------------------- parser
type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; v: string }
  | { kind: 'int'; v: number }
  | { kind: 'bool'; v: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; v: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface Selection {
  alias?: string; name?: string; args: { name: string; value: Value }[];
  selections?: Selection[]; fragmentType?: string;
}
interface Operation {
  type: 'query' | 'mutation'; name?: string;
  varDefs: { name: string; defaultValue?: Value }[];
  selections: Selection[];
}

class Parser {
  toks: Tok[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { const t = this.toks[this.pos]; if (!t) throw new Error('unexpected end of document'); this.pos += 1; return t; }
  expectPunct(v: string): void { const t = this.next(); if (t.kind !== 'punct' || t.v !== v) throw new Error(`expected ${v}`); }
  expectName(): string { const t = this.next(); if (t.kind !== 'name') throw new Error('expected name'); return t.v; }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) ops.push(this.parseOperation());
    return ops;
  }
  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query'; let name: string | undefined;
    const t = this.peek();
    if (t?.kind === 'punct' && t.v === '{') { return { type, varDefs: [], selections: this.parseSelectionSet() }; }
    if (t?.kind === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      type = this.next().v as string as 'query' | 'mutation';
      const n = this.peek();
      if (n?.kind === 'name') name = String(this.next().v);
    }
    const varDefs: Operation['varDefs'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.v === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.v === ')')) {
        this.expectPunct('$'); const vn = this.expectName(); this.expectPunct(':');
        this.skipType();
        let def: Value | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()!.v === '=') { this.next(); def = this.parseValue(); }
        varDefs.push(def ? { name: vn, defaultValue: def } : { name: vn });
      }
      this.expectPunct(')');
    }
    return { type, name, varDefs, selections: this.parseSelectionSet() };
  }
  skipType(): void {
    const t = this.peek();
    if (t?.kind === 'punct' && t.v === '[') { this.next(); this.skipType(); this.expectPunct(']'); }
    else this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()!.v === '!') this.next();
  }
  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.v === '}')) out.push(this.parseSelection());
    this.expectPunct('}');
    return out;
  }
  parseSelection(): Selection {
    const t = this.peek();
    if (t?.kind === 'punct' && t.v === '...') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.v === 'on') {
        this.next(); const typeName = this.expectName();
        return { args: [], selections: this.parseSelectionSet(), fragmentType: typeName };
      }
      // Named fragment spread: unsupported documents do not use it; treat as empty.
      this.expectName();
      return { args: [], selections: [] };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.v === ':') { this.next(); alias = name; name = this.expectName(); }
    const args: { name: string; value: Value }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.v === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.v === ')')) {
        const an = this.expectName(); this.expectPunct(':'); args.push({ name: an, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.v === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }
  parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.v === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', v: t.v };
    if (t.kind === 'int') return { kind: 'int', v: t.v };
    if (t.kind === 'name') {
      if (t.v === 'true') return { kind: 'bool', v: true };
      if (t.v === 'false') return { kind: 'bool', v: false };
      if (t.v === 'null') return { kind: 'null' };
      return { kind: 'enum', v: t.v };
    }
    if (t.kind === 'punct' && t.v === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.v === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.v === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.v === '}')) {
        const fn = this.expectName(); this.expectPunct(':'); fields.push({ name: fn, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------- schema
const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search'],
  Viewer: ['login', 'id', 'name', 'avatarUrl', 'url'],
  User: ['login', 'id', 'name', 'avatarUrl', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazers', 'primaryLanguage'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'repository'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'totalCount'],
};
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork'],
  SearchType: [],
};
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'];

// ---------------------------------------------------------------- executor
type Vars = Record<string, unknown>;

function evalValue(v: Value, vars: Vars): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': return v.v;
    case 'int': return v.v;
    case 'bool': return v.v;
    case 'null': return null;
    case 'enum': return v.v;
    case 'list': return v.items.map((i) => evalValue(i, vars));
    case 'object': { const o: Record<string, unknown> = {}; for (const f of v.fields) o[f.name] = evalValue(f.value, vars); return o; }
  }
}
function argMap(sel: Selection, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = evalValue(a.value, vars);
  return out;
}

interface Ctx { errors: { message: string }[]; }

function typeNameOf(v: unknown): string {
  if (v === null || v === undefined) return 'Unknown';
  const t = (v as { __typename?: string }).__typename;
  return typeof t === 'string' ? t : 'Unknown';
}

function selectFields(typeName: string, selections: Selection[], obj: Record<string, unknown>, vars: Vars, ctx: Ctx, resolve: (field: string, sel: Selection, parent: Record<string, unknown>) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== undefined) {
      if (sel.fragmentType !== typeName) continue;
      Object.assign(out, selectFields(typeName, sel.selections ?? [], obj, vars, ctx, resolve));
      continue;
    }
    const field = sel.name!;
    if (field === '__typename') { out[sel.alias ?? field] = typeName; continue; }
    const allowed = FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field)) {
      ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
      continue;
    }
    const value = resolve(field, sel, obj);
    out[sel.alias ?? field] = value;
  }
  return out;
}

function wrapIssue(r: Repo, i: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __issue: i, __repo: r, id: i.nodeId, number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED', body: i.body, url: `/${r.owner}/${r.name}/issues/${i.number}`, createdAt: FIXED_ISO, updatedAt: FIXED_ISO, closedAt: i.closedAt };
}
function wrapPull(r: Repo, p: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest', __pull: p, __repo: r, id: p.nodeId, number: p.number,
    title: p.title, body: p.body,
    state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: p.merged, headRefName: p.headRef, baseRefName: p.baseRef,
    mergeable: p.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefOid: p.headSha, baseRefOid: p.baseSha,
    url: `/${r.owner}/${r.name}/pull/${p.number}`, createdAt: FIXED_ISO, updatedAt: FIXED_ISO, mergedAt: p.mergedAt,
  };
}
function wrapRepo(r: Repo): Record<string, unknown> {
  const tip = store.defaultTip(r);
  return {
    __typename: 'Repository', __repo: r, id: r.nodeId, databaseId: r.dbId, name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`, description: r.description, isPrivate: r.private, fork: false,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    url: `/${r.owner}/${r.name}`, createdAt: FIXED_ISO, updatedAt: FIXED_ISO,
    __defaultTip: tip ?? null,
  };
}
function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function cursorNum(c: unknown): number | null {
  if (typeof c !== 'string' || c === '') return null;
  try {
    const t = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(t); return m ? Number(m[1]) : null;
  } catch { return null; }
}

function resolveRepoField(field: string, sel: Selection, parent: Record<string, unknown>, vars: Vars, ctx: Ctx): unknown {
  const r = parent.__repo as Repo;
  const args = argMap(sel, vars);
  switch (field) {
    case 'owner': return selectFields('User', sel.selections ?? [], { __typename: 'User', login: r.owner, id: VIEWER_ID, name: r.owner, avatarUrl: '', url: `/${r.owner}` }, vars, ctx, resolveUserField);
    case 'defaultBranchRef': {
      if (!parent.__defaultTip) return null;
      return selectFields('Ref', sel.selections ?? [], { __typename: 'Ref', name: r.defaultBranch }, vars, ctx, (f) => (f === 'name' ? r.defaultBranch : null));
    }
    case 'issue': {
      const issue = r.issues.get(Number(args.number));
      if (!issue) return null;
      return selectFields('Issue', sel.selections ?? [], wrapIssue(r, issue), vars, ctx, resolveIssueField);
    }
    case 'issues': {
      let list = [...r.issues.values()].sort((a, b) => a.number - b.number);
      const states = args.states as string[] | undefined;
      if (states && states.length) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const dir = orderBy?.direction === 'DESC' ? -1 : 1;
      list.sort((a, b) => (a.number - b.number) * dir);
      const after = cursorNum(args.after);
      if (after !== null) list = dir === 1 ? list.filter((i) => i.number > after) : list.filter((i) => i.number < after);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > page.length;
      const nodes = page.map((i) => selectFields('Issue', sel.selections?.find((s) => s.name === 'nodes')?.selections ?? [], wrapIssue(r, i), vars, ctx, resolveIssueField));
      const conn: Record<string, unknown> = { __typename: 'IssueConnection', __nodes: page, __repo: r };
      return selectFields('IssueConnection', sel.selections ?? [], conn, vars, ctx, (f, s2) => {
        if (f === 'nodes') return nodes;
        if (f === 'totalCount') return r.issues.size;
        if (f === 'pageInfo') return selectFields('PageInfo', s2.selections ?? [], { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: after !== null, endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null, startCursor: page.length ? cursorFor(page[0]!.number) : null }, vars, ctx, (g) => ({ hasNextPage: hasNext, hasPreviousPage: after !== null, endCursor: page.length ? cursorFor(page[page.length - 1]!.number) : null, startCursor: page.length ? cursorFor(page[0]!.number) : null })[g]);
        if (f === 'edges') return page.map((i) => ({ __typename: 'IssueEdge', node: selectFields('Issue', s2.selections?.find((x) => x.name === 'node')?.selections ?? [], wrapIssue(r, i), vars, ctx, resolveIssueField), cursor: cursorFor(i.number) }));
        return null;
      });
    }
    case 'pullRequests': {
      let list = [...r.pulls.values()].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const nodes = page.map((p) => selectFields('PullRequest', sel.selections?.find((s) => s.name === 'nodes')?.selections ?? [], wrapPull(r, p), vars, ctx, resolvePullField));
      const conn: Record<string, unknown> = { __typename: 'PullRequestConnection' };
      return selectFields('PullRequestConnection', sel.selections ?? [], conn, vars, ctx, (f) => (f === 'nodes' ? nodes : f === 'totalCount' ? r.pulls.size : null));
    }
    case 'pullRequest': {
      const pr = r.pulls.get(Number(args.number));
      if (!pr) return null;
      return selectFields('PullRequest', sel.selections ?? [], wrapPull(r, pr), vars, ctx, resolvePullField);
    }
    default: {
      const v = parent[field];
      return v === undefined ? null : v;
    }
  }
}
function repoResolver(vars: Vars, ctx: Ctx): (field: string, sel: Selection, parent: Record<string, unknown>) => unknown {
  return (field, sel, parent) => resolveRepoField(field, sel, parent, vars, ctx);
}
function resolveUserField(field: string, _sel: Selection, parent: Record<string, unknown>): unknown {
  return parent[field] ?? null;
}
function resolveIssueField(field: string, sel: Selection, parent: Record<string, unknown>): unknown {
  const r = parent.__repo as Repo; const i = parent.__issue as Issue;
  switch (field) {
    case 'author': return { __typename: 'User', login: i.user, id: VIEWER_ID, name: i.user, avatarUrl: '', url: `/${i.user}` };
    case 'labels': {
      const nodes = i.labels.map((l) => ({ __typename: 'Label', id: l.id, name: l.name, color: l.color, description: l.description }));
      return { __typename: 'LabelConnection', nodes };
    }
    case 'comments': return { __typename: 'IssueConnection', nodes: [] as unknown[], totalCount: (r.comments.get(i.number) ?? []).length };
    case 'repository': return selectFields('Repository', sel.selections ?? [], wrapRepo(r), {}, { errors: [] }, repoResolver({}, { errors: [] }));
    default: return parent[field] ?? null;
  }
}
function resolvePullField(field: string, sel: Selection, parent: Record<string, unknown>): unknown {
  const r = parent.__repo as Repo; const p = parent.__pull as Pull;
  switch (field) {
    case 'files': {
      const first = (() => { const a = argMap(sel, {}); return typeof a.first === 'number' ? a.first : p.files.length; })();
      const nodes = p.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED' }));
      return selectFields('PullRequestChangedFileConnection', sel.selections ?? [], { __typename: 'PullRequestChangedFileConnection' }, {}, { errors: [] }, (f) => (f === 'nodes' ? nodes.map((n) => selectFields('PullRequestChangedFile', sel.selections?.find((s) => s.name === 'nodes')?.selections ?? [], n, {}, { errors: [] }, (g, _s, par) => (par as Record<string, unknown>)[g] ?? null)) : f === 'totalCount' ? p.files.length : null));
    }
    case 'author': return { __typename: 'User', login: p.user, id: VIEWER_ID, name: p.user, avatarUrl: '', url: `/${p.user}` };
    case 'mergeCommit': return p.mergeCommitSha ? { __typename: 'Commit', oid: p.mergeCommitSha } : null;
    case 'repository': return selectFields('Repository', sel.selections ?? [], wrapRepo(r), {}, { errors: [] }, repoResolver({}, { errors: [] }));
    default: return parent[field] ?? null;
  }
}

function resolveTypeField(sel: Selection, vars: Vars, ctx: Ctx): unknown {
  const args = argMap(sel, vars);
  const name = args.name as string | undefined;
  if (name === undefined) return null;
  if (name === 'SearchType') {
    const obj: Record<string, unknown> = { __typename: '__Type', name, kind: 'ENUM', description: null };
    return selectFields('__Type', sel.selections ?? [], obj, vars, ctx, (f) => {
      if (f === 'enumValues') return SEARCH_ENUM.map((n) => ({ __typename: '__EnumValue', name: n, description: null }));
      if (f === 'fields') return null;
      return obj[f] ?? null;
    });
  }
  const fields = INTROSPECTION_FIELDS[name] ?? FIELDS[name];
  if (fields === undefined) return null;
  const obj: Record<string, unknown> = { __typename: '__Type', name, kind: 'OBJECT', description: null };
  return selectFields('__Type', sel.selections ?? [], obj, vars, ctx, (f, s2) => {
    if (f === 'fields') return fields.map((n) => selectFields('__Field', s2.selections ?? [], { __typename: '__Field', name: n, description: null }, vars, ctx, (g) => (g === 'name' ? n : null)));
    if (f === 'enumValues') return null;
    return obj[f] ?? null;
  });
}

function findRepoByGid(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const d = ungid(id); if (!d || d.kind !== 'Repository') return null;
  const [owner, name] = d.key.split('/');
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}
function findIssueByGid(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const d = ungid(id); if (!d || d.kind !== 'Issue') return null;
  const m = /^(.+)\/(.+)#(\d+)$/.exec(d.key); if (!m) return null;
  const repo = store.getRepo(m[1]!, m[2]!); if (!repo) return null;
  const issue = repo.issues.get(Number(m[3]!)); if (!issue) return null;
  return { repo, issue };
}
function findPullByGid(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const d = ungid(id); if (!d || d.kind !== 'PullRequest') return null;
  const m = /^(.+)\/(.+)#(\d+)$/.exec(d.key); if (!m) return null;
  const repo = store.getRepo(m[1]!, m[2]!); if (!repo) return null;
  const pull = repo.pulls.get(Number(m[3]!)); if (!pull) return null;
  return { repo, pull };
}

function executeOperation(op: Operation, varsIn: Vars): { data: unknown; errors: { message: string }[] } {
  const ctx: Ctx = { errors: [] };
  const vars: Vars = { ...varsIn };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) vars[def.name] = evalValue(def.defaultValue, vars);
  }
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Record<string, unknown> = { __typename: rootType };
  const data = selectFields(rootType, op.selections, root, vars, ctx, (field, sel, _parent) => {
    const args = argMap(sel, vars);
    if (rootType === 'Query') {
      switch (field) {
        case 'viewer': {
          const v: Record<string, unknown> = { __typename: 'Viewer', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_LOGIN, avatarUrl: '', url: `/${VIEWER_LOGIN}` };
          return selectFields('Viewer', sel.selections ?? [], v, vars, ctx, resolveUserField);
        }
        case 'repository': {
          const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          if (!repo || repo.owner !== VIEWER_LOGIN) return null;
          return selectFields('Repository', sel.selections ?? [], wrapRepo(repo), vars, ctx, repoResolver(vars, ctx));
        }
        case 'node': {
          const id = args.id;
          const rd = typeof id === 'string' ? ungid(id) : null;
          if (!rd) return null;
          if (rd.kind === 'Repository') {
            const repo = findRepoByGid(id); if (!repo) return null;
            return selectFields('Repository', sel.selections ?? [], wrapRepo(repo), vars, ctx, repoResolver(vars, ctx));
          }
          if (rd.kind === 'Issue') {
            const found = findIssueByGid(id); if (!found) return null;
            return selectFields('Issue', sel.selections ?? [], wrapIssue(found.repo, found.issue), vars, ctx, resolveIssueField);
          }
          if (rd.kind === 'PullRequest') {
            const found = findPullByGid(id); if (!found) return null;
            return selectFields('PullRequest', sel.selections ?? [], wrapPull(found.repo, found.pull), vars, ctx, resolvePullField);
          }
          return null;
        }
        case '__type': return resolveTypeField(sel, vars, ctx);
        case '__schema': {
          const obj: Record<string, unknown> = { __typename: '__Schema' };
          return selectFields('__Schema', sel.selections ?? [], obj, vars, ctx, (f, s2) => {
            if (f === 'queryType') return { __typename: '__Type', name: 'Query' };
            if (f === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
            if (f === 'types') {
              const names = [...Object.keys(FIELDS), 'SearchType'];
              return names.map((n) => resolveTypeField(
                { alias: s2.alias, name: '__type', args: [{ name: 'name', value: { kind: 'string', v: n } }], selections: s2.selections ?? [] },
                vars, ctx,
              ));
            }
            return null;
          });
        }
        default: return null;
      }
    }
    // Mutations
    switch (field) {
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(input.repositoryId);
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return { issue: null }; }
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        const payload: Record<string, unknown> = { __typename: 'CreateIssuePayload', issue };
        return selectFields('CreateIssuePayload', sel.selections ?? [], payload, vars, ctx, (f) => (f === 'issue' ? selectFields('Issue', sel.selections?.find((s) => s.name === 'issue')?.selections ?? [], wrapIssue(repo, issue), vars, ctx, resolveIssueField) : null));
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(input.issueId);
        if (!found) { ctx.errors.push({ message: 'issue not found' }); return { issue: null }; }
        found.issue.state = 'closed'; found.issue.closedAt = FIXED_ISO;
        store.touch(found.repo);
        const payload: Record<string, unknown> = { __typename: 'CloseIssuePayload', issue: found.issue };
        return selectFields('CloseIssuePayload', sel.selections ?? [], payload, vars, ctx, (f) => (f === 'issue' ? selectFields('Issue', sel.selections?.find((s) => s.name === 'issue')?.selections ?? [], wrapIssue(found.repo, found.issue), vars, ctx, resolveIssueField) : null));
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(input.repositoryId);
        if (!repo) { ctx.errors.push({ message: 'repository not found' }); return { pullRequest: null }; }
        const created = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if ('error' in created) { ctx.errors.push({ message: created.error }); return { pullRequest: null }; }
        const payload: Record<string, unknown> = { __typename: 'CreatePullRequestPayload', pullRequest: created };
        return selectFields('CreatePullRequestPayload', sel.selections ?? [], payload, vars, ctx, (f) => (f === 'pullRequest' ? selectFields('PullRequest', sel.selections?.find((s) => s.name === 'pullRequest')?.selections ?? [], wrapPull(repo, created), vars, ctx, resolvePullField) : null));
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGid(input.pullRequestId);
        if (!found) { ctx.errors.push({ message: 'pull request not found' }); return { pullRequest: null }; }
        store.squashMerge(found.repo, found.pull);
        const payload: Record<string, unknown> = { __typename: 'MergePullRequestPayload', pullRequest: found.pull };
        return selectFields('MergePullRequestPayload', sel.selections ?? [], payload, vars, ctx, (f) => (f === 'pullRequest' ? selectFields('PullRequest', sel.selections?.find((s) => s.name === 'pullRequest')?.selections ?? [], wrapPull(found.repo, found.pull), vars, ctx, resolvePullField) : null));
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(input.subjectId);
        if (!found) { ctx.errors.push({ message: 'issue not found' }); return { commentEdge: null }; }
        const comment = store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
        if (!comment) { ctx.errors.push({ message: 'issue not found' }); return { commentEdge: null }; }
        const node = { __typename: 'IssueComment', id: comment.nodeId, body: comment.body, author: { __typename: 'User', login: comment.user, id: VIEWER_ID }, createdAt: FIXED_ISO, updatedAt: FIXED_ISO, url: '' };
        const payload: Record<string, unknown> = { __typename: 'AddCommentPayload' };
        return selectFields('AddCommentPayload', sel.selections ?? [], payload, vars, ctx, (f) => {
          if (f === 'commentEdge') {
            return selectFields('CommentEdge', sel.selections?.find((s) => s.name === 'commentEdge')?.selections ?? [], { __typename: 'CommentEdge' }, vars, ctx, (g) => (g === 'node' ? selectFields('IssueComment', sel.selections?.find((s) => s.name === 'commentEdge')?.selections?.find((x) => x.name === 'node')?.selections ?? [], node, vars, ctx, (h, _s, par) => (par as Record<string, unknown>)[h] ?? null) : null));
          }
          if (f === 'comment') return selectFields('IssueComment', sel.selections?.find((s) => s.name === 'comment')?.selections ?? [], node, vars, ctx, (g, _s, par) => (par as Record<string, unknown>)[g] ?? null);
          return null;
        });
      }
      default: return null;
    }
  });
  return { data: ctx.errors.length > 0 ? null : data, errors: ctx.errors };
}

export function executeGraphQL(body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const out = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
      const op = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
      return runOne(op.query, (op.variables ?? {}) as Vars);
    });
    return { status: 200, payload: out };
  }
  if (body === null || typeof body !== 'object') return { status: 400, payload: { message: 'request body must be a JSON object' } };
  const op = body as { query?: unknown; variables?: unknown };
  if (typeof op.query !== 'string') return { status: 400, payload: { message: 'query must be a string' } };
  return { status: 200, payload: runOne(op.query, (op.variables ?? {}) as Vars) };
}

function runOne(query: string, vars: Vars): { data: unknown; errors?: { message: string }[] } {
  let ops: Operation[];
  try {
    ops = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
  // A document with several operations runs the first; batched bodies arrive as arrays.
  const result = executeOperation(ops[0]!, vars);
  return result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data };
}
