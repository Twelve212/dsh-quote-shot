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

/** Per-file cache: absolute log path -> { mtimeMs, index }. */
const cache = new Map();

/** Log file name inside a session directory. */
const LOG_NAME = 'session.v4.jsonl.zstd';

/**
 * Directory names one session log may live under.
 *
 * DSH is not consistent here: sessions created by the desktop UI are stored as
 * `session-<uuid>`, while subagent sessions and older logs use a bare `<uuid>`.
 * On this machine that was 12 prefixed vs 161 bare logs in ONE workspace slug,
 * so matching only the prefixed form silently missed almost every session.
 *
 * @param sessionId - bare session uuid, with or without the `session-` prefix.
 * @returns candidate directory names, most likely first.
 */
function sessionDirCandidates(sessionId) {
  const bare = String(sessionId).replace(/^session-/, '');
  if (bare.length === 0) return [];
  return [`session-${bare}`, bare];
}

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
  if (!existsSync(SESSIONS_ROOT)) return null;
  let slugs;
  try {
    slugs = readdirSync(SESSIONS_ROOT);
  } catch {
    return null;
  }
  for (const dir of sessionDirCandidates(sessionId)) {
    for (const slug of slugs) {
      const file = join(SESSIONS_ROOT, slug, dir, LOG_NAME);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/**
 * Every session log under the sessions root, newest first.
 *
 * Used as the last-resort lookup: a quoted message can be older than the set of
 * live agents (DSH restarted, or the conversation was reopened from history), so
 * the owning session has to be found on disk rather than in the registry.
 *
 * @param limit - how many of the most recently touched logs to return.
 * @returns `{ sessionId, file, mtimeMs }` entries, newest first.
 */
export function listRecentSessionFiles(limit = 25) {
  if (!existsSync(SESSIONS_ROOT)) return [];
  const found = [];
  let slugs;
  try {
    slugs = readdirSync(SESSIONS_ROOT);
  } catch {
    return [];
  }
  for (const slug of slugs) {
    let dirs;
    try {
      dirs = readdirSync(join(SESSIONS_ROOT, slug));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const file = join(SESSIONS_ROOT, slug, dir, LOG_NAME);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      found.push({ sessionId: dir.replace(/^session-/, ''), file, mtimeMs: stat.mtimeMs });
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found.slice(0, Math.max(1, limit));
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
 * Build (or reuse) the id → text index for one log file.
 *
 * A single message id can appear across several events (streaming parts), so
 * text is accumulated per id rather than overwritten.
 *
 * Cached by FILE PATH, not session id: the same log can be reached through a
 * prefixed and a bare directory name, and keying by id would build it twice.
 *
 * @param file - absolute log path.
 * @returns the index, or null when the log cannot be read.
 */
function indexForFile(file) {
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(file);
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
  cache.set(file, { mtimeMs, index });
  return index;
}

/**
 * Read one message's text out of a specific log file.
 *
 * @param file - absolute log path.
 * @param messageId - the message id.
 * @returns the text, or null when the id is not in that log.
 */
export function readMessageFromFile(file, messageId) {
  if (typeof file !== 'string' || typeof messageId !== 'string') return null;
  const index = indexForFile(file);
  if (index === null) return null;
  return index.get(messageId) ?? null;
}

/**
 * Read one message's full text by id, from its owning session.
 *
 * @param sessionId - owning session (bare uuid or `session-`-prefixed).
 * @param messageId - the message id.
 * @returns the text, or null when the id is not in the log.
 */
export function readMessageById(sessionId, messageId) {
  if (typeof sessionId !== 'string' || typeof messageId !== 'string') return null;
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  return readMessageFromFile(file, messageId);
}

/**
 * Drop cached indexes (test helper / memory release).
 */
export function clearCache() {
  cache.clear();
}
