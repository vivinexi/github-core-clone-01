// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Modern era: server/discover answers supportedVersions including 2026-07-28;
// the legacy initialize handshake is answered too.

import { store, VIEWER_LOGIN, repoJson, issueJson, pullJson } from './store.ts';
import type { Repo } from './store.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'create_repo', description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo', 'title'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'list_issues', description: 'List issues of a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo', 'title', 'head', 'base'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'merge_pull_request', description: 'Squash-merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo', 'pull_number'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'get_issue', description: 'Get one issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo', 'issue_number'], additionalProperties: false },
  }),
  Object.freeze({
    name: 'list_repos', description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }),
]);

const TOOL_NAMES: Set<string> = new Set(TOOLS.map((t) => t.name));

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) { owner = owner || parts[0]!; repo = repo || parts[1]!; }
  }
  return { owner, repo };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const canonical = [...TOOL_NAMES].find((n) => norm === n.replace(/[^a-z0-9]/g, '') || norm.endsWith(n.replace(/[^a-z0-9]/g, '')));
  if (!canonical) return toolErr(`unknown tool ${name}`);
  const required: Record<string, string[]> = {
    create_repo: ['name'], get_repo: ['owner', 'repo'], create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'], create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'], get_issue: ['owner', 'repo', 'issue_number'],
    list_repos: [],
  };
  const { owner, repo: repoName } = splitFullName(args);
  const eff: Record<string, unknown> = { ...args, owner, repo: repoName };
  const missing = (required[canonical] ?? []).filter((k) => {
    if (k === 'owner' && owner) return false;
    if (k === 'repo' && repoName) return false;
    return eff[k] === undefined || eff[k] === null || eff[k] === '';
  });
  if (missing.length) return toolErr(`missing required argument(s): ${missing.join(', ')}`);
  switch (canonical) {
    case 'create_repo': {
      const repoNameArg = String(eff.name);
      let repo: Repo | null | undefined = store.getRepo(VIEWER_LOGIN, repoNameArg);
      if (!repo) {
        repo = store.createRepo(repoNameArg, { description: typeof eff.description === 'string' ? eff.description : '', private: eff.private === true });
        if (!repo) return toolErr(`repository ${repoNameArg} already exists`);
      }
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(eff.title), typeof eff.body === 'string' ? eff.body : '', []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      const state = typeof eff.state === 'string' ? eff.state.toLowerCase() : 'open';
      if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      const list = issues.map((i) => issueJson(repo, i));
      return toolOk({ issues: list });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      const created = store.createPull(repo, String(eff.title), typeof eff.body === 'string' ? eff.body : '', String(eff.head), String(eff.base));
      if ('error' in created) return toolErr(created.error);
      return toolOk(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      const pr = repo.pulls.get(Number(eff.pull_number));
      if (!pr) return toolErr(`pull request ${String(eff.pull_number)} not found`);
      const merged = store.squashMerge(repo, pr);
      if ('conflict' in merged) return toolErr('pull request has conflicts');
      if ('error' in merged) return toolErr(merged.error);
      return toolOk({ sha: merged.sha, merged: true, message: `Merged pull request #${pr.number}` });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo || repo.owner !== VIEWER_LOGIN) return toolErr(`repository ${owner}/${repoName} not found`);
      const issue = repo.issues.get(Number(eff.issue_number));
      if (!issue) return toolErr(`issue ${String(eff.issue_number)} not found`);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_repos': {
      return toolOk({ repositories: store.listRepos(VIEWER_LOGIN).map((r: Repo) => repoJson(r)) });
    }
    default: return toolErr(`unknown tool ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

/** Handle one POST /mcp body (raw text). Returns {status, contentType, body}. */
export function handleMcp(rawBody: string): { status: number; contentType: string; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n' };
  }
  const handleOne = (req: unknown): Record<string, unknown> | null => {
    if (req === null || typeof req !== 'object' || Array.isArray(req)) return rpcError(null, -32600, 'Invalid Request');
    const r = req as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = r.id ?? null;
    const method = typeof r.method === 'string' ? r.method : '';
    const params = (r.params ?? {}) as Record<string, unknown>;
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null; // notification: no response
    if (method === 'server/discover') {
      return rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_NAMES.has(name) && ![...TOOL_NAMES].some((n) => name.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith(n.replace(/[^a-z0-9]/g, '')))) {
        return rpcError(id, -32601, `Method not found: tools/call ${name}`);
      }
      return rpcResult(id, callTool(name, args));
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  };
  if (Array.isArray(parsed)) {
    const out = parsed.map(handleOne).filter((x) => x !== null);
    return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(out) + '\n' };
  }
  const single = handleOne(parsed);
  if (single === null) return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(single) + '\n' };
}
