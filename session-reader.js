/**
 * Read a message's full text out of a DSH session log, by message id.
 *
 * The plugin needs this for the "quote by reference" mode: the client sends
 * only a message id, and the text is pulled from the session event stream on
 * demand instead of being pasted into the composer.
 *
 * Why a file reader instead of a service call: `ctx.sessions` exposes only
 * `get`/`list` and neither returns the event stream. The durable log is an
 * append-only jsonl in multi-frame zstd, so it is read and indexed here.
 *
 * The index is cached per session and rebuilt only when the file changes, since
 * a session log grows with every turn and a full re-read costs ~1-2s on a long
 * conversation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Root of all durable session logs. */
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');

/** Zstd frame magic number. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Per-session cache: sessionId -> { mtimeMs, index }. */
const cache = new Map();

/**
 * Locate the durable log file for one session.
 *
 * Logs live under a workspace-derived slug directory, which the caller does not
 * know, so this scans the slug level. There are only a handful of slugs.
 *
 * @param sessionId - bare session uuid (with or without the `session-` prefix).
 * @returns absolute path, or null when no log exists.
 */
export function findSessionFile(sessionId) {
  const bare = String(sessionId).replace(/^session-/, '');
  if (bare.length === 0 || !existsSync(SESSIONS_ROOT)) return null;
  let slugs;
  try {
    slugs = readdirSync(SESSIONS_ROOT);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const file = join(SESSIONS_ROOT, slug, `session-${bare}`, 'session.v4.jsonl.zstd');
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Decompress every zstd frame in a multi-frame buffer.
 *
 * The log is written frame-by-frame (one per append), so it is not a single
 * zstd stream and a plain decompress only yields the first frame.
 *
 * @param buffer - raw file contents.
 * @returns the concatenated decoded text.
 */
function decompressFrames(buffer) {
  const starts = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (
      buffer[index] === MAGIC[0] &&
      buffer[index + 1] === MAGIC[1] &&
      buffer[index + 2] === MAGIC[2] &&
      buffer[index + 3] === MAGIC[3]
    ) {
      starts.push(index);
    }
  }
  if (starts.length === 0) return '';
  const parts = [];
  for (let frame = 0; frame < starts.length; frame += 1) {
    const start = starts[frame];
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      /* a torn trailing frame must not lose the rest of the log */
    }
  }
  return parts.join('');
}

/**
 * Message id of one event, if it carries one.
 *
 * `user/message` keeps it at `data.id`; `assistant/message` nests it at
 * `data.message.id`.
 *
 * @param data - the event's `data` object.
 * @returns the id, or undefined.
 */
function messageIdOf(data) {
  if (data === null || typeof data !== 'object') return undefined;
  if (typeof data.id === 'string') return data.id;
  const nested = data.message;
  if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string') return nested.id;
  return undefined;
}

/**
 * Text parts of one event, joined.
 *
 * @param data - the event's `data` object.
 * @returns the text, possibly empty.
 */
function textOf(data) {
  const content = data?.content ?? data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * Build (or reuse) the id → text index for one session.
 *
 * A single message id can appear across several events (streaming parts), so
 * text is accumulated per id rather than overwritten.
 *
 * @param sessionId - session whose log to index.
 * @returns the index, or null when the log cannot be read.
 */
function indexFor(sessionId) {
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(sessionId);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.index;

  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    return null;
  }
  const text = decompressFrames(raw);
  const index = new Map();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event?.data;
    const id = messageIdOf(data);
    if (id === undefined) continue;
    const body = textOf(data);
    if (body.length === 0) continue;
    const previous = index.get(id);
    index.set(id, previous === undefined ? body : `${previous}\n${body}`);
  }
  cache.set(sessionId, { mtimeMs, index });
  return index;
}

/**
 * Read one message's full text by id.
 *
 * @param sessionId - owning session (bare uuid or `session-`-prefixed).
 * @param messageId - the message id.
 * @returns the text, or null when the id is not in the log.
 */
export function readMessageById(sessionId, messageId) {
  if (typeof sessionId !== 'string' || typeof messageId !== 'string') return null;
  const index = indexFor(sessionId);
  if (index === null) return null;
  return index.get(messageId) ?? null;
}

/**
 * Drop cached indexes (test helper / memory release).
 */
export function clearCache() {
  cache.clear();
}
