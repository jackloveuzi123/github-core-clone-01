// The Model Context Protocol streamable-HTTP endpoint: JSON-RPC over POST /mcp, serving the
// github-mcp-server tool surface the suite drives (modern `server/discover`, with the legacy
// `initialize` handshake answered too).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mergePull } from './rest.ts';
import { type Issue, type PullRequest, type Store } from './store.ts';

const PREFERRED = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];

const SERVER_INFO = { name: 'forge01-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
  },
];

function toolSchema(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'object',
    properties: tool.properties,
    required: tool.required,
  };
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function issueOut(issue: Issue): Record<string, unknown> {
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state, id: issue.id };
}

function repoOut(store: Store, owner: string, name: string): Record<string, unknown> {
  const repo = store.findRepo(owner, name)!;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function runTool(store: Store, login: string, name: string, args: Record<string, unknown>): { content: unknown; isError?: boolean } {
  const text = (value: unknown): { content: unknown } => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const str = (key: string): string => String(args[key] ?? '');
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      const created = store.createRepo(login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true, 'main');
      if (created === null) return { content: [{ type: 'text', text: 'repository already exists' }], isError: true };
      return text(repoOut(store, login, repoName));
    }
    case 'get_repo': {
      const repo = store.findRepo(str('owner'), str('repo'));
      if (!repo) return { content: [{ type: 'text', text: 'Not Found' }], isError: true };
      return text(repoOut(store, str('owner'), str('repo')));
    }
    case 'create_issue': {
      const repo = store.findRepo(str('owner'), str('repo'));
      if (!repo) return { content: [{ type: 'text', text: 'Not Found' }], isError: true };
      const seqNo = repo.issueSeqNo++;
      const issue: Issue = {
        id: repo.issueSeq++,
        number: seqNo,
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: repo.createdAt * 1000 + seqNo,
        seq: repo.createdAt * 1000 + seqNo,
        comments: [],
        globalId: `I_${repo.id}_${seqNo}`,
      };
      repo.issues.set(issue.number, issue);
      store.globalIds.set(issue.globalId, { kind: 'issue', owner: repo.owner, repo: repo.name, number: issue.number });
      return text(issueOut(issue));
    }
    case 'list_issues': {
      const repo = store.findRepo(str('owner'), str('repo'));
      if (!repo) return { content: [{ type: 'text', text: 'Not Found' }], isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return text(list.map(issueOut));
    }
    case 'create_pull_request': {
      const repo = store.findRepo(str('owner'), str('repo'));
      if (!repo) return { content: [{ type: 'text', text: 'Not Found' }], isError: true };
      const head = str('head');
      const base = str('base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { content: [{ type: 'text', text: 'head or base branch does not exist' }], isError: true };
      const pull: PullRequest = {
        number: repo.pullSeqNo++,
        title: str('title'),
        body: '',
        head,
        base,
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        headSha,
        baseSha,
        createdAt: 0,
        seq: 0,
        globalId: `PR_${repo.id}_${repo.pullSeqNo - 1}`,
      };
      repo.pulls.set(pull.number, pull);
      store.globalIds.set(pull.globalId, { kind: 'pull', owner: repo.owner, repo: repo.name, number: pull.number });
      return text({ number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: 'open', merged: false });
    }
    case 'merge_pull_request': {
      const repo = store.findRepo(str('owner'), str('repo'));
      const number = Number(args.pull_number ?? args.pullNumber ?? 0);
      const pull = repo?.pulls.get(number);
      if (!repo || !pull) return { content: [{ type: 'text', text: 'Not Found' }], isError: true };
      const merged = mergePull(repo, pull);
      if (!merged.ok) return { content: [{ type: 'text', text: merged.reason ?? 'merge conflict' }], isError: true };
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = merged.sha!;
      return text({ number: pull.number, merged: true, sha: merged.sha });
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

/** Handle one request on the MCP endpoint; returns whether an answer was written. */
export function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  body: Buffer,
  login: string | null,
  store: Store,
): boolean {
  if (method !== 'POST') return false;
  const send = (status: number, payload: string): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (login === null) {
    send(401, JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    const text = rpcError(null, -32700, 'Parse error');
    send(400, text);
    return true;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const answers = entries.map((entry) => {
    const record = (entry ?? {}) as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = record.id ?? null;
    const params = record.params ?? {};
    switch (record.method) {
      case 'server/discover':
        return rpcResult(id, {
          supportedVersions: [PREFERRED],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'A git forge speaking the github-mcp-server tool surface.',
        });
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: LEGACY[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'notifications/initialized':
        return null; // a notification: no answer
      case 'tools/list':
        return rpcResult(id, {
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: toolSchema(tool) })),
        });
      case 'tools/call': {
        const name = String((params.name as string) ?? '');
        const tool = TOOLS.find((candidate) => candidate.name === name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const missing = missingRequired(tool, args);
        if (missing.length > 0) {
          return rpcResult(id, {
            content: [{ type: 'text', text: `missing required arguments: ${missing.join(', ')}` }],
            isError: true,
          });
        }
        try {
          return rpcResult(id, runTool(store, login, name, args));
        } catch (error) {
          return rpcResult(id, { content: [{ type: 'text', text: String((error as Error).message) }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${record.method ?? ''}`);
    }
  });
  const out = answers.filter((answer) => answer !== null);
  const payload = Array.isArray(parsed) ? JSON.stringify(out) : (out[0] ?? '');
  send(200, payload as string);
  return true;
}
