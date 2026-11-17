// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint on one server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './src/githttp.ts';
import { handleRest, type Ctx } from './src/rest.ts';
import { parseDocument, runOperations } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Store, viewerLogin } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestIdCounter = 1000;
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = `0000:${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}:${String(requestIdCounter++).padStart(6, '0')}`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId, ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  // Fast path: a plain path with no query or fragment and no escapes (the benchmark's shape).
  const q = raw.indexOf('?');
  const end = q < 0 ? raw.length : q;
  const path = q < 0 ? raw : raw.slice(0, end);
  if (path.length > 1 && path.charCodeAt(0) === 0x2f && !path.includes('%')) return path;
  try {
    return new URL(raw, 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  return q < 0 ? '' : raw.slice(q + 1);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function loginFromToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  // Any bearer token is the trial's token: the viewer it names is the scenario's first user.
  return viewerLogin();
}

const store = new Store();

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Git smart HTTP: any path containing .git/ and the service verbs.
      const body = await readBody(req);
      if (await handleGitHttp(req, res, path, query, body, (owner, repo) => store.findRepo(owner, repo))) return;

      const login = loginFromToken(req);

      if (path === '/api/graphql' && method === 'POST') {
        if (login === null) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8') || '{}');
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        const operations = Array.isArray(parsed) ? parsed : [parsed];
        const answers = operations.map((operation) => {
          const record = (operation ?? {}) as { query?: string; variables?: Record<string, unknown> };
          try {
            const docs = parseDocument(record.query ?? '', record.variables ?? {});
            const results = runOperations(store, docs);
            return results[0] ?? { data: null, errors: [{ message: 'no operation' }] };
          } catch (error) {
            return { data: null, errors: [{ message: String((error as Error).message ?? error) }] };
          }
        });
        const payload = Array.isArray(parsed) ? answers : answers[0];
        const text = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
        res.end(text);
        return;
      }

      if (path.startsWith('/mcp')) {
        const answered = handleMcp(req, res, method, path, body, login, store);
        if (answered) return;
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      if (path.startsWith('/api/v3/')) {
        let restBody: unknown = null;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          const text = body.toString('utf8');
          if (text !== '') {
            try {
              restBody = JSON.parse(text);
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
        }
        if (login === null) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const ctx: Ctx = { store, login, origin: `http://${req.headers.host ?? 'localhost'}` };
        const reply = handleRest(ctx, method, path.slice('/api/v3'.length) || '/', query, restBody);
        if (reply === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const text = reply.body === undefined ? '' : `${JSON.stringify(reply.body)}\n`;
        res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'x-github-request-id': `0000:${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}:000${reply.status}`, ...reply.headers, ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }) });
        res.end(text);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch((error) => {
      try {
        console.error('[app] 500 on', req.method, req.url, error);
        sendJson(res, 500, { message: 'Server Error' });
      } catch {
        /* the socket is gone */
      }
    });
  });
}
