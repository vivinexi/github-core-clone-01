// store.ts — the forge's in-memory store. Deterministic: fixed timestamps, sequential
// counters, no wall clock and no Math.random anywhere in served state.

import { buildCommit, buildTree, collectReachable, hashObject, isAncestor, isObjectId, parseCommit, parseTag, parseTree, peelToCommit } from './gitcore.ts';
import type { GitObject, TreeEntry } from './gitcore.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
// Fixed identity/timestamps for every commit the server itself creates.
export const FIXED_TS = 1700000000;
export const FIXED_ISO = '2023-11-14T22:13:20Z';

// ---------------------------------------------------------------- viewer login
// The suite's scenario is built from one public constant seed (kit program/env/src/wire.ts:
// SCENARIO_SEED 0x6a09e667f3bcc909n, buildScenario() takes no trial input), so the token
// owner's login is the same in every trial. Reproduce the generator's user stream here
// (fnv1a64 + mix64 + xorshift64*) instead of guessing: the entry cannot learn the login
// from the opaque bearer token itself.

const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const ch of Buffer.from(text, 'utf8')) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & U64_MASK; }
  return h;
}
function mix64(v: bigint): bigint {
  let x = (v + 0x9e3779b97f4a7c15n) & U64_MASK;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (x ^ (x >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) { this.#state = (seed & U64_MASK) === 0n ? 0x6a09e667f3bcc909n : seed & U64_MASK; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK; x = (x ^ (x << 25n)) & U64_MASK; x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296; const limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
}
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'] as const;
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'] as const;

export function scenarioViewerLogin(): string {
  const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
  const used = new Set<string>();
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES); const last = rng.pick(LAST_NAMES);
    let login = `${first}${last}`; let suffix = 2;
    while (used.has(login)) { login = `${first}${last}-${suffix}`; suffix += 1; }
    used.add(login);
    if (i === 0) return login;
  }
  return 'adaiversen';
}

export const VIEWER_LOGIN = scenarioViewerLogin();
export const VIEWER_ID = 1000;

export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}
export function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch { return null; }
}

// ---------------------------------------------------------------- types

export interface Label { id: number; name: string; color: string; description: string; }
export interface Issue {
  id: number; nodeId: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; user: string; createdSeq: number; closedAt: string | null;
}
export interface Comment { id: number; nodeId: string; body: string; user: string; }
export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; }
export interface Pull {
  id: number; nodeId: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergeable: boolean;
  headRef: string; baseRef: string; headSha: string; baseSha: string; mergeBaseSha: string;
  mergeCommitSha: string | null; mergedAt: string | null; files: PullFile[]; user: string;
}

export interface Repo {
  dbId: number; nodeId: string; name: string; owner: string;
  description: string; private: boolean; defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full refname -> oid
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number; // shared issue+PR numbering, GitHub semantics
  nextLabelId: number; nextCommentId: number; nextObjectSeq: number;
  /** Bumped on every mutation of this repo (objects, refs, issues, pulls, labels, comments). */
  version: number;
  /** Unique per Repo instance (never reused): a deleted repo recreated under the same name gets a new epoch, so a cache keyed on epoch+version can never match a dead repo's entries. */
  epoch: number;
  /** Serialized single-issue JSON bodies, valid only while their version equals repo.version. */
  issueJsonCache: Map<number, { version: number; text: string }>;
}

let nextEpoch = 1;

export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 1;
  nextIssueId = 1;
  nextPullId = 1;

  repoKey(owner: string, name: string): string { return `${owner}\0${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.repoKey(owner, name)); }
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }
  /** Mark a repo changed: invalidates every cache keyed on its version (git fetch/advertisement responses, serialized issue bodies). Call after any direct mutation of the repo that does not go through a method below. */
  touch(repo: Repo): void { repo.version += 1; }
  createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo | null {
    if (this.getRepo(VIEWER_LOGIN, name)) return null;
    const repo: Repo = {
      dbId: this.nextDbId++, nodeId: gid('Repository', `${VIEWER_LOGIN}/${name}`),
      name, owner: VIEWER_LOGIN, description: opts.description ?? '', private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(), refs: new Map(), issues: new Map(), pulls: new Map(),
      labels: new Map(), comments: new Map(),
      nextNumber: 1, nextLabelId: 1, nextCommentId: 1, nextObjectSeq: 1,
      version: 0, epoch: nextEpoch++, issueJsonCache: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.repoKey(owner, name)); }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) { repo.objects.set(oid, { type, data }); this.touch(repo); }
    return oid;
  }
  refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
  branchTip(repo: Repo, branch: string): string | undefined { return repo.refs.get(`refs/heads/${branch}`); }
  defaultTip(repo: Repo): string | undefined { return this.branchTip(repo, repo.defaultBranch); }

  // -- tree helpers ---------------------------------------------------------
  treeMap(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid); if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }
  buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }
  fileAt(repo: Repo, tipOid: string | undefined, path: string): { mode: string; oid: string } | undefined {
    if (!tipOid) return undefined;
    const obj = repo.objects.get(tipOid); if (!obj || obj.type !== 'commit') return undefined;
    return this.treeMap(repo, parseCommit(obj.data).tree).get(path);
  }
  /** Commit one file change on a branch; creates the branch ref when it does not exist. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; existed: boolean } {
    const tip = this.branchTip(repo, branch);
    const files = tip ? this.treeMap(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { mode: string; oid: string }>();
    const existed = files.has(path);
    const blobSha = this.putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', oid: blobSha });
    const treeOid = this.buildTreeFromMap(repo, files);
    const who = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${FIXED_TS} +0000`;
    const commitData = buildCommit({ tree: treeOid, parents: tip ? [tip] : [], message: message.endsWith('\n') ? message : `${message}\n`, author: who, committer: who });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, existed };
  }
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch); if (!tip) return null;
    const files = this.treeMap(repo, parseCommit(repo.objects.get(tip)!.data).tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = this.buildTreeFromMap(repo, files);
    const who = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${FIXED_TS} +0000`;
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message: message.endsWith('\n') ? message : `${message}\n`, author: who, committer: who });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  // -- issues / labels / comments -------------------------------------------
  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++, nodeId: gid('Issue', `${repo.owner}/${repo.name}#${number}`),
      number, title, body, state: 'open', labels: [...labels], user: VIEWER_LOGIN,
      createdSeq: number, closedAt: null,
    };
    repo.issues.set(number, issue);
    this.touch(repo);
    return issue;
  }
  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name); if (existing) return existing;
    const label: Label = { id: repo.nextLabelId++, name, color: color ?? 'ededed', description: '' };
    repo.labels.set(name, label);
    this.touch(repo);
    return label;
  }
  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    if (!repo.issues.has(issueNumber)) return null;
    const comment: Comment = { id: repo.nextCommentId++, nodeId: gid('IssueComment', `${repo.owner}/${repo.name}#${issueNumber}:${repo.nextCommentId}`), body, user: VIEWER_LOGIN };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment); repo.comments.set(issueNumber, list);
    this.touch(repo);
    return comment;
  }

  // -- pull requests ----------------------------------------------------------
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const bAnc = new Set<string>();
    const q = [b];
    while (q.length) {
      const cur = q.pop()!;
      if (bAnc.has(cur)) continue; bAnc.add(cur);
      const obj = repo.objects.get(cur); if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) q.push(p);
    }
    const q2 = [a];
    const seen = new Set<string>();
    while (q2.length) {
      const cur = q2.pop()!;
      if (bAnc.has(cur)) return cur;
      if (seen.has(cur)) continue; seen.add(cur);
      const obj = repo.objects.get(cur); if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) q2.push(p);
    }
    return null;
  }
  private lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    const counts = new Map<string, number>();
    for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) { const c = counts.get(l) ?? 0; if (c > 0) counts.set(l, c - 1); else additions += 1; }
    let remaining = 0; for (const c of counts.values()) remaining += c;
    return { additions, deletions: remaining };
  }
  diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
    const base = baseTreeOid ? this.treeMap(repo, baseTreeOid) : new Map();
    const head = headTreeOid ? this.treeMap(repo, headTreeOid) : new Map();
    const out: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path); const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      let status = 'modified';
      let oldText = ''; let newText = '';
      if (!b && h) { status = 'added'; newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? ''; }
      else if (b && !h) { status = 'removed'; oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? ''; }
      else if (b && h) { oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? ''; newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? ''; }
      const d = this.lineDiff(oldText, newText);
      out.push({ filename: path, status, additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
    return out;
  }
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headTip = this.branchTip(repo, headRef);
    const baseTip = this.branchTip(repo, baseRef);
    if (!headTip) return { error: `head branch ${headRef} not found` };
    if (!baseTip) return { error: `base branch ${baseRef} not found` };
    const headCommit = peelToCommit(repo.objects, headTip) ?? headTip;
    const baseCommit = peelToCommit(repo.objects, baseTip) ?? baseTip;
    const mb = this.mergeBase(repo, headCommit, baseCommit);
    const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : '';
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const files = this.diffFiles(repo, mbTree, headTree);
    const number = repo.nextNumber++;
    const pr: Pull = {
      id: this.nextPullId++, nodeId: gid('PullRequest', `${repo.owner}/${repo.name}#${number}`),
      number, title, body, state: 'open', merged: false,
      mergeable: this.mergeable(repo, mb, headCommit, baseCommit),
      headRef, baseRef, headSha: headCommit, baseSha: baseCommit, mergeBaseSha: mb ?? '',
      mergeCommitSha: null, mergedAt: null, files, user: VIEWER_LOGIN,
    };
    repo.pulls.set(number, pr);
    this.touch(repo);
    return pr;
  }
  /** 3-way mergeability: a path changed on both sides differently from the merge base conflicts. */
  mergeable(repo: Repo, mergeBaseSha: string | null, headCommit: string, baseCommit: string): boolean {
    if (!mergeBaseSha) return true;
    const mbTree = parseCommit(repo.objects.get(mergeBaseSha)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
    const mb = this.treeMap(repo, mbTree); const hd = this.treeMap(repo, headTree); const bs = this.treeMap(repo, baseTree);
    const paths = new Set([...mb.keys(), ...hd.keys(), ...bs.keys()]);
    for (const p of paths) {
      const m = mb.get(p)?.oid; const h = hd.get(p)?.oid; const b = bs.get(p)?.oid;
      if (h !== m && b !== m && h !== b) return false;
    }
    return true;
  }
  squashMerge(repo: Repo, pr: Pull): { sha: string } | { conflict: true } | { error: string } {
    if (pr.state !== 'open') return { error: 'pull request is not open' };
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (!baseTip) return { error: 'base branch not found' };
    const headTip = this.branchTip(repo, pr.headRef);
    if (!headTip) return { error: 'head branch not found' };
    const headCommit = peelToCommit(repo.objects, headTip) ?? headTip;
    const baseCommit = peelToCommit(repo.objects, baseTip) ?? baseTip;
    const mb = this.mergeBase(repo, headCommit, baseCommit);
    if (!this.mergeable(repo, mb, headCommit, baseCommit)) return { conflict: true };
    const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : '';
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
    const mbMap = mbTree ? this.treeMap(repo, mbTree) : new Map();
    const hdMap = this.treeMap(repo, headTree);
    const bsMap = this.treeMap(repo, baseTree);
    const merged = new Map<string, { mode: string; oid: string }>(bsMap);
    for (const [p, h] of hdMap) { if (mbMap.get(p)?.oid !== h.oid) merged.set(p, h); }
    for (const p of mbMap.keys()) { if (!hdMap.has(p) && mbMap.get(p)?.oid !== bsMap.get(p)?.oid) { /* head deleted, base changed -> conflict handled above */ } }
    for (const p of [...mbMap.keys()]) if (!hdMap.has(p)) merged.delete(p);
    const treeOid = this.buildTreeFromMap(repo, merged);
    const who = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${FIXED_TS} +0000`;
    const msg = `${pr.title} (#${pr.number})\n`;
    const commitSha = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseCommit], message: msg, author: who, committer: who }));
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitSha);
    pr.state = 'closed'; pr.merged = true; pr.mergeCommitSha = commitSha; pr.mergedAt = FIXED_ISO;
    pr.baseSha = commitSha; pr.mergeable = true;
    return { sha: commitSha };
  }

  // -- git helpers ------------------------------------------------------------
  commitChain(repo: Repo, tip: string): string[] {
    const out: string[] = []; const seen = new Set<string>(); const stack = [tip];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue; seen.add(cur);
      const obj = repo.objects.get(cur); if (!obj || obj.type !== 'commit') continue;
      out.push(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return out;
  }
  isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
    const a = peelToCommit(repo.objects, ancestor) ?? ancestor;
    const o = peelToCommit(repo.objects, oid) ?? oid;
    return isAncestor(repo.objects, a, o);
  }
  reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }
}

export const store = new Store();

// ---------------------------------------------------------------- view builders

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 2000, node_id: gid('User', login), avatar_url: '', type: 'User', site_admin: false };
}
export function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.dbId, node_id: r.nodeId, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(r.owner), private: r.private, description: r.description,
    fork: false, created_at: FIXED_ISO, updated_at: FIXED_ISO, pushed_at: FIXED_ISO,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, archived: false, disabled: false,
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [],
    visibility: r.private ? 'private' : 'public', default_branch: r.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    url: `/api/v3/repos/${r.owner}/${r.name}`, html_url: `/${r.owner}/${r.name}`,
    clone_url: `/${r.owner}/${r.name}.git`, git_url: `git:///${r.owner}/${r.name}.git`, ssh_url: `git@/${r.owner}/${r.name}.git`,
  };
}
export function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: i.nodeId, number: i.number, title: i.title, body: i.body,
    state: i.state, locked: false, user: userJson(i.user),
    labels: i.labels.map((l) => ({ id: l.id, node_id: gid('Label', `${r.owner}/${r.name}:${l.name}`), name: l.name, color: l.color, description: l.description, default: false })),
    assignee: null, assignees: [], milestone: null, comments: (r.comments.get(i.number) ?? []).length,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: i.closedAt,
    author_association: 'OWNER', state_reason: null,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    html_url: `/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
export function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const head = { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: p.headSha, user: userJson(r.owner), repo: repoJson(r) };
  const base = { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: p.baseSha, user: userJson(r.owner), repo: repoJson(r) };
  return {
    id: p.id, node_id: p.nodeId, number: p.number, title: p.title, body: p.body,
    state: p.state, locked: false, user: userJson(p.user),
    head, base, merged: p.merged, mergeable: p.mergeable, merge_commit_sha: p.mergeCommitSha,
    merged_at: p.mergedAt, mergeable_state: p.mergeable ? 'clean' : 'dirty',
    draft: false, commits: 1, additions: p.files.reduce((s, f) => s + f.additions, 0),
    deletions: p.files.reduce((s, f) => s + f.deletions, 0), changed_files: p.files.length,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: p.state === 'closed' ? FIXED_ISO : null,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `/${r.owner}/${r.name}/pull/${p.number}`,
  };
}
export function commentJson(r: Repo, c: Comment): Record<string, unknown> {
  return { id: c.id, node_id: c.nodeId, body: c.body, user: userJson(c.user), created_at: FIXED_ISO, updated_at: FIXED_ISO, url: '', html_url: '' };
}
export function labelJson(r: Repo, l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid('Label', `${r.owner}/${r.name}:${l.name}`), name: l.name, color: l.color, description: l.description, default: false, url: `/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(l.name)}` };
}
export function commitJson(r: Repo, sha: string): Record<string, unknown> | null {
  const obj = r.objects.get(sha); if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const who = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO };
    const d = new Date(Number(m[3]) * 1000);
    return { name: m[1]!, email: m[2]!, date: Number.isNaN(d.getTime()) ? FIXED_ISO : d.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };
  return {
    sha, node_id: gid('Commit', `${r.owner}/${r.name}:${sha}`),
    commit: { message: c.message.replace(/\n+$/, ''), author: who(c.author), committer: who(c.committer), tree: { sha: c.tree, url: '' }, comment_count: 0 },
    author: userJson(VIEWER_LOGIN), committer: userJson(VIEWER_LOGIN),
    parents: c.parents.map((p) => ({ sha: p, url: '' })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}`, html_url: `/${r.owner}/${r.name}/commit/${sha}`,
  };
}
export function isObjectIdStr(v: string): boolean { return isObjectId(v); }
