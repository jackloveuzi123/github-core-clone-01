// git smart HTTP: info/refs, upload-pack (protocol v2 + v0) and receive-pack (v0).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readPack, writePack } from './pack.ts';
import {
  collectReachable,
  getObject,
  parseCommit,
  parseTree,
  putObject,
  refList,
  resolveRef,
  ZERO_OID,
  type Repo,
} from './store.ts';

export class Pkt {
  static encode(payload: string | Buffer): Buffer {
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const header = Buffer.allocUnsafe(4);
    header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    return Buffer.concat([header, data]);
  }
  static flush(): Buffer {
    return Buffer.from('0000', 'ascii');
  }
  static delim(): Buffer {
    return Buffer.from('0001', 'ascii');
  }
  static responseEnd(): Buffer {
    return Buffer.from('0002', 'ascii');
  }
}

/** Decode pkt-lines from a complete buffer; returns data payloads and control flags. */
export function firstFlushEnd(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) return offset + 4;
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    offset += length;
  }
  return -1;
}

export function decodePackets(body: Buffer): Array<{ kind: 'data' | 'flush' | 'delim'; payload?: Buffer; raw?: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim'; payload?: Buffer; raw?: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else {
      const payload = body.subarray(offset + 4, offset + length);
      out.push({ kind: 'data', payload, raw: body.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return out;
}

function dataLines(body: Buffer): string[] {
  return decodePackets(body)
    .filter((packet) => packet.kind === 'data')
    .map((packet) => (packet.payload as Buffer).toString('utf8'));
}

function isTruthyHeader(headers: IncomingMessage['headers'], name: string): boolean {
  return String(headers[name] ?? '').includes('version=2');
}

// ------------------------------------------------------------------ advertisement

function advertiseRefsV0(res: ServerResponse, service: 'git-upload-pack' | 'git-receive-pack', repo: Repo | null): void {
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
  });
  const chunks: Buffer[] = [Pkt.encode(`# service=${service}\n`), Pkt.flush()];
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow agent=forge/1.0'
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';
  if (!repo) {
    chunks.push(Pkt.encode(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    chunks.push(Pkt.flush());
    res.end(Buffer.concat(chunks));
    return;
  }
  const refs = refList(repo);
  let first = true;
  let wroteAny = false;
  for (const ref of refs) {
    let line = `${ref.oid} ${ref.name}`;
    if (ref.peeled) {
      chunks.push(Pkt.encode(`${line}\n`));
      chunks.push(Pkt.encode(`${ref.oid} ${ref.name}^{}\n`));
      wroteAny = true;
      continue;
    }
    if (first) {
      line += `\u0000${caps}`;
      first = false;
    }
    chunks.push(Pkt.encode(`${line}\n`));
    wroteAny = true;
  }
  if (!wroteAny) {
    chunks.push(Pkt.encode(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  }
  chunks.push(Pkt.flush());
  res.end(Buffer.concat(chunks));
}

function advertiseV2(res: ServerResponse, service: string): void {
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' });
  const chunks: Buffer[] = [Pkt.encode('version 2\n')];
  chunks.push(Pkt.encode(`agent=forge/1.0\n`));
  chunks.push(Pkt.encode(`ls-refs=unborn\n`));
  chunks.push(Pkt.encode(`fetch=shallow filter\n`));
  chunks.push(Pkt.encode(`object-format=sha1\n`));
  chunks.push(Pkt.flush());
  res.end(Buffer.concat(chunks));
}

// ------------------------------------------------------------------ ls-refs

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const lines = dataLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const line of lines) {
    if (line === '\n' || line === '') {
      if (inArgs) break;
      continue;
    }
    if (line === 'peel\n' || line === 'peel') peel = true;
    else if (line === 'symrefs\n' || line === 'symrefs') symrefs = true;
    else if (line === 'unborn\n' || line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  const chunks: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refList(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.symref !== undefined && !symrefs) {
      // HEAD without symrefs: plain entry
    }
    let text = `${ref.oid} ${ref.name}`;
    if (ref.symref !== undefined && symrefs) text += ` symref-target:${ref.symref}`;
    if (ref.peeled !== undefined && peel) text += ` peeled:${ref.peeled}`;
    chunks.push(Pkt.encode(`${text}\n`));
  }
  chunks.push(Pkt.flush());
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ fetch

/** The commits at or after `depth` from a tip; returns [boundaryOids, commitsToSend]. */
function shallowWalk(repo: Repo, tips: string[], depth: number): { shallow: string[]; commits: string[] } {
  const commits: string[] = [];
  const shallow: string[] = [];
  interface Node {
    oid: string;
    d: number;
  }
  const seen = new Set<string>();
  let frontier: Node[] = tips.map((oid) => ({ oid, d: 1 }));
  while (frontier.length) {
    const next: Node[] = [];
    for (const node of frontier) {
      if (seen.has(node.oid)) continue;
      seen.add(node.oid);
      commits.push(node.oid);
      if (node.d >= depth) {
        shallow.push(node.oid);
        continue;
      }
      const object = repo.objects.get(node.oid);
      if (object) {
        for (const parent of parseCommit(object.data).parents) next.push({ oid: parent, d: node.d + 1 });
      }
    }
    frontier = next;
  }
  return { shallow, commits };
}

/** The trees and blobs reachable from the given commits' trees (no parents). */
function treeClosure(repo: Repo, commitOids: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of commitOids) {
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') queue.push(parseCommit(object.data).tree);
  }
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    out.push(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

function handleFetchV2(res: ServerResponse, repo: Repo, body: Buffer, url: string): void {
  // v2 request: section 1 (command/agent/object-format) ends at a delim packet; the args follow.
  let inArgs = false;
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;
  let done = false;
  for (const packet of decodePackets(body)) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !inArgs) continue;
    const text = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    if (text === '' || text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta' || text.startsWith('filter ') || text.startsWith('deepen-since') || text.startsWith('deepen-not')) continue;
    if (text.startsWith('want ')) wants.push(text.slice(5));
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7)) || 0;
    else if (text === 'done') done = true;
    else if (text.startsWith('shallow ')) { /* the client's boundary: accepted, the pack stays shallow */ }
  }
  const chunks: Buffer[] = [];
  const shallow: string[] = [];
  let oids: string[] = [];
  if (wants.length) {
    if (depth > 0) {
      const walk = shallowWalk(repo, wants, depth);
      shallow.push(...walk.shallow);
      oids = [...walk.commits, ...treeClosure(repo, walk.commits)];
    } else {
      oids = [...collectReachable(repo, wants)];
    }
    // Subtract what the client has (full negotiation is not needed with done=true).
    if (haves.length && done) {
      // In a shallow negotiation the client holds only the haves and their trees — not the
      // haves' ancestors — so collecting through parents would subtract too much.
      const haveSet = depth > 0
        ? new Set([...haves, ...treeClosure(repo, haves)])
        : collectReachable(repo, haves);
      oids = oids.filter((oid) => !haveSet.has(oid));
    }
  }
  if (shallow.length) {
    chunks.push(Pkt.encode('shallow-info\n'));
    for (const oid of shallow) chunks.push(Pkt.encode(`shallow ${oid}\n`));
    chunks.push(Pkt.flush());
  }
  chunks.push(Pkt.encode('packfile\n'));
  const pack = writePack(repo, oids);
  let offset = 0;
  while (offset < pack.length) {
    const take = Math.min(65515, pack.length - offset);
    chunks.push(Pkt.encode(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + take)])));
    offset += take;
  }
  chunks.push(Pkt.flush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(chunks));
  void url;
}

function handleFetchV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  // v0: section 1 (wants, shallow, deepen) ends at the first flush; section 2 has haves and done.
  const packets = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data' || section > 1) continue;
    const text = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0]!);
    else if (clean.startsWith('have ')) haves.push(clean.slice(5));
    else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7)) || 0;
    else if (clean.startsWith('shallow ')) { /* accepted */ }
  }
  const chunks: Buffer[] = [];
  const shallow: string[] = [];
  let oids: string[] = [];
  if (wants.length) {
    if (depth > 0) {
      const walk = shallowWalk(repo, wants, depth);
      shallow.push(...walk.shallow);
      oids = [...walk.commits, ...treeClosure(repo, walk.commits)];
    } else {
      oids = [...collectReachable(repo, wants)];
      if (haves.length) {
        const haveSet = collectReachable(repo, haves);
        oids = oids.filter((oid) => !haveSet.has(oid));
      }
    }
  }
  chunks.push(Pkt.encode('NAK\n'));
  for (const oid of shallow) chunks.push(Pkt.encode(`shallow ${oid}\n`));
  chunks.push(Pkt.flush());
  const pack = writePack(repo, oids);
  let offset = 0;
  while (offset < pack.length) {
    const take = Math.min(65515, pack.length - offset);
    chunks.push(Pkt.encode(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + take)])));
    offset += take;
  }
  chunks.push(Pkt.flush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(chunks));
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceive(res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const packets = decodePackets(body);
  const commands: PushCommand[] = [];
  let packBytes: Buffer | null = null;
  let inCommands = true;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (inCommands) {
        inCommands = false;
        seenFlush = true;
      }
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (inCommands) {
      const text = (packet.payload as Buffer).toString('utf8');
      const nul = text.indexOf('\u0000');
      const clean = nul >= 0 ? text.slice(0, nul) : text;
      const line = clean.replace(/\n$/, '');
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(line);
      if (m) commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    }
  }
  // Everything after the command flush is the raw packfile (not pkt-line framed).
  if (seenFlush) {
    const flushAt = firstFlushEnd(body);
    if (flushAt > 0 && flushAt < body.length) packBytes = body.subarray(flushAt);
  }

  // Side-band framing for the report.
  const sideband = true;
  const report: string[] = [];
  let unpackOk = true;
  const externalBases = repo.objects;
  if (packBytes && packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, externalBases as unknown as Map<string, GitObjectLike>);
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  report.push(`unpack ${unpackOk ? 'ok' : 'unpacker error'}`);
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === command.oldOid || (current === undefined && command.oldOid === ZERO_OID)) {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
      } else {
        report.push(`ng ${command.ref} fetch first`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing objects`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} fetch first`);
      continue;
    }
    // Fast-forward check: the old tip must be an ancestor of the new tip.
    const reachable = collectReachable(repo, [command.newOid]);
    if (!reachable.has(command.oldOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  const reportText = `${report.join('\n')}\n`;
  const out: Buffer[] = [];
  if (sideband) {
    // git receive-pack.c report(): pkt-framed lines plus an inner flush pkt inside band 1,
    const framed = Buffer.concat([...report.map((line) => Pkt.encode(`${line}\n`)), Pkt.flush()]);
    out.push(Pkt.encode(Buffer.concat([Buffer.from([1]), framed])));
    out.push(Pkt.flush()); // receive-pack sends a final flush after the band (cmd_receive_pack's tail)
  } else {
    out.push(Pkt.encode(reportText));
  }
  const resp = Buffer.concat(out);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': resp.length });
  res.end(resp);
}

type GitObjectLike = { type: string; data: Buffer };

// ------------------------------------------------------------------ dispatch

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, path: string, query: string, body: Buffer, repos: (owner: string, repo: string) => Repo | null): Promise<boolean> {
  const m = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)\.git(\/.*)$/.exec(path);
  if (!m) return false;
  const [, owner, repoName, suffix] = m;
  if (String(req.headers['content-type'] ?? '').startsWith('application/x-git-upload-pack') && isTruthyHeader(req.headers, 'git-protocol')) {
    // v2 requests carry the header; handled below by suffix anyway
  }
  const v2 = isTruthyHeader(req.headers, 'git-protocol');
  if (suffix === '/info/refs') {
    const service = /service=git-receive-pack/.test(query) ? 'git-receive-pack' : 'git-upload-pack';
    const repo = repos(owner!, repoName!.replace(/\.git$/, ''));
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    if (service === 'git-upload-pack' && v2) advertiseV2(res, service);
    else advertiseRefsV0(res, service, repo);
    return true;
  }
  const repo = repos(owner!, repoName!.replace(/\.git$/, ''));
  if (suffix === '/git-upload-pack') {
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    if (v2) {
      const lines = dataLines(body);
      const commandLine = lines.find((line) => line.startsWith('command='));
      const command = commandLine ? commandLine.slice('command='.length).replace(/\n$/, '') : '';
      if (command === 'ls-refs') {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
        res.end(handleLsRefs(repo, body));
      } else if (command === 'fetch') {
        handleFetchV2(res, repo, body, req.url ?? '');
      } else {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
        res.end(Pkt.flush());
      }
    } else {
      handleFetchV0(res, repo, body);
    }
    return true;
  }
  if (suffix === '/git-receive-pack') {
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return true;
    }
    await handleReceive(res, repo, body);
    return true;
  }
  return false;
}

export { isTruthyHeader };
export const _hashRef = createHash;
