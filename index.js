/**
 * dsh-quote-shot — Host (node) half.
 *
 * Owns the context-injection route. Quoting must NOT paste the whole message
 * into the composer: it has to reach the model as context while the composer
 * stays clean. The only supported way to do that is an injected `role: 'user'`
 * message carrying a `source.summary` — the Host renders that summary as a
 * collapsed row and the model still receives the full `content.text`.
 *
 * Reference implementation studied: `heartmove/dsh-side-chat` (MIT), whose
 * host half does exactly `ctx.agents.get(parentSessionId).inject({...})`.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readMessageById, readMessageFromFile, listRecentSessionFiles } from './session-reader.js';

/**
 * Diagnostic log path.
 *
 * Kept deliberately tiny: quote failures were invisible from the UI (the widget
 * only surfaced a toast), so every request and refusal leaves one line here.
 * Writes are best-effort and must never break the request they describe.
 */
const TRACE_FILE = join(homedir(), '.dsh', 'logs', 'quote-shot.log');

/**
 * Append one diagnostic line.
 *
 * @param line - what happened.
 */
function trace(line) {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics must never break the request */
  }
}

/**
 * Services this plugin depends on.
 *
 * `agents` MUST be declared here. Cordis only injects declared services, and an
 * undeclared one reads as `undefined` rather than the live registry — that
 * mistake made every quote fail with `agents-unavailable`. `dsh-agent` is part
 * of the core bundles, so the registry is present by the time this route is
 * called; the handler still guards defensively for the case where a tab
 * outlives its agent.
 */
export const inject = ['webServer', 'agents', 'tools'];

/** Route owned by this plugin. */
const ROUTE = '/quote-shot/inject';

/**
 * Route where the client reports which session a quote id belongs to.
 *
 * This is the one piece of knowledge the Host cannot recover reliably: the
 * click happens in a known session, but `quote_read` runs later with no session
 * context at all. Remembering the click's sessionId turns "guess which live
 * agent is calling" into a direct lookup.
 */
const HINT_ROUTE = '/quote-shot/hint';

/**
 * messageId -> sessionId, filled by the client when a quote is placed.
 *
 * Bounded: a long session can quote many messages, and only recent quotes are
 * plausibly still unread. Oldest entries fall out first (Map preserves order).
 */
const quoteHints = new Map();
const MAX_HINTS = 200;

/**
 * Remember which session a quoted message belongs to.
 *
 * @param messageId - quoted message id.
 * @param sessionId - session the quote button was clicked in.
 */
function rememberHint(messageId, sessionId) {
  if (messageId.length === 0 || sessionId.length === 0) return;
  quoteHints.delete(messageId);
  quoteHints.set(messageId, sessionId);
  if (quoteHints.size > MAX_HINTS) {
    const oldest = quoteHints.keys().next().value;
    quoteHints.delete(oldest);
  }
}

/**
 * Longest accepted quote body, so one call cannot flood the context.
 */
const MAX_TEXT_CHARS = 20_000;
/** Longest accepted summary line shown in the collapsed row. */
const MAX_SUMMARY_CHARS = 200;

/**
 * Read and parse a JSON request body.
 *
 * @param request - the Node incoming message.
 * @returns the parsed body, or null when it is not JSON.
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Refuse oversized bodies instead of buffering them indefinitely.
    if (size > 4 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Shape the text the model receives.
 *
 * @param text - the raw quoted message text.
 * @returns the quoted block, clearly marked so the model can tell it apart
 *          from the user's own words.
 */
function buildContextText(text) {
  const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…（引用已截断）` : text;
  return `以下是我引用的一条历史消息，请把它作为上下文参考：\n\n<<<引用开始>>>\n${clipped}\n<<<引用结束>>>`;
}

/**
 * One-line summary shown as the collapsed row.
 *
 * @param text - the raw quoted message text.
 * @returns a single line excerpt.
 */
function buildSummary(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}…` : flat;
  return `引用：${clipped}`;
}

/**
 * Register the injection route.
 *
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        // `register` keys routes by (kind, path). `kind` is `"exact"` or
        // `"prefix"` — it is NOT an HTTP method; the method check belongs inside
        // the handler (see dsh-client-hmr / dsh-client-connection for the shape).
        kind: 'exact',
        path: ROUTE,
        handler: async (request, response) => {
          const reply = (status, body) => {
            response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify(body));
          };

          // One route can be hit with any verb; refuse the wrong ones here.
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }

          const body = await readJson(request);
          if (body === null) {
            reply(400, { ok: false, code: 'bad-json' });
            return;
          }

          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          // Every request leaves a line, so a silent UI failure can be told
          // apart from "the widget never called us".
          trace(`request session=${sessionId || '(empty)'} textLen=${text.length}`);
          if (sessionId.length === 0 || text.length === 0) {
            reply(400, { ok: false, code: 'missing-fields' });
            return;
          }

          // Resolved lazily: `agents` is a declared dependency, but the registry
          // lookup can legitimately miss while a tab outlives its agent.
          let agents;
          try {
            agents = ctx.agents;
          } catch {
            agents = undefined;
          }
          if (agents === undefined || agents === null) {
            trace(`agents service missing`);
            reply(409, { ok: false, code: 'agents-unavailable' });
            return;
          }

          // The registry keys agents by the FULL session id (`session-<uuid>`),
          // while the client slot hands us the bare uuid. Try both forms — this
          // mismatch is why every earlier quote missed the registry.
          const lookup = (id) => {
            if (typeof id !== 'string' || id.length === 0) return undefined;
            const direct = agents.get(id);
            if (direct !== undefined && direct !== null) return direct;
            if (id.startsWith('session-')) return agents.get(id.slice('session-'.length));
            return agents.get(`session-${id}`);
          };

          const agent = lookup(sessionId);
          if (agent === undefined || agent === null) {
            // Diagnostic payload: which ids the registry actually holds. This is
            // what told us the client slot's sessionId does not match the
            // registry key; keep it, it costs nothing and saves a debug cycle.
            let available = [];
            try {
              available = agents.list().map((item) => item?.id ?? item?.session?.id ?? '(unknown)');
            } catch {
              available = ['(list failed)'];
            }
            trace(`agent-unavailable asked=${sessionId} available=[${available.join(', ')}]`);
            reply(409, { ok: false, code: 'agent-unavailable', asked: sessionId, available });
            return;
          }

          try {
            agent.inject({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: buildContextText(text) }],
              // `form: 'notice'` collapses the row; `summary` is what the row shows.
              source: { kind: 'plugin:dsh-quote-shot', form: 'notice', summary: buildSummary(text) }
            });
            reply(200, { ok: true, summary: buildSummary(text) });
          } catch (error) {
            reply(500, { ok: false, code: 'inject-failed', message: String((error && error.message) || error) });
          }
        }
      }),
    'quote-shot: inject route'
  );

  // Client-side diagnostics sink. The action button has several "return without
  // telling anyone" paths (no text found, no session id); this route lets the
  // widget report them instead of failing silently.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/quote-shot/log',
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          const payload = await readJson(request);
          // Wider cap: DOM-shape diagnostics are long, and cutting them
          // mid-object would defeat the purpose of reporting them.
          trace(`client: ${JSON.stringify(payload).slice(0, 2500)}`);
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.end('{"ok":true}');
        }
      }),
    'quote-shot: client log route'
  );

  // Client hint sink: which session the quote was placed in.
  //
  // Fire-and-forget from the client. A missed hint only costs a slower lookup
  // (the registry and the on-disk scan still run), so failures are silent.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: HINT_ROUTE,
        handler: async (request, response) => {
          const reply = (status, body) => {
            response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify(body));
          };
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          const body = await readJson(request);
          if (body === null) {
            reply(400, { ok: false, code: 'bad-json' });
            return;
          }
          const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
          if (messageId.length === 0 || sessionId.length === 0) {
            reply(400, { ok: false, code: 'missing-fields' });
            return;
          }
          rememberHint(messageId, sessionId);
          trace(`hint message=${messageId} session=${sessionId}`);
          reply(200, { ok: true });
        }
      }),
    'quote-shot: hint route'
  );

  // The `quote_read` tool: read a message's full text by id.
  //
  // This is what makes "quote by reference" possible — the composer carries only
  // `[引用消息 <id>]`, and the model pulls the text on demand instead of having
  // it pasted in at click time (which is what makes today's quotes irreversible).
  //
  // The tool descriptor does not receive a session id (`exec` carries only
  // `signal`), so the owning conversation is resolved from the live agent
  // registry: the most recently registered live agent is the one calling.
  ctx.effect(
    () => {
      // Registration runs inside an effect, where a throw would otherwise vanish
      // silently — trace both sides so a failed registration is visible.
      trace('registering tool quote_read');
      try {
        // Built by hand, NOT with `defineTool` from @deepseek-ai/dsh-tools:
        // that package lives inside app.asar and cannot be resolved from an
        // external plugin, so importing it threw at module load and took the
        // whole plugin down (routes 404, quote button gone).
        const disposer = ctx.tools.register({
          name: 'quote_read',
          description:
            'Read the full text of a message from this conversation by its id. A user message containing `[引用消息 <id>` means the user explicitly quoted that message and expects you to read it before answering — call this even if you believe you already know the content. Quoting is an instruction to look, not a hint that the text may be needed.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: {
                type: 'string',
                description: 'The message id to read (as shown in the quote marker).'
              }
            },
            required: ['messageId']
          },
          output: {
            // Plain JSON Schema: `register` validates this directly (it only
            // converts when going through defineTool).
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                found: { type: 'boolean' },
                messageId: { type: 'string' },
                text: { type: 'string' },
                error: { type: 'string' }
              },
              required: ['found', 'messageId']
            },
            // `render` must return content PARTS (an array), not a plain
            // string — the host maps it onto the message content model and
            // calls array methods on it ("content.some is not a function").
            render(args, value) {
              const body =
                value.found === true
                  ? `消息 ${value.messageId} 的全文：\n\n${value.text ?? ''}`
                  : `未找到消息 ${value.messageId}（${value.error ?? 'unknown'}）`;
              return [{ type: 'text', text: body }];
            }
          },
          async execute(args) {
            const messageId = typeof args?.messageId === 'string' ? args.messageId.trim() : '';
            if (messageId.length === 0) return { found: false, messageId: '', error: 'missing-messageId' };

            const startedAt = Date.now();
            const tried = [];

            // 1. The session the client reported when the quote was placed.
            //    This is the exact answer, and it is the only step that works
            //    when the caller is not the session that owns the message.
            const hinted = quoteHints.get(messageId);
            if (typeof hinted === 'string' && hinted.length > 0) {
              tried.push(hinted);
              const text = readMessageById(hinted, messageId);
              if (text !== null) {
                trace(`quote_read session=${hinted} message=${messageId} len=${text.length} via=hint`);
                return { found: true, messageId, text };
              }
            }

            // 2. Every live agent, newest first.
            //
            //    The previous version used ONLY the last registered agent. That
            //    is wrong: Mnemon's idle checkpoint reviewer runs as a live
            //    subagent, so "the last live agent" can be a background reviewer
            //    session that has never seen the quoted message. Iterating all of
            //    them costs one Map lookup per agent and removes the guess.
            let live = [];
            try {
              live = ctx.agents.list();
            } catch {
              live = [];
            }
            for (let index = live.length - 1; index >= 0; index -= 1) {
              const sessionId = live[index]?.session?.id;
              if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
              if (tried.includes(sessionId)) continue;
              tried.push(sessionId);
              const text = readMessageById(sessionId, messageId);
              if (text !== null) {
                trace(`quote_read session=${sessionId} message=${messageId} len=${text.length} via=live`);
                return { found: true, messageId, text };
              }
            }

            // 3. On-disk scan of the most recently used logs.
            //
            //    Covers the case no registry can: DSH restarted, or the quoted
            //    message belongs to a conversation that is no longer live. Message
            //    ids are UUIDs, so a hit is unambiguous.
            let sources = [];
            try {
              sources = listRecentSessionFiles(25);
            } catch {
              sources = [];
            }
            for (const source of sources) {
              const text = readMessageFromFile(source.file, messageId);
              if (text !== null) {
                trace(`quote_read session=${source.sessionId} message=${messageId} len=${text.length} via=scan`);
                return { found: true, messageId, text };
              }
            }

            // Failure MUST be traced. Silently returning `not-found` is exactly
            // how this bug stayed invisible: the UI showed a message it could not
            // find, and the log had nothing.
            trace(
              `quote_read MISS message=${messageId} tried=[${tried.join(', ')}] scanned=${sources.length} ms=${Date.now() - startedAt}`
            );
            return { found: false, messageId, error: 'not-found' };
          }
        });
        trace('tool quote_read registered');
        return disposer;
      } catch (error) {
        // Deliberately swallowed: a tool that fails to register must not take
        // down the quote UI with it. The log line is the evidence.
        trace(`tool registration FAILED: ${String((error && error.message) || error)}`);
        return () => {};
      }
    },
    'quote-shot: quote_read tool'
  );
}
