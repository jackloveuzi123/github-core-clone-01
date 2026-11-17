// The REST v3 surface: repositories, branches, commits, contents, labels, issues, pulls, merges.

import { touchRepoObjects, touchRepoRefs } from './githttp.ts';
import {
  buildTreeFromFiles,
  commitFileChange,
  diffTrees,
  flattenTree,
  getObject,
  hashObject,
  parseCommit,
  putObject,
  resolveRef,
  userByLogin,
  viewerLogin,
  ZERO_OID,
  type Issue,
  type ParsedTreeEntry,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface Ctx {
  store: Store;
  origin?: string;
  login: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const BASE_TIME = 1735689600; // a fixed epoch; timestamps derive from a per-repo counter

function now(repo: Repo): number {
  return BASE_TIME + repo.createdAt * 60 + repo.seq;
}

function userObject(login: string): Record<string, unknown> {
  const user = userByLogin(login);
  return { login, id: user?.id ?? 1, type: 'User', site_admin: false, avatar_url: '', url: '', html_url: '' };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    html_url: '',
    url: '',
    permissions: { admin: true, push: true, pull: true },
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 100000 + issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ id: 1, name, color: 'ededed', default: false })),
    user: userObject(repo.owner),
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null,
    url: '',
    html_url: '',
    pull_request: undefined,
  };
}

function pullObject(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: 200000 + pull.number,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? '2025-01-01T00:00:00Z' : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, repo: repoObject(repo) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, repo: repoObject(repo) },
    user: userObject(repo.owner),
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: '',
    url: '',
  };
}

function parseQuery(query: string): URLSearchParams {
  return query === '' ? EMPTY_PARAMS : new URLSearchParams(query);
}

const EMPTY_PARAMS = new URLSearchParams('');

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Content listing (file or directory). */
function contentEntry(repo: Repo, path: string, ref?: string): Record<string, unknown> | Array<Record<string, unknown>> | null {
  const branch = ref ?? repo.defaultBranch;
  const tip = resolveRef(repo, branch);
  if (!tip) return null;
  const commit = parseCommit(repo.objects.get(tip)!.data);
  const files = new Map<string, ParsedTreeEntry>();
  flattenTree(repo, commit.tree, '', files);
  if (files.has(path)) {
    const entry = files.get(path)!;
    const object = repo.objects.get(entry.oid)!;
    return {
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: object.data.length,
      type: 'file',
      encoding: 'base64',
      content: object.data.toString('base64'),
      download_url: '',
      url: '',
      git_url: '',
      html_url: '',
    };
  }
  const prefix = `${path}/`;
  const children = new Map<string, 'file' | 'dir'>();
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      children.set(name, slash < 0 ? 'file' : 'dir');
    }
  }
  if (children.size === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const [name, type] of children) {
    const childPath = `${prefix}${name}`;
    const entry = type === 'file' ? files.get(childPath)! : null;
    out.push({
      name,
      path: childPath,
      sha: entry ? entry.oid : '',
      size: entry ? repo.objects.get(entry.oid)!.data.length : 0,
      type,
      encoding: type === 'file' ? 'base64' : undefined,
      content: undefined,
      url: '',
      git_url: '',
      html_url: '',
    });
  }
  return out;
}

function blobSha(repo: Repo, path: string, branch: string): string | null {
  const tip = resolveRef(repo, branch);
  if (!tip) return null;
  const commit = parseCommit(repo.objects.get(tip)!.data);
  const files = new Map<string, ParsedTreeEntry>();
  flattenTree(repo, commit.tree, '', files);
  const entry = files.get(path);
  return entry ? entry.oid : null;
}

/** Squash-merge a pull request; returns the merge commit oid or a reason. */
export function mergePull(repo: Repo, pull: PullRequest): { ok: boolean; sha?: string; reason?: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'branch missing' };
  const headFiles = new Map<string, ParsedTreeEntry>();
  const headCommit = parseCommit(repo.objects.get(headTip)!.data);
  flattenTree(repo, headCommit.tree, '', headFiles);
  // The common ancestor: walk the head's parent chain for the newest commit reachable from base.
  const baseAncestry = new Set<string>([baseTip]);
  const queue = [baseTip];
  while (queue.length) {
    const oid = queue.pop()!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!baseAncestry.has(parent)) {
        baseAncestry.add(parent);
        queue.push(parent);
      }
    }
  }
  let ancestor: string | null = null;
  let cursor: string | null = headTip;
  const headSeen = new Set<string>();
  while (cursor && !headSeen.has(cursor)) {
    headSeen.add(cursor);
    if (baseAncestry.has(cursor)) {
      ancestor = cursor;
      break;
    }
    const object = repo.objects.get(cursor);
    cursor = object ? (parseCommit(object.data).parents[0] ?? null) : null;
  }
  const ancestorFiles = new Map<string, ParsedTreeEntry>();
  if (ancestor) {
    const ancestorCommit = parseCommit(repo.objects.get(ancestor)!.data);
    flattenTree(repo, ancestorCommit.tree, '', ancestorFiles);
  }
  const baseCommit = parseCommit(repo.objects.get(baseTip)!.data);
  const baseFiles = new Map<string, ParsedTreeEntry>();
  flattenTree(repo, baseCommit.tree, '', baseFiles);
  const merged = new Map<string, ParsedTreeEntry | null>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inAncestor = ancestorFiles.get(path);
    const headChanged = (inHead?.oid ?? null) !== (inAncestor?.oid ?? null);
    const baseChanged = (inBase?.oid ?? null) !== (inAncestor?.oid ?? null);
    if (headChanged && baseChanged && (inHead?.oid ?? null) !== (inBase?.oid ?? null)) {
      return { ok: false, reason: 'merge conflict' };
    }
    merged.set(path, inHead ?? inBase ?? null);
  }
  const treeOid = buildTreeFromFiles(repo, merged, '');
  const commitData = Buffer.concat([
    Buffer.from(`tree ${treeOid}\n`, 'utf8'),
    Buffer.from(`parent ${baseTip}\n`, 'utf8'),
    Buffer.from(`author Conformance <conformance@make.fun> ${now(repo)} +0000\n`, 'utf8'),
    Buffer.from(`committer Conformance <conformance@make.fun> ${now(repo)} +0000\n`, 'utf8'),
    Buffer.from(`\nMerge pull request #${pull.number} from ${repo.owner}/${pull.head}\n`, 'utf8'),
  ]);
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  touchRepoObjects(repo);
  touchRepoRefs(repo);
  return { ok: true, sha };
}

export function handleRest(ctx: Ctx, method: string, path: string, query: string, body: any, origin = ''): Reply | null {
  const store = ctx.store;
  const login = ctx.login;
  const params = parseQuery(query);
  const parts = path.split('/').filter((part) => part !== '');
  const json = (status: number, bodyValue: unknown, headers?: Record<string, string>): Reply => ({ status, body: bodyValue, headers });

  if (parts.length === 0) {
    if (method === 'GET') {
      return json(200, {
        current_user_url: '/api/v3/user',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issues_url: '/api/v3/repos/{owner}/{repo}/issues{?page,per_page,state}',
        meta_url: '/api/v3/meta',
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
    }
    return null;
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    return json(200, { installed_version: '3.0.0-forge', verifiable_password_authentication: true });
  }

  if (parts[0] === 'user') {
    if (parts[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return json(422, { message: 'name is required' });
        const repo = store.createRepo(login, name, typeof body?.description === 'string' ? body.description : '', body?.private === true, 'main');
        if (!repo) return json(422, { message: `${name} already exists` });
        return json(201, repoObject(repo));
      }
      if (method === 'GET') {
        const perPage = intParam(params, 'per_page', 30);
        const page = intParam(params, 'page', 1);
        const all = [...store.reposByFullName.values()].filter((repo) => repo.owner === login);
        all.sort((a, b) => a.createdAt - b.createdAt);
        const start = (page - 1) * perPage;
        const items = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          headers.Link = `<${ctx.origin ?? ''}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        return json(200, items.map(repoObject), headers);
      }
    }
    if (parts.length === 1 && method === 'GET') {
      return json(200, userObject(login));
    }
    return null;
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1]!.includes('%') ? decodeURIComponent(parts[1]!) : parts[1]!;
    const name = parts[2]!.includes('%') ? decodeURIComponent(parts[2]!) : parts[2]!;
    const repo = store.findRepo(owner, name);
    // A repository belongs to the login the token names: another owner's path is 404, never 403.
    const rest = parts.slice(3);
    if (!repo) return json(404, { message: 'Not Found' });
    return handleRepoRest(ctx, repo, method, rest, params, body);
  }

  return null;
}

function handleRepoRest(ctx: Ctx, repo: Repo, method: string, rest: string[], params: URLSearchParams, body: any): Reply | null {
  const json = (status: number, bodyValue: unknown, headers?: Record<string, string>): Reply => ({ status, body: bodyValue, headers });
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoObject(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.default_branch === 'string') repo.defaultBranch = body.default_branch;
      if (typeof body?.has_issues === 'boolean') repo.hasIssues = body.has_issues;
      return json(200, repoObject(repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return null;
  }
  const [head, second, third] = rest as [string, string | undefined, string | undefined];

  if (head === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }));
    return json(200, branches);
  }
  if (head === 'git' && second === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || !repo.objects.has(sha)) return json(422, { message: 'bad ref or sha' });
      if (repo.refs.has(ref)) return json(422, { message: 'Reference already exists' });
      repo.refs.set(ref, sha);
      touchRepoRefs(repo);
      return json(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length === 3 && second === 'refs') {
      const refName = rest[2]!;
      const oid = repo.refs.get(refName.startsWith('refs/') ? refName : `refs/heads/${refName}`);
      if (!oid) return json(404, { message: 'Not Found' });
      return json(200, { ref: refName, object: { sha: oid } });
    }
  }
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const branch = params.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, branch);
    if (!tip) return json(404, { message: 'Not Found' });
    const list: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let cursor: string | null = tip;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const object = repo.objects.get(cursor)!;
      const commit = parseCommit(object.data);
      list.push({
        sha: cursor,
        commit: { message: commit.message, author: { name: 'Conformance', email: 'conformance@make.fun', date: '2025-01-01T00:00:00Z' } },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      cursor = commit.parents[0] ?? null;
    }
    return json(200, list);
  }
  if (head === 'contents') {
    const filePath = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    const ref = params.get('ref') ?? undefined;
    if (method === 'GET' && rest.length >= 2) {
      const entry = contentEntry(repo, filePath, ref);
      if (entry === null) return json(404, { message: 'Not Found' });
      return json(200, entry);
    }
    if (method === 'PUT' && rest.length >= 2) {
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const existing = blobSha(repo, filePath, branch);
      const providedSha = typeof body?.sha === 'string' ? body.sha : undefined;
      if (existing && !providedSha) return json(422, { message: `${filePath} already exists; supply a sha to update it` });
      if (existing && providedSha && providedSha !== existing) return json(409, { message: `${filePath} does not match the given sha` });
      const content = typeof body?.content === 'string' ? Buffer.from(body.content, 'base64') : null;
      if (content === null) return json(422, { message: 'content is required' });
      const created = existing === null;
      const commitOid = commitFileChange(repo, branch, filePath, content, typeof body?.message === 'string' ? body.message : 'update', now(repo));
      touchRepoObjects(repo);
      touchRepoRefs(repo);
      const blobOid = hashObject('blob', content);
      return json(created ? 201 : 200, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64'), url: '' },
        commit: { sha: commitOid, message: typeof body?.message === 'string' ? body.message : '' },
      });
    }
    if (method === 'DELETE' && rest.length >= 2) {
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const existing = blobSha(repo, filePath, branch);
      if (!existing) return json(404, { message: 'Not Found' });
      if (typeof body?.sha === 'string' && body.sha !== existing) return json(409, { message: 'sha mismatch' });
      const commitOid = commitFileChange(repo, branch, filePath, null, typeof body?.message === 'string' ? body.message : 'delete', now(repo));
      touchRepoObjects(repo);
      touchRepoRefs(repo);
      return json(200, { commit: { sha: commitOid } });
    }
  }
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const labelName = typeof body?.name === 'string' ? body.name : '';
      if (!labelName) return json(422, { message: 'name is required' });
      repo.labels.set(labelName, { name: labelName });
      return json(201, { id: repo.labels.size + 500, name: labelName, color: typeof body?.color === 'string' ? body.color : 'ededed', default: false });
    }
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()]);
    }
  }
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        const issueBody = typeof body?.body === 'string' ? body.body : '';
        const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).map((entry) => (typeof entry === 'string' ? entry : (entry as any)?.name)).filter((n): n is string => typeof n === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) return json(422, { message: `label ${labelName} does not exist` });
        }
        const seqNo = repo.issueSeqNo++;
        const issue: Issue = {
          id: repo.issueSeq++,
          number: seqNo,
          title,
          body: issueBody,
          state: 'open',
          labels: labelNames,
          createdAt: repo.createdAt * 1000 + seqNo,
          seq: repo.createdAt * 1000 + seqNo,
          comments: [],
          globalId: `I_${repo.id}_${seqNo}`,
        };
        repo.issues.set(issue.number, issue);
        return json(201, issueObject(repo, issue));
      }
      if (method === 'GET') {
        const state = params.get('state') ?? 'open';
        const perPage = intParam(params, 'per_page', 30);
        const page = intParam(params, 'page', 1);
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (a.seq - b.seq) * (params.get('direction') === 'desc' ? -1 : 1) || (params.get('direction') === 'desc' ? b.number - a.number : a.number - b.number));
        const start = (page - 1) * perPage;
        return json(200, list.slice(start, start + perPage).map((issue) => issueObject(repo, issue)));
      }
    }
    if (rest.length === 2 && /^\d+$/.test(second!)) {
      const issue = repo.issues.get(Number(second));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, issueObject(repo, issue));
      if (method === 'PATCH') {
        if (typeof body?.state === 'string' && ['open', 'closed'].includes(body.state)) issue.state = body.state as 'open' | 'closed';
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        return json(200, issueObject(repo, issue));
      }
    }
    if (rest.length === 3 && second && /^\d+$/.test(second) && third === 'comments') {
      const issue = repo.issues.get(Number(second));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'POST') {
        const commentBody = typeof body?.body === 'string' ? body.body : '';
        const comment = { id: ctx.store.nextCommentId(), body: commentBody };
        issue.comments.push(comment);
        return json(201, { ...comment, user: userObject(repo.owner), created_at: '2025-01-01T00:00:00Z', html_url: '', url: '' });
      }
      if (method === 'GET') {
        return json(200, issue.comments.map((comment) => ({ ...comment, user: userObject(repo.owner), created_at: '2025-01-01T00:00:00Z', html_url: '', url: '' })));
      }
    }
  }
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const headRef = typeof body?.head === 'string' ? body.head : '';
        const baseRef = typeof body?.base === 'string' ? body.base : '';
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headSha || !baseSha) return json(422, { message: 'head or base branch does not exist' });
        for (const pull of repo.pulls.values()) {
          if (pull.head === headRef && pull.state === 'open') return json(422, { message: 'a pull request already exists for that head' });
        }
        const pull: PullRequest = {
          number: repo.pullSeqNo++,
          title: typeof body?.title === 'string' ? body.title : '',
          body: typeof body?.body === 'string' ? body.body : '',
          head: headRef,
          base: baseRef,
          state: 'open',
          merged: false,
          mergeCommitSha: null,
          headSha,
          baseSha,
          createdAt: repo.createdAt * 1000 + repo.pullSeqNo - 1,
          seq: repo.createdAt * 1000 + repo.pullSeqNo - 1,
          globalId: `PR_${repo.id}_${repo.pullSeqNo - 1}`,
        };
        pull.globalId = `PR_${repo.id}_${pull.number}`;
        repo.pulls.set(pull.number, pull);
        return json(201, pullObject(repo, pull));
      }
      if (method === 'GET') {
        const state = params.get('state') ?? 'open';
        const perPage = intParam(params, 'per_page', 30);
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => a.number - b.number);
        return json(200, list.slice(0, perPage).map((pull) => pullObject(repo, pull)));
      }
    }
    if (rest.length >= 2 && /^\d+$/.test(second!)) {
      const pull = repo.pulls.get(Number(second));
      if (rest.length === 2) {
        if (!pull) return json(404, { message: 'Not Found' });
        if (method === 'GET') return json(200, pullObject(repo, pull));
      }
      if (rest.length === 3 && third === 'files') {
        if (!pull) return json(404, { message: 'Not Found' });
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const files = diffTrees(repo, pull.merged ? pull.baseSha : baseTip ?? null, headTip ?? null);
        return json(200, files.map((file) => ({ filename: file.path, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.additions + file.deletions, sha: '' })));
      }
      if (rest.length === 3 && third === 'merge') {
        if (!pull) return json(404, { message: 'Not Found' });
        if (method === 'PUT') {
          if (pull.state === 'closed' && pull.merged) return json(405, { message: 'pull request already merged' });
          const result = mergePull(repo, pull);
          if (!result.ok) return json(405, { message: result.reason ?? 'merge conflict' });
          pull.state = 'closed';
          pull.merged = true;
          pull.mergeCommitSha = result.sha!;
          return json(200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
        }
      }
    }
  }
  return null;
}
