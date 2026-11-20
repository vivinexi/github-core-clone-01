// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4, MCP.
// Node stdlib only. Every JSON reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  store, VIEWER_LOGIN, VIEWER_ID, repoJson, issueJson, pullJson, commentJson, labelJson, commitJson,
} from './store.ts';
import type { Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestSeq = 0;

function nextRequestId(): string { requestSeq += 1; return `req-${requestSeq}`; }

function isAuthed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (TOKEN !== '') return token === TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  // One buffer, sized once: the old code stringified, then re-scanned the text
  // for its byte length before writing it.
  const buf = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': nextRequestId(), ...extra });
  res.end(buf);
}
/** Send an already-serialized JSON body (built once and reused, e.g. a cached issue body). */
function sendJsonText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(text);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': nextRequestId(), ...extra });
  res.end(buf);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...extra });
  res.end(body);
}
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false };
    return { ok: true, value: v as Record<string, unknown> };
  } catch { return { ok: false }; }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function paginate<T>(req: IncomingMessage, q: URLSearchParams, path: string, items: T[]): { page: T[]; link: string | null } {
  let perPage = Number(q.get('per_page') ?? '30');
  if (!Number.isFinite(perPage) || perPage <= 0) perPage = 30;
  perPage = Math.min(100, Math.trunc(perPage));
  let page = Number(q.get('page') ?? '1');
  if (!Number.isFinite(page) || page <= 0) page = 1;
  page = Math.trunc(page);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (totalPages > 1) {
    const base = baseUrlOf(req);
    const mk = (p: number): string => `<${base}${path}?per_page=${perPage}&page=${p}>`;
    const parts: string[] = [];
    if (page < totalPages) parts.push(`${mk(page + 1)}; rel="next"`);
    if (page > 1) parts.push(`${mk(page - 1)}; rel="prev"`);
    parts.push(`${mk(1)}; rel="first"`);
    parts.push(`${mk(totalPages)}; rel="last"`);
    link = parts.join(', ');
  }
  return { page: slice, link };
}

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) { sendJson(res, 404, { message: 'Not Found' }); return null; }
  const repo = store.getRepo(owner, name);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return null; }
  return repo;
}

function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        try { sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }); } catch { /* socket gone */ }
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  // One URL parse per request: pathOf/queryOf each built a URL of their own,
  // and handleRest/paginate parsed it again, so a request paid for the same
  // parse up to four times.
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://entry'); } catch { url = new URL('/', 'http://entry'); }
  const path = url.pathname;
  const query = url.searchParams;

  if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

  // Git smart HTTP (no bearer check: git clients speak it unauthenticated here).
  if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
    // A GET carries no body, and the only header git needs is git-protocol:
    // skip the body drain and the copy of every header.
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const proto = req.headers['git-protocol'];
    const headers: Record<string, string | undefined> = { 'git-protocol': Array.isArray(proto) ? proto[0] : proto };
    const out = handleGit({ method, path, query, headers, body });
    if (out) {
      res.writeHead(out.status, { ...out.headers, 'x-github-request-id': nextRequestId(), 'content-length': out.body.length });
      res.end(out.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!isAuthed(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
    const raw = await readBody(req);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
    const { status, payload } = executeGraphQL(parsed);
    sendJson(res, status, payload);
    return;
  }

  // MCP
  if (path === '/mcp') {
    if (method === 'DELETE') { res.writeHead(200, { 'x-github-request-id': nextRequestId() }); res.end(); return; }
    if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (!isAuthed(req)) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }) + '\n';
      res.writeHead(401, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), 'x-github-request-id': nextRequestId() });
      res.end(body);
      return;
    }
    const raw = await readBody(req);
    const out = handleMcp(raw.toString('utf8'));
    res.writeHead(out.status, { 'content-type': out.contentType, 'content-length': Buffer.byteLength(out.body), 'x-github-request-id': nextRequestId() });
    res.end(out.body);
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthed(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
    await handleRest(req, res, method, path, query);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams): Promise<void> {
  const rest = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (needsBody) {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
    body = parsed.value;
  }

  // API root + meta + user
  if ((rest === '/' || rest === '') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest === '/meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return;
  }
  if (rest === '/user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: '', avatar_url: '', type: 'User', site_admin: false, name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` });
    return;
  }

  // POST /user/repos, GET /user/repos
  if (rest === '/user/repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { sendJson(res, 422, { message: 'Invalid repository name' }); return; }
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
      });
      if (!repo) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN).map((r) => repoJson(r));
      const { page, link } = paginate(req, query, '/api/v3/user/repos', repos);
      sendJson(res, 200, page, link ? { link } : {});
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
  if (!repoMatch) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const owner = decodePath(repoMatch[1]!);
  const repoName = decodePath(repoMatch[2]!);
  const tail = repoMatch[3] ?? '';

  // /repos/{o}/{r} itself
  if (tail === '' || tail === '/') {
    if (method === 'GET') {
      const repo = repoOr404(res, owner, repoName); if (!repo) return;
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'PATCH') {
      const repo = repoOr404(res, owner, repoName); if (!repo) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      store.touch(repo);
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') {
      const repo = repoOr404(res, owner, repoName); if (!repo) return;
      store.deleteRepo(owner, repoName);
      sendNoContent(res); return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const repo = repoOr404(res, owner, repoName);
  if (!repo) return;

  // branches
  if (tail === '/branches' && method === 'GET') {
    const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => {
      const name = r.slice('refs/heads/'.length);
      return { name, commit: { sha: repo.refs.get(r), url: '' }, protected: false };
    });
    sendJson(res, 200, list); return;
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(tail);
  if (branchMatch && method === 'GET') {
    const branch = decodePath(branchMatch[1]!);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) { sendJson(res, 404, { message: 'Branch not found' }); return; }
    sendJson(res, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false }); return;
  }

  // commits
  if (tail === '/commits' && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
      if (!tip) { sendJson(res, 404, { message: 'No commit found for SHA' }); return; }
    } else tip = store.defaultTip(repo);
    if (!tip) { sendJson(res, 200, []); return; }
    const chain = store.commitChain(repo, tip).map((s) => commitJson(repo, s)).filter((c): c is Record<string, unknown> => c !== null);
    const { page, link } = paginate(req, query, path, chain);
    sendJson(res, 200, page, link ? { link } : {});
    return;
  }

  // git refs
  if (tail === '/git/refs' && method === 'POST') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!/^refs\/(heads|tags)\/.+/.test(ref) || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Invalid ref or sha' }); return; }
    if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
    repo.refs.set(ref, sha);
    store.touch(repo);
    sendJson(res, 201, { ref, node_id: '', object: { sha, type: 'commit', url: '' }, url: '' });
    return;
  }
  if (tail === '/git/refs' && method === 'GET') {
    const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: '', object: { sha, type: 'commit', url: '' }, url: '' }));
    sendJson(res, 200, list); return;
  }
  const refHeadMatch = /^\/git\/refs\/heads\/(.+)$/.exec(tail);
  if (refHeadMatch && method === 'GET') {
    const branch = decodePath(refHeadMatch[1]!);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: '', object: { sha: tip, type: 'commit', url: '' }, url: '' });
    return;
  }
  const refTagMatch = /^\/git\/refs\/tags\/(.+)$/.exec(tail);
  if (refTagMatch && method === 'GET') {
    const tag = decodePath(refTagMatch[1]!);
    const tip = repo.refs.get(`refs/tags/${tag}`);
    if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { ref: `refs/tags/${tag}`, node_id: '', object: { sha: tip, type: 'tag', url: '' }, url: '' });
    return;
  }

  // contents
  const contentsMatch = /^\/contents(\/(.*))?$/.exec(tail);
  if (contentsMatch) {
    await handleContents(req, res, repo, method, contentsMatch[2] ?? '', query, body);
    return;
  }

  // labels
  if (tail === '/labels') {
    if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l))); return; }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendJson(res, 422, { message: 'Label name is required' }); return; }
      const label = store.createLabel(repo, name, typeof body.color === 'string' ? body.color : undefined);
      sendJson(res, 201, labelJson(repo, label)); return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // issues
  if (tail === '/issues' && method === 'GET') {
    let list = [...repo.issues.values()];
    const state = (query.get('state') ?? 'open').toLowerCase();
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    const sort = query.get('sort') ?? 'created';
    const direction = (query.get('direction') ?? 'desc').toLowerCase();
    if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
    const { page, link } = paginate(req, query, path, list.map((i) => issueJson(repo, i)));
    sendJson(res, 200, page, link ? { link } : {});
    return;
  }
  if (tail === '/issues' && method === 'POST') {
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') { sendJson(res, 422, { message: 'Title is required' }); return; }
    const rawLabels = Array.isArray(body.labels) ? body.labels : [];
    const labels: { id: number; name: string; color: string; description: string }[] = [];
    for (const raw of rawLabels) {
      const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? String((raw as Record<string, unknown>).name ?? '') : '';
      const found = repo.labels.get(name);
      if (!found) { sendJson(res, 422, { message: `Label "${name}" does not exist` }); return; }
      labels.push(found);
    }
    const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
    sendJson(res, 201, issueJson(repo, issue));
    return;
  }
  const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(tail);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.get(number);
    const sub = issueMatch[2] ?? '';
    if (sub === '/comments') {
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, (repo.comments.get(number) ?? []).map((c) => commentJson(repo, c))); return; }
      if (method === 'POST') {
        const text = typeof body.body === 'string' ? body.body : '';
        const comment = store.addComment(repo, number, text);
        if (!comment) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 201, commentJson(repo, comment)); return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (sub === '' || sub === '/') {
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') {
        // The read workload fetches the same issue 2,000 times in a row: the
        // serialized body is a pure function of the repo's version, so keep
        // one copy per issue and reuse it until the repo changes.
        const cached = repo.issueJsonCache.get(number);
        if (cached !== undefined && cached.version === repo.version) { sendJsonText(res, 200, cached.text); return; }
        const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
        repo.issueJsonCache.set(number, { version: repo.version, text });
        sendJsonText(res, 200, text);
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') { issue.state = body.state; issue.closedAt = body.state === 'closed' ? '2023-11-14T22:13:20Z' : null; }
        store.touch(repo);
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // pulls
  if (tail === '/pulls' && method === 'GET') {
    let list = [...repo.pulls.values()];
    const state = (query.get('state') ?? 'open').toLowerCase();
    if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.number - a.number);
    const { page, link } = paginate(req, query, path, list.map((p) => pullJson(repo, p)));
    sendJson(res, 200, page, link ? { link } : {});
    return;
  }
  if (tail === '/pulls' && method === 'POST') {
    const title = typeof body.title === 'string' ? body.title : '';
    const headRaw = typeof body.head === 'string' ? body.head : '';
    const baseRaw = typeof body.base === 'string' ? body.base : '';
    const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
    const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
    if (title === '' || head === '' || base === '') { sendJson(res, 422, { message: 'title, head and base are required' }); return; }
    const created = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
    if ('error' in created) { sendJson(res, 422, { message: created.error }); return; }
    sendJson(res, 201, pullJson(repo, created));
    return;
  }
  const pullMatch = /^\/pulls\/(\d+)(\/.*)?$/.exec(tail);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const pull = repo.pulls.get(number);
    const sub = pullMatch[2] ?? '';
    if (sub === '/files' && method === 'GET') {
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, patch: '', sha: '', blob_url: '', raw_url: '' })));
      return;
    }
    if (sub === '/merge' && method === 'PUT') {
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (pull.state !== 'open') { sendJson(res, 405, { message: 'Pull request is not open' }); return; }
      const merged = store.squashMerge(repo, pull);
      if ('conflict' in merged) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
      if ('error' in merged) { sendJson(res, 405, { message: merged.error }); return; }
      sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${number} successfully merged` });
      return;
    }
    if ((sub === '' || sub === '/') && method === 'GET') {
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, pullJson(repo, pull)); return;
    }
    if ((sub === '' || sub === '/') && method === 'PATCH') {
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state === 'open') pull.state = 'closed';
      store.touch(repo);
      sendJson(res, 200, pullJson(repo, pull)); return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, method: string, rawPath: string, query: URLSearchParams, body: Record<string, unknown>): Promise<void> {
  const filePath = decodePath(rawPath).replace(/^\/+/, '').replace(/\/+$/, '');
  const refParam = query.get('ref');
  const resolveTip = (): string | undefined => {
    if (!refParam) return store.defaultTip(repo);
    const branchTip = repo.refs.get(`refs/heads/${refParam}`);
    if (branchTip) return branchTip;
    if (repo.objects.has(refParam)) return refParam;
    return undefined;
  };
  const branchOf = (): string => {
    if (!refParam) return repo.defaultBranch;
    if (repo.refs.has(`refs/heads/${refParam}`)) return refParam;
    return repo.defaultBranch;
  };

  if (method === 'GET') {
    const tip = resolveTip();
    if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const commitObj = repo.objects.get(tip);
    if (!commitObj || commitObj.type !== 'commit') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const { parseCommit: pc, parseTree: pt } = await import('./gitcore.ts');
    const files = store.treeMap(repo, pc(commitObj.data).tree);
    if (filePath !== '') {
      const entry = files.get(filePath);
      if (entry) {
        const blob = repo.objects.get(entry.oid)!;
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', content: blob.data.toString('base64'), sha: entry.oid,
          size: blob.data.length, name: filePath.split('/').pop(), path: filePath,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
          html_url: `/${repo.owner}/${repo.name}/blob/${branchOf()}/${filePath}`, download_url: null, git_url: '', _links: {},
        });
        return;
      }
      // directory?
      const prefix = `${filePath}/`;
      const children = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
      for (const [p, e] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const seg = rest.split('/')[0]!;
        if (rest.includes('/')) {
          if (!children.has(seg)) children.set(seg, { type: 'dir', name: seg, path: `${filePath}/${seg}`, sha: '', size: 0 });
        } else {
          const blob = repo.objects.get(e.oid)!;
          children.set(seg, { type: 'file', name: seg, path: p, sha: e.oid, size: blob.data.length });
        }
      }
      if (children.size === 0) { sendJson(res, 404, { message: 'Not Found' }); return; }
      // directory sha: hash of the subtree object
      const out = [...children.values()].map((c) => ({
        ...c,
        sha: c.type === 'dir' ? dirSha(repo, tip, c.path) : c.sha,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${c.path}`,
        html_url: `/${repo.owner}/${repo.name}/tree/${branchOf()}/${c.path}`, download_url: null, git_url: '', _links: {},
      }));
      sendJson(res, 200, out);
      return;
    }
    // root listing
    const children = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
    for (const [p, e] of files) {
      const seg = p.split('/')[0]!;
      if (p.includes('/')) {
        if (!children.has(seg)) children.set(seg, { type: 'dir', name: seg, path: seg, sha: '', size: 0 });
      } else {
        const blob = repo.objects.get(e.oid)!;
        children.set(seg, { type: 'file', name: seg, path: p, sha: e.oid, size: blob.data.length });
      }
    }
    const out = [...children.values()].map((c) => ({
      ...c,
      sha: c.type === 'dir' ? dirSha(repo, tip, c.path) : c.sha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${c.path}`,
      html_url: `/${repo.owner}/${repo.name}/tree/${branchOf()}/${c.path}`, download_url: null, git_url: '', _links: {},
    }));
    sendJson(res, 200, out);
    return;
  }

  if (method === 'PUT') {
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (contentB64 === '') { sendJson(res, 422, { message: 'content is required' }); return; }
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    // A new branch forks from the default tip (the MCP setup's contents fallback).
    if (!repo.refs.has(`refs/heads/${branch}`) && branch !== repo.defaultBranch) {
      const defTip = store.defaultTip(repo);
      if (defTip) repo.refs.set(`refs/heads/${branch}`, defTip);
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const current = tip ? store.fileAt(repo, tip, filePath) : undefined;
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (!current) { sendJson(res, 409, { message: 'sha does not match' }); return; }
      if (current.oid.toLowerCase() !== body.sha.toLowerCase()) { sendJson(res, 409, { message: 'sha does not match' }); return; }
    } else if (current) {
      sendJson(res, 422, { message: 'sha is required to update a file' });
      return;
    }
    const result = store.commitFile(repo, branch, filePath, content, message);
    sendJson(res, result.existed ? 200 : 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64, url: '', html_url: '', download_url: null, git_url: '', _links: {} },
      commit: { sha: result.commitSha, message, node_id: '', url: '', html_url: '' },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    const deleted = store.deleteFile(repo, branch, filePath, message);
    if (!deleted) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { commit: { sha: deleted.commitSha, message, node_id: '', url: '', html_url: '' }, content: null });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function dirSha(repo: Repo, tip: string, dirPath: string): string {
  const { parseCommit, parseTree } = requireGitcore();
  const commitObj = repo.objects.get(tip);
  if (!commitObj) return '';
  let treeOid = parseCommit(commitObj.data).tree;
  for (const seg of dirPath.split('/')) {
    const obj = repo.objects.get(treeOid);
    if (!obj) return '';
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (!entry) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

// Small indirection so dirSha stays synchronous without a top-level import cycle cost.
import { parseCommit as _pc, parseTree as _pt } from './gitcore.ts';
function requireGitcore(): { parseCommit: typeof _pc; parseTree: typeof _pt } {
  return { parseCommit: _pc, parseTree: _pt };
}
