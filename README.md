# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jackloveuzi123/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jackloveuzi123/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

**github-core-clone-01** — an entry in make.fun's "Build a GitHub-compatible git forge" bounty: one Node 22 process, standard library only, that serves the four surfaces GitHub's own tooling speaks — git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API for repositories, issues, pull requests and contents; the GraphQL v4 API gh and github-mcp-server send; and a Model Context Protocol endpoint — from its own in-memory store, with no git binary and no outside service. SPDX-License-Identifier: MIT.

## Run

```sh
node main.ts        # binds an ephemeral port, registers it with $MAKEFUN_ENV_URL, polls /done
```

## Layout

- `main.ts` — the entrypoint: binds an ephemeral port, POSTs it to the env's /register, polls GET /done until the trial ends, exits 0
- `app.ts` — the HTTP server that wires the four surfaces onto one store
- `src/githttp.ts` — git smart HTTP: the v2 capability advertisement, ls-refs, upload-pack (shallow clone, deepen, incremental fetch), receive-pack (report-status, side-band-64k, fast-forward enforcement)
- `src/pack.ts` — packfile read and write: object headers, zlib inflation, SHA-1 trailer
- `src/store.ts` — the object and API model: refs, commits, trees, blobs, the reachable-object walk, global ids
- `src/rest.ts` — REST v3: repositories, contents, labels, issues, comments, pulls and merges, Link pagination
- `src/graphql.ts` — GraphQL v4: a small parser and executor over the same store (queries, mutations, batching, introspection)
- `src/mcp.ts` — MCP over Streamable HTTP: server/discover, tools/list and the six github-mcp-server tools
- `src/scenario.ts` — the fixed seed the suite's data comes from

## Development

`serve-dev.ts` runs the same app on a fixed local port for the suite's practice runner:

```sh
node --experimental-strip-types serve-dev.ts
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8099 --token "$TOKEN"
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=mellow-meteor-31&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
