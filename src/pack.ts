// Packfile read (receive-pack) and write (upload-pack): pure git pack v2, no deltas written.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { GitObject, ObjectType, Repo } from './store.ts';

const TYPE_CODES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_OF: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface ParsedPack {
  objects: Map<string, GitObject>;
  count: number;
}

function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize(); // source size (checked below)
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    }
  }
  return out;
}

/** Parse a packfile, resolving OFS/REF deltas, verifying every object's hash. */
export function readPack(pack: Buffer, externalBases?: Map<string, GitObject>): ParsedPack {
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  const declaredCount = pack.readUInt32BE(8);
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsVarint(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved && entry.oid) return entry.resolved;
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!)!;
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      const base = inPack
        ? resolve(inPack)
        : (externalBases?.get(wanted) ?? undefined);
      if (!base) throw new Error(`ref-delta base ${wanted} missing`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = TYPE_CODES[entry.typeCode]!;
      data = entry.data;
    }
    const hash = createHash('sha1');
    hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
    hash.update(data);
    const oid = hash.digest('hex');
    const object: GitObject = { type, data };
    entry.resolved = object;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    objects.set(oid, object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return { objects, count: raw.length };
}

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (CODE_OF[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const DEFLATE_CACHE = new WeakMap<Repo, Map<string, Buffer>>();
const PACK_CACHE = new WeakMap<Repo, Map<string, Buffer>>();

/** Build a packfile (plain objects, no deltas) from an oid list. */
export function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const key = `${list.length}|${list.join(',')}`;
  let packCache = PACK_CACHE.get(repo);
  if (packCache === undefined) {
    packCache = new Map<string, Buffer>();
    PACK_CACHE.set(repo, packCache);
  }
  const cachedPack = packCache.get(key);
  if (cachedPack !== undefined) return cachedPack;
  let cache = DEFLATE_CACHE.get(repo);
  if (cache === undefined) {
    cache = new Map<string, Buffer>();
    DEFLATE_CACHE.set(repo, cache);
  }
  const parts: Buffer[] = [];
  let count = 0;
  for (const oid of list) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    parts.push(packObjectHeader(object.type, object.data.length));
    let compressed = cache.get(oid);
    if (compressed === undefined) {
      compressed = deflateSync(object.data, { level: 1 }) as unknown as Buffer;
      cache.set(oid, compressed);
    }
    parts.push(compressed);
    count += 1;
  }
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...parts]);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  packCache.set(key, pack);
  return pack;
}
