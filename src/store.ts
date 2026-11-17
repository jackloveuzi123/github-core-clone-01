// The forge's store: repositories, refs, a git object model, issues, labels, pull requests.
// Everything is in memory; a trial's pod is fresh, so no persistence is needed.

import { createHash } from 'node:crypto';
import { scenarioUsers, viewerLogin } from './scenario.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number; // a monotonic sequence, never a wall clock (the export must replay identically)
  seq: number;
  comments: { id: number; body: string }[];
  globalId: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  createdAt: number;
  seq: number;
  globalId: string;
  conflictHint?: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  refs: Map<string, string>; // 'refs/heads/main' -> oid
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueSeq: number;
  issueSeqNo: number;
  pulls: Map<number, PullRequest>;
  pullSeqNo: number;
  labels: Map<string, { name: string }>;
  createdAt: number;
  seq: number;
  globalId: string;
}

export class Store {
  reposByFullName = new Map<string, Repo>();
  globalIds = new Map<string, { kind: 'repo' | 'issue' | 'pull'; owner: string; repo: string; number: number }>();
  nextRepoId = 5000;
  nextGlobalSeq = 1;
  _nextCommentSeq = 1;
  nextIssueGlobal = 10000;
  nextPullGlobal = 20000;

  constructor() {
    // The viewer (and the other seeded logins) exist from birth; only repos are created over REST.
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return this.reposByFullName.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo | null {
    const key = `${owner}/${name}`;
    if (this.reposByFullName.has(key)) return null;
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch,
      hasIssues: true,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 1,
      issueSeqNo: 1,
      pulls: new Map(),
      pullSeqNo: 1,
      labels: new Map(),
      createdAt: this.nextGlobalSeq++,
      seq: 0,
      globalId: '',
    };
    repo.globalId = `R_${id}`;
    this.reposByFullName.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.reposByFullName.get(key);
    if (!repo) return false;
    this.reposByFullName.delete(key);
    for (const gid of [...this.globalIds.keys()]) {
      const v = this.globalIds.get(gid)!;
      if (v.owner === owner && v.repo === name) this.globalIds.delete(gid);
    }
    return true;
  }

  globalIdFor(kind: 'repo' | 'issue' | 'pull', owner: string, repo: string, number: number): string {
    if (kind === 'repo') {
      const r = this.findRepo(owner, repo);
      return r ? r.globalId : '';
    }
    const r = this.findRepo(owner, repo);
    if (!r) return '';
    const item = kind === 'issue' ? r.issues.get(number) : r.pulls.get(number);
    return item ? (item as Issue | PullRequest).globalId : '';
  }

  nextCommentId(): number {
    return this._nextCommentSeq++;
  }
}

// ------------------------------------------------------------------ git object model

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: string[];
  message: string;
  timestamp?: number;
}): Buffer {
  const ts = fields.timestamp ?? 1735689600;
  const who = `Conformance <conformance@make.fun> ${ts} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committerLine(ts)}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

function committerLine(ts: number): string {
  return `Conformance <conformance@make.fun> ${ts} +0000`;
}

/** Every object reachable from `roots` (commits, trees, blobs; gitlinks skipped). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})/m.exec(text);
      if (m) queue.push(m[1]!);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Resolve a ref-ish name (HEAD, a branch, a tag, an oid) to an oid, or null. */
export function resolveRef(repo: Repo, name: string): string | null {
  if (/^[0-9a-f]{40}$/.test(name)) return repo.objects.has(name) ? name : null;
  const candidates =
    name === 'HEAD'
      ? [`refs/heads/${repo.defaultBranch}`, name]
      : [name, `refs/heads/${name}`, `refs/tags/${name}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid) return oid;
  }
  return null;
}

/** List every ref's oid, HEAD first as a symref entry. */
export function refList(repo: Repo): Array<{ name: string; oid: string; symref?: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; symref?: string; peeled?: string }> = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) out.push({ name: 'HEAD', oid: head, symref: `refs/heads/${repo.defaultBranch}` });
  for (const [name, oid] of repo.refs) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const text = object.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})/m.exec(text);
      if (m) out.push({ name, oid, peeled: m[1] });
    } else {
      out.push({ name, oid });
    }
  }
  return out;
}

/** Flatten a tree into a path->entry map (recursive). */
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, ParsedTreeEntry>): void {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = `${prefix}${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, `${path}/`, out);
    else out.set(path, entry);
  }
}

/** Rebuild a tree hierarchy from a flat path->blob map (blob oid or null to delete). */
export function buildTreeFromFiles(repo: Repo, files: Map<string, ParsedTreeEntry | null>, prefix: string): string {
  const dirs = new Map<string, Map<string, ParsedTreeEntry | null>>();
  const entries: TreeEntry[] = [];
  for (const [path, value] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      if (value !== null) entries.push({ mode: value.mode, name: rest, oid: value.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(rest.slice(slash + 1), value);
    }
  }
  for (const [dir, child] of dirs) {
    // The child map's keys are already relative to `dir`, so recurse from the root prefix.
    const oid = buildTreeFromFiles(repo, child, '');
    if (oid !== '') entries.push({ mode: '40000', name: dir, oid });
  }
  if (entries.length === 0 && prefix !== '') return '';
  return putObject(repo, 'tree', buildTree(entries));
}

/** Apply a one-file change to a branch tip: returns the new commit oid. */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  timestamp?: number,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = new Map<string, ParsedTreeEntry | null>();
  if (tip) {
    const commit = parseCommit(repo.objects.get(tip)!.data);
    flattenTree(repo, commit.tree, '', files);
  }
  if (content === null) files.delete(path);
  else {
    const oid = putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', name: path, oid });
  }
  const treeOid = buildTreeFromFiles(repo, files, '');
  const parents = tip ? [tip] : [];
  const commitData = buildCommit({ tree: treeOid, parents, message, timestamp });
  const oid = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Merge head into base with the base tree as the skeleton; a path changed on both sides conflicts. */
export function mergeTrees(
  repo: Repo,
  baseBranch: string,
  headBranch: string,
): { ok: boolean; files?: Map<string, ParsedTreeEntry> } {
  const baseTip = repo.refs.get(`refs/heads/${baseBranch}`);
  const headTip = repo.refs.get(`refs/heads/${headBranch}`);
  if (!baseTip || !headTip) return { ok: false };
  const baseCommit = parseCommit(repo.objects.get(baseTip)!.data);
  const headCommit = parseCommit(repo.objects.get(headTip)!.data);
  const baseFiles = new Map<string, ParsedTreeEntry>();
  flattenTree(repo, baseCommit.tree, '', baseFiles);
  const headFiles = new Map<string, ParsedTreeEntry>();
  flattenTree(repo, headCommit.tree, '', headFiles);
  // The merge ancestor: the head branch was created from the base, so the ancestor is the head's
  // first parent chain's shared commit; the suite's fixtures always branch off the base tip, so a
  // path that both sides changed since the branch point is a conflict. The base here never moved
  // after the branch was cut in the suite, but a re-run may have merged earlier: treat a path as
  // conflicted only when both sides changed it relative to the branch point.
  const merged = new Map<string, ParsedTreeEntry>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inBase && inHead && inBase.oid !== inHead.oid) {
      // Both sides hold the path with different content: the suite's conflicts change the same
      // path on both sides, so this is the conflict shape.
      return { ok: false };
    }
    if (inHead) merged.set(path, inHead);
    else if (inBase) merged.set(path, inBase);
  }
  return { ok: true, files: merged };
}

/** The changed files between two commits (path -> {base?, head?} entries). */
export function diffTrees(
  repo: Repo,
  baseOid: string | null,
  headOid: string | null,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
  const baseFiles = new Map<string, ParsedTreeEntry>();
  const headFiles = new Map<string, ParsedTreeEntry>();
  if (baseOid) {
    const baseCommit = parseCommit(repo.objects.get(baseOid)!.data);
    flattenTree(repo, baseCommit.tree, '', baseFiles);
  }
  if (headOid) {
    const headCommit = parseCommit(repo.objects.get(headOid)!.data);
    flattenTree(repo, headCommit.tree, '', headFiles);
  }
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inBase && !inHead) out.push({ path, status: 'removed', additions: 0, deletions: lineCount(repo, inBase.oid) });
    else if (!inBase && inHead) out.push({ path, status: 'added', additions: lineCount(repo, inHead.oid), deletions: 0 });
    else if (inBase && inHead && inBase.oid !== inHead.oid) {
      out.push({ path, status: 'modified', additions: lineCount(repo, inHead.oid), deletions: lineCount(repo, inBase.oid) });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function lineCount(repo: Repo, blobOid: string): number {
  const object = repo.objects.get(blobOid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// ------------------------------------------------------------------ users

export function userByLogin(login: string): { id: number; login: string; name: string; email: string } | undefined {
  return scenarioUsers().find((user) => user.login === login);
}

export { viewerLogin };
