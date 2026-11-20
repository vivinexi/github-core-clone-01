// git.ts — git smart HTTP: info/refs, upload-pack (protocol v2 + v0 fallback),
// receive-pack v0. Speaks pkt-lines, packfiles and side-band-64k by hand.

import { store } from './store.ts';
import type { Repo } from './store.ts';
import {
  ZERO_OID, hashObject, isAncestor, isObjectId, parseCommit, parseTag,
  parseTree, peelToCommit, pktLine, pktLines, readPack, writePack, parsePktLines, PKT_DELIM, PKT_FLUSH,
} from './gitcore.ts';
import type { GitObject } from './gitcore.ts';

const AGENT = 'github-forge/1.0.0';
const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack shallow multi_ack multi_ack_detailed agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string | undefined>; body: Buffer; }
export interface GitResponse { status: number; headers: Record<string, string>; body: Buffer; }

function json404(message: string): GitResponse {
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ message }) + '\n') };
}
function text(status: number, text: string): GitResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text) };
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
function peeledOf(repo: Repo, refName: string, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(repo.objects, oid) ?? undefined;
}

/** The v0 ref advertisement body (with the "# service=" preamble). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${defaultTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const peeled = peeledOf(repo, r.name, r.oid);
      if (peeled !== undefined) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  for (const l of lines) parts.push(pktLine(l));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

interface FetchPlan {
  objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean;
}

/**
 * What the client already holds. Haves carry their full history — except a
 * commit named as a shallow boundary: the client has that commit and its
 * tree/blobs, but nothing beyond it (that is what "shallow" means). So the
 * traversal stops at a boundary instead of walking its parents; treating the
 * boundary's ancestors as held would make a deepen fetch send nothing.
 */
function heldObjects(repo: Repo, haves: string[], shallowIn: string[]): Set<string> {
  const shallowSet = new Set(shallowIn);
  const held = new Set<string>();
  const stack = [...haves, ...shallowIn];
  while (stack.length) {
    const oid = stack.pop()!;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return held;
}

function computeFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const held = heldObjects(repo, haves, shallowIn);
  const shallowSet = new Set(shallowIn);
  const objects = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  // BFS from wants (peeled to commits); distance 1 = the want itself.
  const queue: { oid: string; d: number }[] = [];
  const visited = new Set<string>();
  const tagObjects = new Set<string>();
  for (const w of wants) {
    const obj = repo.objects.get(w); if (!obj) continue;
    if (obj.type === 'tag') { tagObjects.add(w); const c = peelToCommit(repo.objects, w); if (c) queue.push({ oid: c, d: 1 }); continue; }
    if (obj.type === 'commit') queue.push({ oid: w, d: 1 });
    else if (obj.type === 'tree' || obj.type === 'blob') { if (!held.has(w)) objects.set(w, obj); }
  }
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (visited.has(oid)) continue; visited.add(oid);
    if (depth !== null && d > depth) continue;
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    if (!held.has(oid)) includedCommits.add(oid);
    const parents = parseCommit(obj.data).parents;
    if (depth !== null && d === depth) { if (parents.length > 0 && !held.has(oid)) boundary.add(oid); }
    else if (depth === null && held.has(oid) && !shallowSet.has(oid)) { /* do not walk past held commits without a depth */ continue; }
    for (const p of parents) queue.push({ oid: p, d: d + 1 });
  }
  // Tree/blob closure of included commits only: the BFS already decided which
  // commits are included, so their parents must not be walked here (a shallow
  // boundary's ancestors would leak into the pack).
  const closure = new Set<string>();
  const tstack = [...includedCommits];
  while (tstack.length) {
    const oid = tstack.pop()!;
    if (closure.has(oid)) continue;
    const o = repo.objects.get(oid); if (!o) continue;
    closure.add(oid);
    if (o.type === 'commit') tstack.push(parseCommit(o.data).tree);
    else if (o.type === 'tree') for (const e of parseTree(o.data)) tstack.push(e.oid);
  }
  for (const oid of closure) if (!held.has(oid)) { const o = repo.objects.get(oid)!; objects.set(oid, o); }
  for (const t of tagObjects) if (!held.has(t)) { const o = repo.objects.get(t)!; objects.set(t, o); }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const b of boundary) shallow.push(b);
    for (const s of shallowIn) {
      const obj = repo.objects.get(s);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((p) => includedCommits.has(p))) unshallow.push(s);
    }
  }
  const acks: string[] = [];
  let nak = true;
  for (const h of haves) {
    const hc = peelToCommit(repo.objects, h) ?? h;
    for (const w of wants) {
      const wc = peelToCommit(repo.objects, w) ?? w;
      if (isAncestor(repo.objects, hc, wc)) { acks.push(h); nak = false; break; }
    }
  }
  const list = [...objects.values()].sort((a, b) => (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
  return { objects: list, shallow, unshallow, acks, nak };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function v2FetchResponse(repo: Repo, plan: FetchPlan, negotiate: boolean): Buffer {
  const parts: Buffer[] = [];
  // Real git (and protocol-v2): the acknowledgments section is sent only while
  // negotiating. A request that already says `done` (a clone, or a fetch with
  // no haves) goes straight to [shallow-info] + packfile; sending an ack
  // section there makes git die with "expected 'packfile'".
  if (negotiate) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) parts.push(pktLine('NAK\n'));
    else { for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`)); parts.push(pktLine('ready\n')); }
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else { for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`)); }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const pack = writePack(plan.objects);
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (args.symrefs && keep('HEAD')) {
    if (defaultTip) lines.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else if (args.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const r of refs) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, r.name, r.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((l) => pktLine(l));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseRequestLines(body: Buffer): string[] {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return lines;
}

function handleUploadPackV2(repo: Repo, body: Buffer): GitResponse {
  const lines = parseRequestLines(body);
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim() ?? '';
  if (command === 'ls-refs') {
    const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const l of lines) {
      const t = l.trim();
      if (t === 'peel') args.peel = true;
      else if (t === 'symrefs') args.symrefs = true;
      else if (t === 'unborn') args.unborn = true;
      else if (t.startsWith('ref-prefix ')) args.prefixes.push(t.slice('ref-prefix '.length));
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: lsRefsResponse(repo, args) };
  }
  if (command === 'fetch') {
    const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
    let depth: number | null = null; let done = false;
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
      else if (t === 'done') done = true;
    }
    const plan = computeFetch(repo, wants, haves, shallow, depth);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: v2FetchResponse(repo, plan, haves.length > 0 && !done) };
  }
  return text(400, 'unknown v2 command');
}

function handleUploadPackV0(repo: Repo, body: Buffer): GitResponse {
  // v0 request: want lines, shallow/deepen lines, flush, have lines, done, flush.
  if (body.length >= 4 && !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) return text(400, 'malformed pkt-line');
  const lines = parseRequestLines(body);
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | null = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]!);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  if (wants.length === 0) return text(400, 'no want lines');
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: v0FetchResponse(plan) };
}

function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  const { packets, restOffset } = parsePktLines(body);
  const commandLines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'data') commandLines.push(p.payload.toString('utf8'));
  }
  interface Cmd { oldOid: string; newOid: string; ref: string; }
  const commands: Cmd[] = [];
  for (let i = 0; i < commandLines.length; i += 1) {
    let line = commandLines[i]!.replace(/\n$/, '');
    if (i === 0) { const nul = line.indexOf('\0'); if (nul >= 0) line = line.slice(0, nul); }
    const parts = line.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(restOffset);
  const inner: string[] = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      inner.push(`unpack error ${err instanceof Error ? err.message : 'bad pack'}\n`);
      for (const c of commands) inner.push(`ng ${c.ref} unpack failed\n`);
      const reportInner = Buffer.concat([...inner.map((l) => pktLine(l)), PKT_FLUSH]);
      const framed: Buffer[] = [];
      for (let off = 0; off < reportInner.length; off += 32768) {
        framed.push(pktLine(Buffer.concat([Buffer.from([1]), reportInner.subarray(off, Math.min(reportInner.length, off + 32768))])));
      }
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.concat([...framed, PKT_FLUSH]) };
    }
  }
  inner.push('unpack ok\n');
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true; let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) { ok = false; reason = 'remote ref does not exist'; }
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
      else repo.refs.delete(cmd.ref);
    } else {
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj) { ok = false; reason = 'object missing'; }
      else if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) { ok = false; reason = 'non-fast-forward'; }
        else repo.refs.set(cmd.ref, cmd.newOid);
      } else {
        if (cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
        else {
          const newCommit = peelToCommit(repo.objects, cmd.newOid);
          const curCommit = peelToCommit(repo.objects, current);
          if (!newCommit || !curCommit || !isAncestor(repo.objects, curCommit, newCommit)) { ok = false; reason = 'non-fast-forward'; }
          else repo.refs.set(cmd.ref, cmd.newOid);
        }
      }
    }
    inner.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  // The report-status stream is itself pkt-lined inside band 1, and it must end
  // with its OWN flush *inside* the band-1 data: real git reads the report
  // from the demultiplexed band-1 stream and dies with "the remote end hung
  // up" if that stream ends (outer flush) before an inner flush arrives.
  // So: one band-1 payload = all inner pkt-lines + inner flush, chunked at
  // 32 KiB, then a final outer flush terminates the sideband stream.
  const reportInner = Buffer.concat([...inner.map((l) => pktLine(l)), PKT_FLUSH]);
  const framed: Buffer[] = [];
  for (let off = 0; off < reportInner.length; off += 32768) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), reportInner.subarray(off, Math.min(reportInner.length, off + 32768))])));
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.concat([...framed, PKT_FLUSH]) };
}

export function handleGit(req: GitRequest): GitResponse | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.path);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]!);
  const repoName = decodeURIComponent(m[2]!);
  const suffix = m[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404('Not Found');
  if (req.method === 'GET' && suffix === '/info/refs') {
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json404('Not Found');
    const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
    return { status: 200, headers: { 'content-type': `application/x-${service}-advertisement` }, body };
  }
  if (req.method === 'POST' && suffix === '/git-upload-pack') {
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      return isV2 ? handleUploadPackV2(repo, req.body) : handleUploadPackV0(repo, req.body);
    } catch {
      return text(400, 'malformed request');
    }
  }
  if (req.method === 'POST' && suffix === '/git-receive-pack') {
    try {
      return handleReceivePack(repo, req.body);
    } catch {
      return text(400, 'malformed request');
    }
  }
  return json404('Not Found');
}
