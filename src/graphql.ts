// A small GraphQL executor for the documents gh and github-mcp-server send, with introspection.
// Context (the repository a subtree belongs to) is threaded down through selection resolution.

import { viewerLogin, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ schema (introspection)

interface Field {
  name: string;
}

const SCHEMA: Record<string, Field[]> = {
  Query: [{ name: 'viewer' }, { name: 'repository' }, { name: 'node' }],
  Mutation: [
    { name: 'createIssue' },
    { name: 'closeIssue' },
    { name: 'createPullRequest' },
    { name: 'mergePullRequest' },
    { name: 'addComment' },
  ],
  User: [{ name: 'login' }, { name: 'id' }],
  Repository: [
    { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' },
    { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' },
    { name: 'issues' }, { name: 'pullRequest' }, { name: 'pullRequests' },
  ],
  RepositoryOwner: [{ name: 'login' }, { name: 'id' }],
  Ref: [{ name: 'name' }, { name: 'id' }],
  Issue: [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'createdAt' }],
  IssueConnection: [{ name: 'nodes' }, { name: 'pageInfo' }],
  PageInfo: [{ name: 'hasNextPage' }, { name: 'endCursor' }],
  PullRequest: [
    { name: 'id' }, { name: 'number' }, { name: 'state' }, { name: 'merged' }, { name: 'headRefName' },
    { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'files' }, { name: 'createdAt' },
  ],
  PullRequestConnection: [{ name: 'nodes' }, { name: 'pageInfo' }],
  PullRequestChangedFile: [{ name: 'path' }, { name: 'additions' }, { name: 'deletions' }],
  PullRequestFilesConnection: [{ name: 'nodes' }, { name: 'totalCount' }],
  Node: [{ name: 'id' }, { name: 'name' }, { name: 'nameWithOwner' }],
};

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ------------------------------------------------------------------ parser

interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[] | null;
}

class Parser {
  text: string;
  pos = 0;
  variables: Record<string, unknown>;
  constructor(text: string, variables: Record<string, unknown>) {
    this.text = text;
    this.variables = variables;
  }
  skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }
  peek(): string {
    this.skipWs();
    return this.text[this.pos] ?? '';
  }
  name(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos]!)) this.pos += 1;
    return this.text.slice(start, this.pos);
  }
  skipBalanced(open: string, close: string): void {
    this.pos += 1;
    let depth = 1;
    while (depth > 0 && this.pos < this.text.length) {
      const ch = this.text[this.pos++]!;
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      else if (ch === '"') {
        while (this.pos < this.text.length && this.text[this.pos] !== '"') {
          if (this.text[this.pos] === '\\') this.pos += 1;
          this.pos += 1;
        }
        this.pos += 1;
      }
    }
  }
  value(): unknown {
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      const varName = this.name();
      return this.variables[varName] ?? null;
    }
    if (ch === '{') return this.inputObject();
    if (ch === '[') {
      this.pos += 1;
      const list: unknown[] = [];
      while (this.peek() !== ']') {
        if (this.peek() === '') break;
        list.push(this.value());
      }
      this.pos += 1;
      return list;
    }
    if (ch === '"') return this.string();
    if (ch === '-') {
      this.pos += 1;
      return -Number(this.name());
    }
    const token = this.name();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^\d+$/.test(token)) return Number(token);
    return token;
  }
  string(): string {
    this.pos += 1; // opening quote
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++]!;
      if (ch === '\\' && this.pos < this.text.length) {
        const next = this.text[this.pos++]!;
        if (next === '"') out += '"';
        else if (next === 'n') out += '\n';
        else if (next === '\\') out += '\\';
        else out += next;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  inputObject(): Record<string, unknown> {
    this.pos += 1;
    const out: Record<string, unknown> = {};
    while (this.peek() !== '}') {
      if (this.peek() === '') break;
      const key = this.name();
      this.pos += 1; // ':'
      out[key] = this.value();
    }
    this.pos += 1;
    return out;
  }
  arguments(): Record<string, unknown> {
    this.pos += 1;
    const out: Record<string, unknown> = {};
    while (this.peek() !== ')') {
      if (this.peek() === '') break;
      const key = this.name();
      this.pos += 1; // ':'
      out[key] = this.value();
    }
    this.pos += 1;
    return out;
  }
  selectionSet(): Selection[] {
    this.pos += 1; // '{'
    const out: Selection[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === '}') {
        this.pos += 1;
        break;
      }
      if (ch === '') break;
      if (ch === '.') {
        this.pos += 1;
        if (this.text[this.pos] === '.') this.pos += 1;
        if (this.text[this.pos] === '.') this.pos += 1;
        const next = this.peek();
        if (next === 'o' && this.text.slice(this.pos, this.pos + 3) === 'on ') {
          this.pos += 2;
          this.name(); // TypeName
          this.skipWs();
          out.push(...this.selectionSet());
        } else {
          const fragName = this.name();
          out.push({ name: `__frag:${fragName}`, alias: null, args: {}, selections: null });
        }
        continue;
      }
      const fieldName = this.name();
      if (this.peek() === ':') {
        this.pos += 1;
        const realName = this.name();
        out.push(this.field(realName, fieldName));
        continue;
      }
      out.push(this.field(fieldName, null));
    }
    return out;
  }
  field(name: string, alias: string | null): Selection {
    let args: Record<string, unknown> = {};
    if (this.peek() === '(') args = this.arguments();
    let selections: Selection[] | null = null;
    if (this.peek() === '{') selections = this.selectionSet();
    return { name, alias, args, selections };
  }
}

/** Parse every operation document in the body (a batched request carries several). */
const fragments = new Map<string, Selection[]>();

/** Expand `__frag:<name>` selections with the document's fragment definitions. */
function expandFragments(selections: Selection[], depth = 0): Selection[] {
  if (depth > 8) return selections;
  return selections.map((selection) => {
    if (selection.name.startsWith('__frag:')) {
      const body = fragments.get(selection.name.slice('__frag:'.length));
      return body ? expandFragments(body, depth + 1) : { name: '__none', alias: null, args: {}, selections: null };
    }
    return selection.selections ? { ...selection, selections: expandFragments(selection.selections, depth + 1) } : selection;
  });
}

export function parseDocument(text: string, variables: Record<string, unknown>): Selection[][] {
  const parser = new Parser(text, variables);
  fragments.clear();
  const operations: Selection[][] = [];
  for (;;) {
    parser.skipWs();
    if (parser.pos >= text.length) break;
    const token = parser.name();
    if (token === 'query' || token === 'mutation' || token === 'subscription') {
      parser.skipWs();
      if (parser.peek() === '(') parser.skipBalanced('(', ')');
      parser.skipWs();
      // An operation name may follow the keyword.
      if (/[A-Za-z_]/.test(parser.text[parser.pos] ?? '')) {
        parser.name();
        parser.skipWs();
        if (parser.peek() === '(') parser.skipBalanced('(', ')');
        parser.skipWs();
      }
      if (parser.peek() !== '{') continue;
      operations.push(parser.selectionSet());
    } else if (token === '{') {
      parser.pos -= token.length;
      operations.push(parser.selectionSet());
    } else if (token === 'fragment') {
      const fragName = parser.name();
      parser.skipWs();
      parser.name(); // on
      parser.skipWs();
      parser.name(); // TypeName
      parser.skipWs();
      if (parser.peek() === '{') {
        fragments.set(fragName, parser.selectionSet());
      }
    } else {
      // Unknown token: advance to avoid an infinite loop.
      parser.pos += 1;
    }
  }
  return operations.map((selections) => expandFragments(selections));
}

// ------------------------------------------------------------------ executor

interface RunResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

interface Ctx {
  store: Store;
  repo: Repo | null;
}

const ROOT_FIELDS = new Set([
  'viewer', 'repository', 'node', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment',
]);

function exec(store: Store, selections: Selection[], obj: unknown, ctx: Ctx, result: RunResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.name === '__none') continue;
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(store, selection, obj, ctx, result);
  }
  return out;
}

function resolveField(store: Store, selection: Selection, obj: unknown, ctx: Ctx, result: RunResult): unknown {
  const name = selection.name;
  if (name === '__typename') return typeNameOf(obj);
  if (name === '__schema' || name === '__type') return introspect(selection);
  if (obj === null || obj === undefined) {
    // The root selections (viewer/repository/node) run against null; any other field is an error.
    if (!ROOT_FIELDS.has(name)) {
      result.errors.push({ message: `${name} resolved to null` });
      return null;
    }
  }
  const record = (obj ?? {}) as Record<string, unknown>;
  const repo = record.__repo ?? ctx.repo;
  switch (name) {
    case 'viewer':
      return sub(selection, { login: viewerLogin(), id: 'U_1' }, ctx, result);
    case 'node': {
      const id = selection.args.id as string;
      const node = store.globalIds.get(id);
      if (!node) {
        if (typeof id === 'string' && id.startsWith('R_')) {
          const found = [...store.reposByFullName.values()].find((candidate) => candidate.globalId === id);
          if (found) return sub(selection, repositoryNode(store, found), { ...ctx, repo: found }, result);
        }
        return null;
      }
      const found = store.findRepo(node.owner, node.repo);
      if (!found) return null;
      if (node.kind === 'repo') return sub(selection, repositoryNode(store, found), { ...ctx, repo: found }, result);
      if (node.kind === 'issue') return sub(selection, issueNode(found.issues.get(node.number)!), ctx, result);
      return sub(selection, pullNode(found, found.pulls.get(node.number)!), ctx, result);
    }
    case 'repository': {
      const found = store.findRepo(selection.args.owner as string, selection.args.name as string);
      if (!found) return null;
      return sub(selection, repositoryNode(store, found), { ...ctx, repo: found }, result);
    }
    case 'id':
      return record.id ?? record.node_id ?? '';
    case 'databaseId':
      return record.databaseId;
    case 'name':
      return record.name;
    case 'nameWithOwner':
      return record.nameWithOwner;
    case 'login':
      return record.login;
    case 'owner':
      return sub(selection, { login: record.ownerLogin ?? record.login ?? viewerLogin() }, ctx, result);
    case 'defaultBranchRef':
      return sub(selection, { name: record.defaultBranch, id: `B_${record.defaultBranch}` }, ctx, result);
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return record.hasIssuesEnabled;
    case 'issue': {
      if (!repo) return null;
      const issue = repo.issues.get(selection.args.number as number);
      if (!issue) return null;
      ctx.store.globalIds.set(issue.globalId, { kind: 'issue', owner: repo.owner, repo: repo.name, number: issue.number });
      return sub(selection, issueNode(issue), ctx, result);
    }
    case 'issues':
      return issuesConnection(store, selection, record, { ...ctx, repo }, result);
    case 'pullRequest': {
      if (!repo) return null;
      const pull = repo.pulls.get(selection.args.number as number);
      if (!pull) return null;
      ctx.store.globalIds.set(pull.globalId, { kind: 'pull', owner: repo.owner, repo: repo.name, number: pull.number });
      return sub(selection, pullNode(repo, pull), ctx, result);
    }
    case 'pullRequests':
      return pullsConnection(selection, record, { ...ctx, repo }, result, store);
    case 'number':
      return record.number;
    case 'title':
      return record.title;
    case 'body':
      return record.body;
    case 'state':
      return record.state;
    case 'merged':
      return record.merged;
    case 'headRefName':
      return record.headRefName;
    case 'baseRefName':
      return record.baseRefName;
    case 'mergeable':
      return record.mergeable;
    case 'files': {
      const files = (record.files as Array<Record<string, unknown>>) ?? [];
      return sub(selection, {
        nodes: files.map((file) => ({ __node: file })),
        totalCount: files.length,
        __plainNodes: true,
      }, ctx, result, 'files');
    }
    case 'nodes': {
      const list = (record.nodes as Array<Record<string, unknown>>) ?? [];
      return list.map((item) => sub(selection, item, ctx, result));
    }
    case 'pageInfo': {
      const info = (record.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
      return sub(selection, info, ctx, result);
    }
    case 'totalCount':
      return record.totalCount;
    case 'path':
      return record.path;
    case 'additions':
      return record.additions;
    case 'deletions':
      return record.deletions;
    case 'createdAt':
      return '2025-01-01T00:00:00Z';
    case 'hasNextPage':
      return record.hasNextPage;
    case 'endCursor':
      return record.endCursor ?? null;
    case 'createIssue':
    case 'closeIssue':
    case 'createPullRequest':
    case 'mergePullRequest':
    case 'addComment':
      return mutate(store, name, selection, (selection.args.input as Record<string, unknown>) ?? {}, ctx, result);
    default:
      result.errors.push({ message: `Field '${name}' doesn't exist on type '${typeNameOf(obj) || 'Query'}' (noSuchFieldOnViewer is reported this way too)` });
      return null;
  }
}

function typeNameOf(obj: unknown): string {
  return ((obj as Record<string, unknown>)?.__typename as string) ?? '';
}

function sub(selection: Selection, obj: Record<string, unknown>, ctx: Ctx, result: RunResult, mode?: string): unknown {
  if (!selection.selections) return obj;
  if (mode === 'files') {
    // files { nodes { path } } — the object already holds `nodes`; each node executes the sub-selections.
    const nodesSel = selection.selections.find((entry) => (entry.alias ?? entry.name) === 'nodes');
    const totalSel = selection.selections.find((entry) => (entry.alias ?? entry.name) === 'totalCount');
    const out: Record<string, unknown> = {};
    if (nodesSel) {
      out.nodes = ((obj.nodes as Array<Record<string, unknown>>) ?? []).map((item) =>
        exec(ctx.store, nodesSel.selections ?? [], item.__node ?? item, ctx, result),
      );
    }
    if (totalSel) out.totalCount = obj.totalCount;
    return out;
  }
  return exec(ctx.store, selection.selections, obj, ctx, result);
}

function introspect(selection: Selection): Record<string, unknown> {
  const typeName = selection.name === '__type' ? (selection.args.name as string) : '';
  const out: Record<string, unknown> = {};
  for (const entry of selection.selections ?? []) {
    const key = entry.alias ?? entry.name;
    if (entry.name === 'fields') {
      out[key] = (SCHEMA[typeName] ?? []).map((field) => resolveIntrospectionEntry(entry, { name: field.name }, '__Field'));
    } else if (entry.name === 'enumValues') {
      out[key] = (ENUMS[typeName] ?? []).map((value) => resolveIntrospectionEntry(entry, { name: value }, '__EnumValue'));
    } else if (entry.name === 'name') {
      out[key] = typeName;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function resolveIntrospectionEntry(selection: Selection, fields: Record<string, unknown>, typeName: string): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: typeName };
  for (const entry of selection.selections ?? []) {
    const key = entry.alias ?? entry.name;
    out[key] = (fields as Record<string, unknown>)[entry.name] ?? null;
  }
  return out;
}

function repositoryNode(store: Store, repo: Repo): Record<string, unknown> {
  store.globalIds.set(repo.globalId, { kind: 'repo', owner: repo.owner, repo: repo.name, number: 0 });
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranch: repo.defaultBranch,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: repo.hasIssues,
  };
}

function issueNode(issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullFilesOf(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const files = diffTrees(repo, null, headTip ?? null);
  return files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }));
}

function pullNode(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    state: pull.merged ? 'MERGED' : 'OPEN',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.merged ? 'MERGEABLE' : mergeableOf(repo, pull),
    files: pullFilesOf(repo, pull),
  };
}

function mergeableOf(repo: Repo, pull: PullRequest): string {
  // A shallow answer: MERGEABLE unless the head tip predates a base change that touched the same path.
  return pull.conflictHint ? 'CONFLICTING' : 'MERGEABLE';
}

function issuesConnection(store: Store, selection: Selection, source: Record<string, unknown>, ctx: Ctx, result: RunResult): Record<string, unknown> {
  const repo = ctx.repo;
  if (!repo) return null as unknown as Record<string, unknown>;
  const first = selection.args.first as number | undefined;
  const after = selection.args.after as string | null | undefined;
  const states = selection.args.states as string[] | undefined;
  const orderBy = selection.args.orderBy as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues.values()];
  if (states && states.length) list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const desc = (orderBy?.direction ?? 'ASC') === 'DESC';
  list.sort((a, b) => {
    const primary = (a.seq - b.seq) * (desc ? -1 : 1);
    return primary !== 0 ? primary : desc ? b.number - a.number : a.number - b.number;
  });
  let start = 0;
  if (after) {
    const decoded = Number(Buffer.from(after, 'base64url').toString('utf8').replace(/^cursor:/, ''));
    if (Number.isFinite(decoded) && decoded > 0) {
      start = list.findIndex((issue) => issue.number > decoded);
      if (start < 0) start = list.length;
    }
  }
  const page = first !== undefined ? list.slice(start, start + first) : list.slice(start);
  const hasNext = start + page.length < list.length;
  const lastNumber = page.length ? page[page.length - 1]!.number : 0;
  const nodesSel = selection.selections?.find((entry) => (entry.alias ?? entry.name) === 'nodes');
  const out: Record<string, unknown> = {
    __typename: 'IssueConnection',
  };
  for (const entry of selection.selections ?? []) {
    const key = entry.alias ?? entry.name;
    if (entry.name === 'nodes') {
      out[key] = page.map((issue) => {
        store.globalIds.set(issue.globalId, { kind: 'issue', owner: repo.owner, repo: repo.name, number: issue.number });
        return exec(store, entry.selections ?? [], issueNode(issue), ctx, result);
      });
    } else if (entry.name === 'pageInfo') {
      out[key] = exec(store, entry.selections ?? [], { hasNextPage: hasNext, endCursor: hasNext ? Buffer.from(`cursor:${lastNumber}`).toString('base64url') : null }, ctx, result);
    }
  }
  void nodesSel;
  return out;
}

function pullsConnection(selection: Selection, source: Record<string, unknown>, ctx: Ctx, result: RunResult, store: Store): Record<string, unknown> {
  const repo = ctx.repo;
  if (!repo) return null as unknown as Record<string, unknown>;
  const first = selection.args.first as number | undefined;
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const page = first !== undefined ? list.slice(0, first) : list;
  const out: Record<string, unknown> = { __typename: 'PullRequestConnection' };
  for (const entry of selection.selections ?? []) {
    const key = entry.alias ?? entry.name;
    if (entry.name === 'nodes') {
      out[key] = page.map((pull) => {
        store.globalIds.set(pull.globalId, { kind: 'pull', owner: repo.owner, repo: repo.name, number: pull.number });
        return exec(store, entry.selections ?? [], pullNode(repo, pull), ctx, result);
      });
    } else if (entry.name === 'pageInfo') {
      out[key] = exec(store, entry.selections ?? [], { hasNextPage: page.length < list.length, endCursor: null }, ctx, result);
    }
  }
  return out;
}

function mutate(store: Store, name: string, selection: Selection, input: Record<string, unknown>, ctx: Ctx, result: RunResult): unknown {
  const resolveRepo = (repositoryId: string): Repo | undefined => {
    const node = store.globalIds.get(repositoryId);
    if (node) return store.findRepo(node.owner, node.repo);
    return [...store.reposByFullName.values()].find((candidate) => candidate.globalId === repositoryId);
  };
  const payload = (inner: Record<string, unknown>): unknown => {
    const out: Record<string, unknown> = {};
    for (const entry of selection.selections ?? []) {
      const key = entry.alias ?? entry.name;
      if (entry.name === 'commentEdge') {
        const nodeSel = (entry.selections ?? []).find((sel) => sel.name === 'node');
        const nodeValue = nodeSel ? exec(store, nodeSel.selections ?? [], inner.node, ctx, result) : null;
        out[key] = { [nodeSel?.alias ?? 'node']: nodeValue };
      } else if (entry.name === 'issue' || entry.name === 'pullRequest') {
        out[key] = exec(store, entry.selections ?? [], inner[entry.name], ctx, result);
      } else {
        out[key] = null;
      }
    }
    return out;
  };
  switch (name) {
    case 'createIssue': {
      const repo = resolveRepo(input.repositoryId as string);
      if (!repo) {
        result.errors.push({ message: 'repository not found' });
        return null;
      }
      const seqNo = repo.issueSeqNo++;
      const issue: Issue = {
        id: repo.issueSeq++,
        number: seqNo,
        title: (input.title as string) ?? '',
        body: (input.body as string) ?? '',
        state: 'open',
        labels: [],
        createdAt: repo.createdAt * 1000 + seqNo,
        seq: repo.createdAt * 1000 + seqNo,
        comments: [],
        globalId: `I_${repo.id}_${seqNo}`,
      };
      repo.issues.set(issue.number, issue);
      store.globalIds.set(issue.globalId, { kind: 'issue', owner: repo.owner, repo: repo.name, number: issue.number });
      return payload({ issue: issueNode(issue), __typename: 'CreateIssuePayload' });
    }
    case 'closeIssue': {
      const node = store.globalIds.get(input.issueId as string);
      const repo = node ? store.findRepo(node.owner, node.repo) : undefined;
      const issue = node && repo ? repo.issues.get(node.number) : undefined;
      if (!issue) {
        result.errors.push({ message: 'issue not found' });
        return null;
      }
      issue.state = 'closed';
      return payload({ issue: issueNode(issue), __typename: 'CloseIssuePayload' });
    }
    case 'createPullRequest': {
      const repo = resolveRepo(input.repositoryId as string);
      if (!repo) {
        result.errors.push({ message: 'repository not found' });
        return null;
      }
      const head = input.headRefName as string;
      const base = input.baseRefName as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        result.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      const pull: PullRequest = {
        number: repo.pullSeqNo++,
        title: (input.title as string) ?? '',
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
        conflictHint: false,
      };
      repo.pulls.set(pull.number, pull);
      store.globalIds.set(pull.globalId, { kind: 'pull', owner: repo.owner, repo: repo.name, number: pull.number });
      return payload({ pullRequest: pullNode(repo, pull), __typename: 'CreatePullRequestPayload' });
    }
    case 'mergePullRequest': {
      const node = store.globalIds.get(input.pullRequestId as string);
      const repo = node ? store.findRepo(node.owner, node.repo) : undefined;
      const pull = node && repo ? repo.pulls.get(node.number) : undefined;
      if (!pull || !repo) {
        result.errors.push({ message: 'pull request not found' });
        return null;
      }
      const merged = restMergePull(repo, pull);
      if (!merged.ok) {
        pull.conflictHint = true;
        result.errors.push({ message: merged.reason ?? 'merge conflict' });
        return payload({ pullRequest: { ...pullNode(repo, pull), merged: false, state: 'OPEN' }, __typename: 'MergePullRequestPayload' });
      }
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = merged.sha!;
      return payload({ pullRequest: pullNode(repo, pull), __typename: 'MergePullRequestPayload' });
    }
    case 'addComment': {
      const node = store.globalIds.get(input.subjectId as string);
      const repo = node ? store.findRepo(node.owner, node.repo) : undefined;
      const issue = node && repo ? repo.issues.get(node.number) : undefined;
      if (!issue) {
        result.errors.push({ message: 'subject not found' });
        return null;
      }
      const body = (input.body as string) ?? '';
      const id = String(900000 + store.nextCommentId());
      issue.comments.push({ id: Number(id), body });
      return payload({ node: { id, body, __typename: 'IssueComment' }, __typename: 'AddCommentPayload' });
    }
    default:
      result.errors.push({ message: `unknown mutation ${name}` });
      return null;
  }
}

import { mergePull as restMergePull } from './rest.ts';
import { diffTrees } from './store.ts';

/** Run one parsed operation (or a batch of them) and answer per-operation results. */
export function runOperations(store: Store, operations: Selection[][]): RunResult[] {
  return operations.map((selections) => {
    const result: RunResult = { data: {}, errors: [] };
    const ctx: Ctx = { store, repo: null };
    result.data = exec(store, selections, null, ctx, result);
    return result;
  });
}
