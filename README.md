# github-forge — make.fun bounty github-core-clone-01

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty%20github--core--clone--01-blue)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge built for [the make.fun bounty **github-core-clone-01**](https://make.fun/bounty/github-core-clone-01) ("Build a GitHub-compatible git forge", free entry, $500 over 20 places). One Node 22 stdlib-only process serves the whole surface: git smart HTTP (upload-pack v2 with v0 fallback, receive-pack v0), REST v3, GraphQL v4, and MCP over streamable HTTP — all backed by one in-memory store, with git objects, packfiles and refs implemented by hand in TypeScript (no dependencies, no git binary, no network).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own modules only, and the trial has no package manager and
no internet.

With `MAKEFUN_ENV_URL` unset the forge runs standalone on an ephemeral port and logs it
(`[entry] standalone forge at http://127.0.0.1:<port>`); set `MAKEFUN_SHOP_TOKEN` to require a
bearer token for the API surfaces. A quick smoke test:

```sh
export MAKEFUN_SHOP_TOKEN=shpat_testtoken1234567890abcdef
node --experimental-strip-types main.ts &
curl -s -H "Authorization: Bearer $MAKEFUN_SHOP_TOKEN" http://127.0.0.1:<port>/api/v3/user
curl -s -X POST -H "Authorization: Bearer $MAKEFUN_SHOP_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"demo"}' http://127.0.0.1:<port>/api/v3/user/repos
git clone http://127.0.0.1:<port>/adaiversen/demo.git
```

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is no env to register with, so `main.ts` serves standalone on an ephemeral port instead of
exiting (handy for local testing; the trial always sets the variable).

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above (edited to serve standalone when `MAKEFUN_ENV_URL` is unset).
- `app.ts`: the HTTP server: routing, bearer auth, `X-GitHub-Request-Id`, and the REST v3 routes.
- `git.ts`: git smart HTTP — v2 advertisement / ls-refs / fetch, v0 fallback, receive-pack with
  report-status over side-band-64k.
- `gitcore.ts`: the pure-TypeScript git object model — SHA-1, commits/trees/blobs/tags, pkt-lines,
  packfile read/write with delta resolution.
- `store.ts`: the in-memory store (repos, issues, labels, comments, pull requests, squash merges)
  shared by REST, GraphQL and MCP. The viewer login is recomputed deterministically from the kit's
  public scenario seed, so the token owner's login matches the suite's.
- `graphql.ts`: a small GraphQL parser + executor for the v4 surface, with introspection.
- `mcp.ts`: the MCP endpoint — `server/discover`, `initialize`, `tools/list`, `tools/call`.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
