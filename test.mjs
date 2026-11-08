/**
 * Offline tests for the quote-shot client bundle.
 *
 * No React, no DOM: a minimal stub evaluates the lazy-CJS bundle and exercises
 * the pure helpers plus the slot registration.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const BUNDLE = path.join(import.meta.dirname, 'client.js');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${detail}`}`);
  }
}

// ── React stub ───────────────────────────────────────────────────────────────
const hookSlots = [];
let hookCursor = 0;
const react = {
  createElement(type, props, ...children) {
    const flat = [];
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child);
      else if (child !== null && child !== undefined && child !== false) flat.push(child);
    }
    return { type, props: props ?? {}, children: flat };
  },
  useState(initial) {
    const i = hookCursor++;
    if (!(i in hookSlots)) hookSlots[i] = initial;
    return [hookSlots[i], () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  Fragment: 'fragment'
};

// ── DOM stubs ────────────────────────────────────────────────────────────────
/** Fake element good enough for readQuoteText's clone-and-strip walk. */
function el(tag, text, parent) {
  const node = {
    tag,
    text,
    parentElement: parent ?? null,
    children: [],
    cloneNode() {
      const copy = el(this.tag, this.text, null);
      copy.children = this.children.map((c) => {
        const child = c.cloneNode();
        child.parentElement = copy;
        return child;
      });
      return copy;
    },
    /** Real DOM elements support this; the bundle's strip step calls it. */
    remove() {
      const parent = this.parentElement;
      if (parent === null) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
    },
    /** The sibling walk in readQuoteText relies on this. */
    get previousElementSibling() {
      const parent = this.parentElement;
      if (parent === null || parent === undefined) return null;
      const index = parent.children.indexOf(this);
      return index > 0 ? parent.children[index - 1] : null;
    },
    querySelectorAll(selector) {
      const out = [];
      const wantButton = selector.includes('button');
      const walk = (n) => {
        for (const c of n.children) {
          if (wantButton && (c.tag === 'button' || c.tag === 'svg')) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    get innerText() {
      const parts = [];
      const walk = (n) => {
        if (n.text) parts.push(n.text);
        for (const c of n.children) walk(c);
      };
      walk(this);
      return parts.join('\n');
    }
  };
  return node;
}

const selection = { text: '', isCollapsed: true };
const sandbox = {
  window: {
    __ModuleLoader__: { load: (r) => (sandbox.__registration = r) },
    getSelection: () => ({
      isCollapsed: selection.isCollapsed,
      toString: () => selection.text
    })
  },
  document: {},
  console,
  Date,
  Number,
  String,
  Array,
  Object,
  Symbol,
  Error,
  Math,
  AbortSignal: { timeout: () => undefined },
  /** Replaced per-case in the injectQuote block. */
  fetch: async () => {
    throw new Error('unexpected fetch');
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.js' });

const registration = sandbox.__registration;
console.log('bundle registration');
check('registers one factory', registration !== undefined);
check('id matches the package name', registration?.id === 'dsh-quote-shot', registration?.id);

const api = registration.factory((spec) => {
  if (spec === 'react') return react;
  throw new Error(`unexpected require("${spec}")`);
});

console.log('\nexports');
check('exports apply', typeof api.apply === 'function');
check('declares ctx services', Array.isArray(api.inject) && api.inject.includes('slots') && api.inject.includes('locale'), JSON.stringify(api.inject));

console.log('\ninjectQuote');
{
  const saved = sandbox.fetch;
  let seen = null;

  // Success: the Host accepted the injection.
  sandbox.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, summary: '引用：…' }) };
  };
  const ok = await api.injectQuote('session-1', '被引用的正文内容');
  check('posts to the host route', seen?.url === '/quote-shot/inject', seen?.url);
  check('sends the session id', seen?.body?.sessionId === 'session-1', JSON.stringify(seen?.body));
  check('sends the quoted text', seen?.body?.text === '被引用的正文内容', JSON.stringify(seen?.body));
  check('reports success', ok.ok === true, JSON.stringify(ok));

  // Host refused (agent not live).
  sandbox.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'agent-unavailable' }) });
  const refused = await api.injectQuote('session-1', 'x');
  check('surfaces a refused injection', refused.ok === false && refused.code === 'agent-unavailable', JSON.stringify(refused));

  // Transport failure must not throw.
  sandbox.fetch = async () => {
    throw new Error('network down');
  };
  const broken = await api.injectQuote('session-1', 'x');
  check('a transport failure is reported, not thrown', broken.ok === false, JSON.stringify(broken));

  // Long text is clipped before it leaves the browser.
  sandbox.fetch = async (url, init) => {
    seen = { body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await api.injectQuote('session-1', 'y'.repeat(9000));
  check('clips oversized quotes client-side', seen.body.text.length === 4000, String(seen.body.text.length));

  sandbox.fetch = saved;
}

console.log('\nreadQuoteText');
{
  selection.text = '  selected bit  ';
  selection.isCollapsed = false;
  const anchor = el('button', '引用');
  const text = api.readQuoteText(anchor);
  check('prefers the live selection', text === 'selected bit', JSON.stringify(text));
}
{
  selection.text = '';
  selection.isCollapsed = true;
  // Mirrors real DOM: body and the action row are siblings under one message
  // container, and the action row's only text lives inside its button.
  const message = el('div', '', null);
  const body = el('div', '这是一条很长的助手消息正文，用来说明 DOM 提取路径可以工作。', message);
  const actions = el('span', '', message);
  message.children.push(body, actions);
  const button = el('button', '引用', actions);
  actions.children.push(button);
  const text = api.readQuoteText(button);
  check('falls back to the message DOM', text.includes('助手消息正文'), JSON.stringify(text));
  check('strips the action label from the quote', text.includes('引用') === false, JSON.stringify(text));
}
{
  selection.text = '';
  selection.isCollapsed = true;
  // Regression guard for the reported bug: a turn is laid out as
  // user message → assistant reply → action row. Quoting must take the reply,
  // never the user's own question.
  const turn = el('div', '', null);
  const userMessage = el('div', '这是我自己输入的问题，绝对不该被引用进上下文。', turn);
  const assistantBody = el('div', '这是助手真正的回话内容，引用应该拿到这一段文字。', turn);
  const actions = el('span', '', turn);
  turn.children.push(userMessage, assistantBody, actions);
  const button = el('button', '引用', actions);
  actions.children.push(button);
  const text = api.readQuoteText(button);
  check('quotes the assistant reply, not the user question', text.includes('助手真正的回话') && !text.includes('我自己输入的问题'), JSON.stringify(text));
}
{
  selection.text = '';
  selection.isCollapsed = true;
  const lone = el('button', '引用');
  check('returns empty when there is nothing to quote', api.readQuoteText(lone) === '', JSON.stringify(api.readQuoteText(lone)));
}

console.log('\npreviewOf');
{
  check('keeps short text intact', api.previewOf('短文本') === '短文本', api.previewOf('短文本'));
  check('collapses whitespace to one line', api.previewOf('a\n\nb') === 'a b', api.previewOf('a\n\nb'));
  const long = 'x'.repeat(200);
  const preview = api.previewOf(long);
  check('clips long text', preview.length <= 61 && preview.endsWith('…'), `${preview.length}`);
  check('trims surrounding space', api.previewOf('  hi  ') === 'hi', JSON.stringify(api.previewOf('  hi  ')));
}

console.log('\napply() wiring');
{
  const localeRegs = [];
  const slotInjections = [];
  const seats = [];
  const ctx = {
    effect(fn) {
      return fn();
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegs.push({ namespace, dictionaries });
        return () => {};
      }
    },
    slots: {
      inject(slot, register) {
        slotInjections.push(slot);
        seats.push(register());
        return () => {};
      },
      register(spec, component) {
        return { spec, component };
      }
    }
  };
  api.apply(ctx);
  check('registers the dictionaries', localeRegs.length === 1 && localeRegs[0].namespace === 'quoteShot', JSON.stringify(localeRegs.map((r) => r.namespace)));
  check('dictionaries carry zh and en', Boolean(localeRegs[0]?.dictionaries?.zh && localeRegs[0]?.dictionaries?.en));
  check('injects into two slots', slotInjections.length === 2, slotInjections.join(','));
  check('first seat is the message action', slotInjections[0] === 'conversation.chat.assistant-actions', slotInjections[0]);
  check('second seat is the composer dock', slotInjections[1] === 'conversation.input.dock', slotInjections[1]);
  const actionSeat = seats.find((s) => s?.spec?.id === 'quote');
  const cardSeat = seats.find((s) => s?.spec?.id === 'quote-card');
  check('registers the action component', actionSeat?.component === api.QuoteActions);
  check('registers the card component', cardSeat?.component === api.QuoteCard);
  check('action order is after feedback (10)', actionSeat?.spec?.order === 20, String(actionSeat?.spec?.order));
  check('both seats declare the locale', actionSeat?.spec?.locale === 'quoteShot' && cardSeat?.spec?.locale === 'quoteShot');
  check('both seats inject their sessionId', typeof actionSeat?.spec?.inject === 'function' && typeof cardSeat?.spec?.inject === 'function');
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;
