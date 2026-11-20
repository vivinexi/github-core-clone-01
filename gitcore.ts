// gitcore.ts — pure-TypeScript git object model, pkt-line framing and packfiles.
// Node stdlib only (node:crypto, node:zlib). No git binary, no network, no clock.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { readonly type: GitObjectType; readonly data: Buffer; }

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export interface TreeEntry { readonly mode: string; readonly name: string; readonly oid: string; }

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('malformed tree object');
    entries.push({ mode: buf.subarray(off, sp).toString('ascii'), name: buf.subarray(sp + 1, nul).toString('utf8'), oid: buf.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string; readonly parents: string[];
  readonly author: string; readonly committer: string; readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(o: { tree: string; parents?: readonly string[]; message: string; author: string; committer: string }): Buffer {
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${o.author}`, `committer ${o.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

export interface TagView { readonly object: string; readonly type: GitObjectType; readonly tag: string; readonly tagger: string; readonly message: string; }

export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '', type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag object (recursively) to the commit/tree/blob it names. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let cur = oid; const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null; seen.add(cur);
    const obj = objects.get(cur); if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return cur;
  }
}

/** Every object reachable from roots (commit -> tree+parents, tag -> target, tree -> entries). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>(); const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid); if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree); for (const p of c.parents) queue.push(p); }
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `oid`, following commit parents. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>(); const queue = [oid];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue; seen.add(cur);
    const obj = objects.get(cur); if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

/** Split a buffer into pkt-line packets; returns packets and the byte offset where framing stopped (raw tail). */
export function parsePktLines(buf: Buffer): { packets: { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }[]; restOffset: number } {
  const packets: { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, restOffset: off };
}

// ---------------------------------------------------------------- packfile

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]; const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]; let off = start + 1; let value = byte & 0x7f;
  while (byte & 0x80) { byte = buf[off++]; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: off };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const b = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const d = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) { const byte = d[off++]; v += (byte & 0x7f) * 2 ** sh; sh += 7; if (!(byte & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== b.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0; let copySize = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) copyOff += d[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) copySize += d[off++] * 2 ** sh; sh += 8; }
      if (copySize === 0) copySize = 0x10000;
      b.copy(out, written, copyOff, copyOff + copySize); written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      d.copy(out, written, off, off + lit); off += lit; written += lit;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number; typeCode: number; size: number; data: Buffer;
  baseOffset?: number; baseOid?: string;
  resolved?: Buffer; resolvedType?: GitObjectType; oid?: string;
}

/** Read a packfile (v2/v3), resolving OFS/REF deltas. `resolveBase` supplies thin-pack bases. */
export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const raw: RawEntry[] = []; const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const header = readVarintSize(buf, off); off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) { const base = readOfsDeltaBase(buf, off); off = base.next; entry.baseOffset = entryOffset - base.baseOffset; }
    else if (typeCode === 7) { entry.baseOid = buf.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type code ${typeCode}`);
    const inflated = inflateSync(buf.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry); byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType; let data: Buffer;
    if (entry.typeCode === 6) {
      const base = resolve(byOffset.get(entry.baseOffset!)!);
      type = base.type; data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) { const base = resolve(baseEntry); type = base.type; data = applyDelta(base.data, entry.data); }
      else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error(`ref-delta base ${entry.baseOid} missing`);
        type = ext.type; data = applyDelta(ext.data, entry.data);
      }
    } else { type = CODE_TYPE[entry.typeCode]; data = entry.data; }
    const oid = hashObject(type, data);
    entry.resolved = data; entry.resolvedType = type; entry.oid = oid;
    resolvedByOid.set(oid, entry); resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}
