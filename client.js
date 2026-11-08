/**
 * dsh-quote-shot — browser (client) half.
 *
 * Quoting injects a collapsed context row into the session instead of pasting
 * the message into the composer. The Host owns the injection (`POST
 * /quote-shot/inject`); this half only:
 *   - puts a quote icon on every assistant message
 *   - shows one-line quote cards above the composer
 *
 * The composer stays clean, and the model still receives the full quoted text.
 */

window.__ModuleLoader__.load({
  id: 'dsh-quote-shot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /** Plugin context, for the components that need services outside a slot. */
    let pluginCtx = null;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    /** Locale namespace this plugin owns. */
    const NS = 'quoteShot';

    const zh = {
      title: '引用',
      remove: '移除这条引用标记',
      empty: '没找到可引用的文字',
      failed: '引用失败，请重试'
    };
    const en = {
      title: 'Quote',
      remove: 'Remove this quote marker',
      empty: 'Nothing to quote',
      failed: 'Quote failed, try again'
    };

    /** Longest quoted excerpt sent as context. */
    const MAX_QUOTE_CHARS = 4000;
    /** Characters shown in the card's single preview line. */
    const CARD_PREVIEW_CHARS = 60;
    /** Host route that performs the injection. */
    const INJECT_ROUTE = '/quote-shot/inject';
    /** Host route where the click's session is reported for `quote_read`. */
    const HINT_ROUTE = '/quote-shot/hint';

    //#region quote state
    /**
     * Per-session list of quotes, newest last.
     *
     * A tiny external store keeps the action row and the composer cards in sync.
     */
    const quoteState = new Map();
    const listeners = new Set();

    function emit() {
      for (const listener of listeners) listener();
    }

    function listQuotes(sessionId) {
      return quoteState.get(sessionId) ?? [];
    }

    /**
     * Replace this session's cards with a single new one.
     *
     * A quote is consumed by exactly one send, so keeping a growing list is
     * wrong: the card is a receipt for the pending quote, not a history. This
     * also guarantees the UI cannot accumulate stale cards even if the
     * send-completion signal is unavailable.
     */
    function replaceQuote(sessionId, quote) {
      quoteState.set(sessionId, [quote]);
      emit();
    }

    function addQuote(sessionId, quote) {
      quoteState.set(sessionId, [...listQuotes(sessionId), quote]);
      emit();
    }

    function removeQuote(sessionId, id) {
      quoteState.set(
        sessionId,
        listQuotes(sessionId).filter((item) => item.id !== id)
      );
      emit();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    /**
     * Send a client-side diagnostic line to the Host log.
     *
     * Fire-and-forget by design: a diagnostic that can throw or block would be
     * worse than none. Best-effort, never awaited.
     *
     * @param stage - which step reported.
     * @param detail - extra context worth keeping.
     */
    function postLog(stage, detail) {
      try {
        fetch('/quote-shot/log', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: detail ?? null })
        }).catch(() => {});
      } catch {
        /* ignored on purpose */
      }
    }
    /**
     * Tell the Host which session this quote id belongs to.
     *
     * `quote_read` runs later with no session context, and the live-agent
     * registry cannot be trusted to point at the caller (background subagents
     * are live agents too). The click is the one moment the id and the session
     * are both known, so it is recorded here.
     *
     * Fire-and-forget: a lost hint only costs the Host a slower fallback lookup.
     *
     * @param messageId - the quoted message id.
     * @param sessionId - the session the button was clicked in.
     */
    function postHint(messageId, sessionId) {
      try {
        fetch(HINT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId, sessionId })
        }).catch(() => {});
      } catch {
        /* ignored on purpose */
      }
    }
    //#endregion

    /**
     * Read the text to quote.
     *
     * Prefers the live selection. Otherwise walks UP from the action button and
     * takes the FIRST previous sibling that holds a body of text.
     *
     * That sibling walk is deliberate: climbing ancestors instead would swallow
     * the whole turn — user message plus assistant reply — and the first long
     * text found is usually the USER's question, which is the wrong thing to
     * quote. The action row's preceding sibling is this message's own body.
     *
     * @param anchor - the clicked button element.
     * @returns the text, or an empty string when nothing usable was found.
     */
    /**
     * Where a quoted message was on screen, keyed by message id.
     *
     * DSH's message DOM carries no message id — only `data-chat-anchor-key` — so
     * a message id alone cannot find its row. The one moment the row IS known is
     * the quote click, because the button lives inside it; the row's anchor is
     * recorded then and replayed later.
     *
     * Global rather than per-session: ids are UUIDs so they cannot collide, and
     * the sent-message card has no session id available.
     */
    const ANCHOR_STORE = 'dsh-quote-shot:anchors';
    const ANCHOR_LIMIT = 200;

    /**
     * Chip source name.
     *
     * DSH renders a composer chip when the draft carries a reference of this
     * source. The chip exists only for APPEARANCE: its label is a short tag, its
     * clipboardText and serialised form are the same marker we have always sent,
     * so the model and `quote_read` see exactly what they saw before.
     */
    const CHIP_SOURCE = 'quote-shot';

    /**
     * The marker that travels with the message.
     *
     * @param messageId - quoted message id.
     * @returns the instruction line.
     */
    function buildMarker(messageId) {
      return `[引用消息 ${messageId}——请先调用 quote_read 读取全文，再回答]`;
    }

    /**
     * Insert one quote chip at the very top of the draft.
     *
     * Done as a single `setDraft` rather than insert-then-reorder: a chip has an
     * offset, so moving text after the fact would desynchronise it.
     *
     * @param messageId - quoted message id.
     * @param sessionId - the session owning the composer.
     * @param preview - the quoted text, used for the chip's label.
     * @returns true when the draft was rewritten.
     */
    function insertQuoteChip(messageId, sessionId, preview) {
      const actx = pluginCtx?.sessions?.scope?.(sessionId);
      const input = actx === undefined || actx === null ? undefined : pluginCtx?.conversation?.input?.for?.(actx);
      const snapshot = input?.draftSnapshot;
      if (snapshot === undefined || snapshot === null || typeof snapshot.text !== 'string') return false;

      const marker = buildMarker(messageId);
      const added = `${marker}\n`;
      // An id alone tells the reader nothing; the opening words do.
      const flat = String(preview ?? '').replace(/\s+/g, ' ').trim();
      const label =
        flat.length === 0
          ? `引用 ${messageId.slice(0, 8)}`
          : `引用 · ${flat.slice(0, 28)}${flat.length > 28 ? '…' : ''}`;
      const chip = {
        source: CHIP_SOURCE,
        ref: messageId,
        offset: 0,
        length: marker.length,
        label,
        clipboardText: marker
      };
      const references = (Array.isArray(snapshot.references) ? snapshot.references : [])
        .map((reference) => ({ ...reference, offset: reference.offset + added.length }));
      references.push(chip);
      references.sort((a, b) => a.offset - b.offset);

      input.setDraft({ text: added + snapshot.text, references });
      return true;
    }

    /**
     * Remember which DOM row a message occupies.
     *
     * Stores the row anchor AND its turn id. The row is NOT a whole message: a
     * reply is several rows (text, tool cards, file-change card) and the quote
     * button lives in the LAST one, so highlighting just that row framed the
     * file card instead of the answer. The turn id lets the jump widen to the
     * whole exchange.
     *
     * @param messageId - quoted message id.
     * @param row - the message row element.
     */
    function rememberAnchor(messageId, row) {
      // Diagnose FIRST: the previous version returned before this ran whenever
      // `closest` missed, which is exactly the case worth seeing. Records the
      // whole ancestor chain (tag, class head, data-* attrs) so the real wrapper
      // can be identified from outside.
      try {
        const chain = [];
        let node = row;
        for (let depth = 0; depth < 10 && node !== null && node !== undefined; depth += 1) {
          const bits = [];
          for (const attr of node.attributes ?? []) {
            if (!attr.name.startsWith('data-')) continue;
            bits.push(`${attr.name}=${String(attr.value).slice(0, 20)}`);
            if (bits.length >= 3) break;
          }
          const cls = String(node.className ?? '').split(/\s+/).filter(Boolean)[0] ?? '';
          chain.push(`${node.tagName?.toLowerCase()}.${cls.slice(0, 22)}[${bits.join(',')}]`);
          node = node.parentElement;
        }
        postLog('anchor-chain', { rowFound: row !== null && row !== undefined, chain });
      } catch {
        /* diagnostics never break the click */
      }

      const key = row?.getAttribute?.('data-chat-anchor-key');
      if (typeof key !== 'string' || key.length === 0) return;
      const turn = row?.getAttribute?.('data-chat-turn') ?? null;
      try {
        const all = JSON.parse(localStorage.getItem(ANCHOR_STORE) ?? '{}');
        delete all[messageId];
        all[messageId] = { key, turn };
        const ids = Object.keys(all);
        for (const stale of ids.slice(0, Math.max(0, ids.length - ANCHOR_LIMIT))) delete all[stale];
        localStorage.setItem(ANCHOR_STORE, JSON.stringify(all));
      } catch {
        /* storage is best-effort; jumping just degrades */
      }
    }

    /**
     * The recorded row anchor for a message.
     *
     * Tolerates the older plain-string format.
     *
     * @param messageId - quoted message id.
     * @returns `{ key, turn }`, or null.
     */
    function anchorFor(messageId) {
      try {
        const all = JSON.parse(localStorage.getItem(ANCHOR_STORE) ?? '{}');
        const value = all[messageId];
        if (typeof value === 'string') return { key: value, turn: null };
        if (value !== null && typeof value === 'object' && typeof value.key === 'string') return value;
        return null;
      } catch {
        return null;
      }
    }

    /**
     * Scroll to a quoted message and flash it.
     *
     * Highlights the whole turn when the turn id is known, otherwise the row
     * itself. Messages the virtualised list has not rendered are not in the DOM
     * at all; there is no honest way to jump to them, so this reports "not on
     * screen" instead of inventing a scroll.
     *
     * @param messageId - quoted message id.
     * @returns true when something was found and scrolled to.
     */
    /** The flash line currently on screen, so a second jump replaces it. */
    let flashLine = null;

    /**
     * Draw a spindle line under a row for a moment.
     *
     * A full outline around the row was wrong: it framed whichever block the
     * quote button happens to live in (often a file-change card). A thin line
     * marks the position without claiming a boundary, and it is drawn as a
     * fixed-position overlay so no host node is touched.
     *
     * @param row - the row to underline.
     */
    function flashRow(row) {
      if (flashLine !== null) {
        flashLine.remove();
        flashLine = null;
      }

      const paint = () => {
        const rect = row.getBoundingClientRect();
        postLog('flash-paint', {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewport: window.innerHeight
        });
        if (rect.width === 0 || rect.height === 0) return;

        // Keep the line inside the viewport: a tall row centred by scrollIntoView
        // can have its bottom below the fold, and a line drawn there is invisible.
        const maxY = window.innerHeight - 14;
        const y = Math.max(12, Math.min(rect.bottom, maxY));
        const line = document.createElement('div');
        line.style.cssText = [
          'position:fixed',
          'pointer-events:none',
          'z-index:2147483000',
          `left:${rect.left + rect.width * 0.06}px`,
          `width:${rect.width * 0.88}px`,
          // Lifted off the row's bottom edge: sitting flush against it made the
          // line read as the divider of the NEXT message.
          `top:${y - 23}px`,
          'height:3px',
          'border-radius:2px',
          'background:linear-gradient(90deg,transparent 0%,#4d6bfe 18%,#4d6bfe 82%,transparent 100%)',
          'box-shadow:0 0 8px rgba(77,107,254,0.45)',
          'opacity:0',
          'transition:opacity 220ms ease'
        ].join(';');
        document.body.appendChild(line);
        flashLine = line;
        requestAnimationFrame(() => {
          line.style.opacity = '1';
        });
        setTimeout(() => {
          line.style.opacity = '0';
        }, 1600);
        setTimeout(() => {
          line.remove();
          if (flashLine === line) flashLine = null;
        }, 2000);
      };

      // Wait until the row is actually INSIDE the viewport before measuring.
      // Position stability alone is not enough: a scroll that has not started
      // yet is perfectly stable, and measuring then draws the line off-screen.
      let frames = 0;
      const settle = () => {
        frames += 1;
        const rect = row.getBoundingClientRect();
        const inView = rect.bottom > 8 && rect.top < window.innerHeight - 8;
        if (inView && frames >= 2) {
          paint();
          return;
        }
        if (frames > 60) {
          paint();
          return;
        }
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    }

    function jumpToMessage(messageId) {
      const record = anchorFor(messageId);
      if (record === null) {
        postLog('jump-miss', { messageId, reason: 'no-anchor' });
        return false;
      }

      // Back to the behaviour that demonstrably worked: find the recorded row
      // verbatim. The turn-prefix widening is gone until the row it lands on is
      // understood; a broken jump is worse than an imprecise one.
      let row = null;
      try {
        row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(record.key)}"]`);
      } catch (error) {
        postLog('jump-miss', { messageId, reason: 'selector-error', detail: String((error && error.message) || error) });
        return false;
      }
      if (row === null) {
        postLog('jump-miss', { messageId, reason: 'row-gone', key: record.key });
        return false;
      }

      // `behavior: 'auto'` on purpose. Smooth scrolling a jump of tens of
      // thousands of pixels takes longer than the measuring window, and the line
      // was then painted at a stale position (measured top: -19816).
      row.scrollIntoView({ behavior: 'auto', block: 'center' });
      flashRow(row);
      postLog('jump-ok', { messageId, key: record.key });
      return true;
    }

    function readQuoteText(anchor) {
      try {
        const selection = window.getSelection();
        if (selection !== null && selection.isCollapsed === false) {
          const picked = String(selection).trim();
          if (picked.length > 0) return picked;
        }
      } catch {
        /* a denied selection read falls through to the DOM path */
      }

      // Walk all the way out and keep the OUTERMOST usable sibling.
      //
      // Measured on the real DOM: the action row sits inside
      // `div.actions > div.root > div > div`, and the message body is the
      // previous sibling of the outer `flowItem` (depth 7). But a message can
      // contain small blocks of its own — a file-path chip, an inline code
      // fragment — which sit at shallower depths and are already "long enough".
      // Returning the first hit grabbed exactly those (measured: an 87-character
      // path instead of the 897-character message). So keep walking and let the
      // outer one win.
      let node = anchor;
      let candidate = '';
      for (let depth = 0; depth < 12 && node !== null && node !== undefined; depth += 1) {
        const previous = node.previousElementSibling;
        if (previous !== null && previous !== undefined) {
          const text = textOf(previous);
          // A body is substantially longer than a label or an icon row.
          if (text.length >= 12) candidate = text;
        }
        node = node.parentElement;
      }
      return candidate;
    }

    /**
     * Text content of one element with all interactive chrome removed.
     *
     * @param element - the element to read.
     * @returns trimmed text with buttons and icons stripped.
     */
    function textOf(element) {
      try {
        const clone = element.cloneNode(true);
        for (const el of clone.querySelectorAll('button,[role="button"],svg,[data-quote-shot="action"]')) el.remove();
        // `||`, NOT `??`. innerText returns "" (not null) when the element is
        // not rendered — which is exactly what happens once the host virtualises
        // or collapses message bodies: the node is in the DOM but invisible.
        // `??` never falls through on "", so every quote came back empty.
        const rendered = clone.innerText;
        const fallback = rendered === undefined || rendered === null || rendered.length === 0
          ? String(clone.textContent ?? '')
          : String(rendered);
        return fallback
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      } catch {
        return '';
      }
    }

    /**
     * Describe the DOM around a clicked button, for diagnostics.
     *
     * Message markup is not a published contract, so when text extraction fails
     * there is nothing to reason about without seeing the actual ancestor chain.
     * This records tags, class names, text lengths and previous siblings — just
     * enough to work the extraction strategy out from a log line.
     *
     * @param anchor - the clicked button.
     * @returns the ancestor chain, outermost last.
     */
    function describeDom(anchor) {
      const chain = [];
      let node = anchor;
      for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
        let previous = null;
        try {
          previous = node.previousElementSibling;
        } catch {
          previous = null;
        }
        const text = String(node.innerText ?? node.textContent ?? '');
        const previousText = previous === null ? '' : String(previous.innerText ?? previous.textContent ?? '');
        chain.push({
          tag: String(node.tagName ?? '?').toLowerCase(),
          cls: String(node.className ?? '').slice(0, 60),
          textLen: text.length,
          prevTag: previous === null ? null : String(previous.tagName ?? '?').toLowerCase(),
          prevCls: previous === null ? null : String(previous.className ?? '').slice(0, 60),
          prevTextLen: previousText.length,
          siblings: node.parentElement === null || node.parentElement === undefined ? 0 : node.parentElement.children.length
        });
        node = node.parentElement;
      }
      return chain;
    }

    /**
     * Collapse text to the single preview line shown on the card.
     *
     * @param text - raw quoted text.
     * @returns a one-line excerpt.
     */
    function previewOf(text) {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > CARD_PREVIEW_CHARS ? `${flat.slice(0, CARD_PREVIEW_CHARS)}…` : flat;
    }

    /**
     * Send the quote to the Host for context injection.
     *
     * @param sessionId - owning session.
     * @param text - the quoted text.
     * @returns the Host outcome; never throws.
     */
    async function injectQuote(sessionId, text) {
      try {
        const response = await fetch(INJECT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, text: text.slice(0, MAX_QUOTE_CHARS) }),
          signal: AbortSignal.timeout(15000)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok !== true) {
          return { ok: false, code: String(payload?.code ?? response.status) };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, code: String((error && error.message) || error) };
      }
    }

    /** The quote mark used instead of a text label. */
    function QuoteIcon(props) {
      const size = props?.size ?? 14;
      return h(
        'svg',
        { width: String(size), height: String(size), viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.34 5.6c0-1.46.97-2.55 2.4-2.85v1.5c-.72.18-1.13.68-1.13 1.26h1.13v3.4H3.34V5.6Zm5.6 0c0-1.46.97-2.55 2.4-2.85v1.5c-.72.18-1.13.68-1.13 1.26h1.13v3.4H8.94V5.6Z',
          fill: 'currentColor'
        })
      );
    }

    /** Hover delay before the tooltip appears. */
    const TOOLTIP_DELAY_MS = 450;

    /**
     * A tooltip that follows the host's look.
     *
     * The built-in Tooltip component is not reachable from a third-party
     * bundle (its package is not exposed to plugins), so this reimplements the
     * observable behaviour: a short hover delay, a dark rounded pill, and fixed
     * positioning so a scrolling container cannot clip it.
     *
     * @param props - `label` (text) and `children` (the anchor).
     * @returns the anchor plus an optional fixed-position bubble.
     */
    function Tooltip(props) {
      const label = props.label;
      const [open, setOpen] = react.useState(false);
      const [position, setPosition] = react.useState(null);
      const timer = react.useRef(null);
      const anchor = react.useRef(null);

      const clear = () => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      };

      const onEnter = () => {
        clear();
        timer.current = setTimeout(() => {
          const rect = anchor.current?.getBoundingClientRect?.();
          if (rect === undefined || rect === null) return;
          setPosition({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
          setOpen(true);
        }, TOOLTIP_DELAY_MS);
      };

      const onLeave = () => {
        clear();
        setOpen(false);
      };

      // A component unmounted mid-hover must not leave a timer behind.
      react.useEffect(() => clear, []);

      return h(
        'span',
        {
          ref: anchor,
          onMouseEnter: onEnter,
          onMouseLeave: onLeave,
          onFocus: onEnter,
          onBlur: onLeave,
          style: { display: 'inline-flex' }
        },
        props.children,
        open && position !== null
          ? h(
              'span',
              {
                role: 'tooltip',
                style: {
                  position: 'fixed',
                  top: `${position.top}px`,
                  left: `${position.left}px`,
                  transform: 'translateX(-50%)',
                  background: 'var(--dsw-alias-bg-tooltip, rgba(28,28,30,0.92))',
                  color: '#ffffff',
                  fontSize: 'var(--dsw-font-xxs-12, 12px)',
                  lineHeight: '18px',
                  padding: '4px 8px',
                  borderRadius: 'var(--dsw-radius-sm, 6px)',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 2147483000
                }
              },
              label
            )
          : null
      );
    }

    /**
     * The quote button in every assistant message's action row.
     *
     * @param props - slot props; `sessionId` identifies the conversation.
     * @returns the button element.
     */
    function QuoteActions(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const sessionId = props.sessionId;
      const [busy, setBusy] = react.useState(false);
      const [hover, setHover] = react.useState(false);
      const [flash, setFlash] = react.useState(null);

      /**
       * Report a client-side failure to the Host log.
       *
       * Silent `return`s were the whole reason "clicking quote does nothing" was
       * undiagnosable: the button just stopped. Every early exit reports now.
       *
       * @param stage - which step failed.
       * @param detail - extra context.
       */
      const report = (stage, detail) => {
        setFlash('✕');
        setTimeout(() => setFlash(null), 1500);
        postLog(stage, { ...(detail ?? {}), sessionId: sessionId ?? null });
      };

      const onClick = async (event) => {
        if (busy) return;

        // Quote-by-reference: nothing is injected at click time.
        //
        // The message text is still read from the DOM, but ONLY to fill the
        // card preview — the session receives just a one-line marker. That is
        // what makes the quote withdrawable: nothing has been written yet.
        const messageId = props.messageId;
        if (typeof messageId !== 'string' || messageId.length === 0) {
          report('no-message-id', {});
          return;
        }

        const text = readQuoteText(event.currentTarget);
        // Record which row this message occupies: the message DOM carries no
        // message id, and the sent card needs a way back. Done here because the
        // button sits inside that row.
        rememberAnchor(messageId, event.currentTarget.closest('[data-chat-anchor-key]'));
        if (text.length === 0) {
          // Ship the DOM shape along with the failure: message markup is not a
          // contract, so the extraction strategy cannot be fixed from a bare
          // "nothing found".
          report('no-text', { hasSelection: false, dom: describeDom(event.currentTarget) });
          return;
        }
        if (sessionId === undefined) {
          report('no-session-id', { textLen: text.length });
          return;
        }

        const actions = props.inputActions;
        if (actions === undefined || actions === null) {
          report('no-input-actions', {});
          return;
        }

        // Explicit instruction, not a bare marker.
        //
        // A bare `[引用消息 <id>]` failed in real use: the model decided it did
        // not need the content and answered from memory (measured 0 calls across
        // 3 quotes). Quoting means "look at this", so the marker now says so.
        const marker = buildMarker(messageId);
        setBusy(true);
        let inserted = false;
        let usedChip = false;
        try {
          inserted = insertQuoteChip(messageId, sessionId, text);
          usedChip = inserted;
        } catch (error) {
          postLog('chip-insert-failed', { messageId, detail: String((error && error.message) || error) });
          inserted = false;
        }
        if (!inserted) {
          // Fallback: plain text. The chip is nicer presentation, not a
          // requirement — quoting must keep working even if the draft API
          // behaves differently on another DSH build.
          try {
            inserted = actions.insertText(`${marker}\n`, actions.captureInsertion());
          } catch {
            inserted = false;
          }
        }
        setBusy(false);
        if (inserted !== true) {
          report('insert-failed', { messageId });
          return;
        }

        // Only the plain-text fallback needs reordering; a chip is written at
        // offset 0 directly, and shifting text afterwards would corrupt it.
        if (!usedChip) {
          try {
            const actx = pluginCtx?.sessions?.scope?.(sessionId);
            const input = actx === undefined || actx === null ? undefined : pluginCtx?.conversation?.input?.for?.(actx);
            const snapshot = input?.draftSnapshot;
            const noChips = Array.isArray(snapshot?.references) && snapshot.references.length === 0;
            if (noChips && typeof snapshot.text === 'string') {
              const index = snapshot.text.lastIndexOf(marker);
              const before = index > 0 ? snapshot.text.slice(0, index).replace(/\s+$/, '') : '';
              if (index > 0 && before.length > 0) {
                const after = snapshot.text.slice(index + marker.length);
                input.setDraft({ text: `${marker}\n${before}${after}`, references: [] });
              }
            }
          } catch {
            report('reorder-skipped', { messageId });
          }
        }

        // Record the id -> session pair before the marker leaves the client, so
        // `quote_read` can resolve the owner instead of guessing a live agent.
        postHint(messageId, sessionId);

        replaceQuote(sessionId, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          preview: previewOf(text),
          messageId,
          marker
        });
      };

      // A failed quote must be visible: the button used to just do nothing.
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } },
        h(
          Tooltip,
          { label: t('title') },
        h(
          'button',
          {
            type: 'button',
            onClick,
            'aria-label': t('title'),
            'data-quote-shot': 'action',
            style: {
              // Mirrors the host's own icon buttons: bare until hovered, then a
              // faint wash at full opacity — no border, no shadow, no scaling.
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '28px',
              height: '28px',
              border: 'none',
              // Native tokens, not hand-mixed rgba: the host's own icon buttons use
              // `--dsw-alias-interactive-bg-hover` for the wash and `--dsw-radius-sm`
              // for the corner. Anything else reads as a foreign component.
              background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))' : 'transparent',
              color: 'inherit',
              opacity: hover ? 1 : 0.55,
              cursor: busy ? 'progress' : 'pointer',
              borderRadius: 'var(--dsw-radius-sm, 6px)',
              padding: 0,
              lineHeight: 1,
              transition: 'background 120ms ease, opacity 120ms ease'
            },
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false)
          },
          h(QuoteIcon, { size: 15 })
        )
        ),
        flash === null
          ? null
          : h(
              'span',
              { style: { fontSize: '11px', lineHeight: 1, color: 'var(--dsw-alias-label-danger, #e5484d)' } },
              flash
            )
      );
    }
    /**
     * Quote cards shown above the composer.
     *
     * @param props - slot props.
     * @returns the card stack, or null when nothing is quoted.
     */
    function QuoteCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const sessionId = props.sessionId;
      const [quotes, setLocal] = react.useState(() => (sessionId === undefined ? [] : listQuotes(sessionId)));

      react.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const sync = () => setLocal([...listQuotes(sessionId)]);
        sync();
        return subscribe(sync);
      }, [sessionId]);

      // Clear the cards once a send completes.
      //
      // Without this the card lingered after the message went out, which reads
      // as "the quote is still pending" — it is not: the context was injected at
      // click time. Watching the composer phase for send → idle is the only
      // send-completion signal a client plugin gets.
      //
      // 0.2.1 published no `phase` at all; 0.2.2 exposes it as 'plain' / 'sending'
      // (measured 2026-11-08). Both spellings are accepted so the plugin works
      // across versions.
      const SENDING = new Set(['sending', 'submitting']);
      const hasInputHook = typeof props.useInput === 'function';
      const phase = hasInputHook ? props.useInput((state) => state.phase) : undefined;
      const previousPhase = react.useRef(phase);
      react.useEffect(() => {
        const before = previousPhase.current;
        previousPhase.current = phase;
        if (sessionId === undefined) return;
        if (before !== phase) postLog('phase', { hasHook: hasInputHook, before: before ?? null, after: phase ?? null });
        if (SENDING.has(before) && !SENDING.has(phase)) {
          quoteState.delete(sessionId);
          emit();
        }
      }, [phase, sessionId, hasInputHook]);

      // Send-completion fallback that does not depend on any published state.
      //
      // `useInput`'s published state has no `phase` field (it lives on the
      // composer's internal snapshot), so the hook route above never fires.
      // Watch the composer element instead: text present → empty means the send
      // went through, which is exactly the moment the card should go away.
      const previousDraftLength = react.useRef(0);
      react.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const timer = setInterval(() => {
          const editor = document.querySelector('[contenteditable="true"]');
          if (editor === null) return;
          const length = String(editor.innerText ?? '').trim().length;
          if (previousDraftLength.current > 0 && length === 0) {
            quoteState.delete(sessionId);
            emit();
          }
          previousDraftLength.current = length;
        }, 400);
        return () => clearInterval(timer);
      }, [sessionId]);

      if (quotes.length === 0) return null;

      const cards = [];
      for (const quote of quotes) {
        cards.push(
          h(
            'div',
            {
              key: quote.id,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                // Tighten the box: the native type scale bottoms out at 12px
                // (`--dsw-font-xxs-12`), so the "looks too big" impression came
                // from 1.5 line-height plus 4px vertical padding, not the font.
                padding: '2px 6px',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.09))',
                fontSize: 'var(--dsw-font-xxs-12, 12px)',
                lineHeight: '1.3',
                maxWidth: '100%',
                boxSizing: 'border-box'
              }
            },
            h('span', { style: { flex: '0 0 auto', display: 'inline-flex', opacity: 0.6 } }, h(QuoteIcon, { size: 12 })),
            h(
              'span',
              {
                style: {
                  flex: '1 1 auto',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  opacity: 0.85
                },
                title: quote.preview
              },
              quote.preview
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': t('remove'),
                onClick: () => {
                  // Withdraw for real: strip the marker back out of the draft.
                  //
                  // `inputActions` exposes setDraft but not a draft getter, so
                  // the current text is read from the composer element. Only
                  // that one marker line is removed — anything the user typed
                  // is preserved.
                  const actions = props.inputActions;
                  if (actions !== undefined && actions !== null && typeof quote.marker === 'string' && quote.marker.length > 0) {
                    try {
                      const editor = document.querySelector('[contenteditable="true"]');
                      const current = String(editor?.innerText ?? '');
                      if (current.includes(quote.marker)) {
                        actions.setDraft(current.replace(quote.marker, '').replace(/\n{2,}/g, '\n').trimStart());
                      }
                    } catch {
                      /* withdrawal is best-effort; the card still disappears */
                    }
                  }
                  if (sessionId !== undefined) removeQuote(sessionId, quote.id);
                },
                style: {
                  flex: '0 0 auto',
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  opacity: 0.45,
                  cursor: 'pointer',
                  padding: 0,
                  width: '18px',
                  height: '18px',
                  lineHeight: 1,
                  borderRadius: '4px',
                  fontSize: '13px'
                }
              },
              '\u00d7'
            )
          )
        );
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            margin: '0 auto 6px',
            width: '100%',
            // The dock spans the whole conversation column; the composer is
            // narrower. This is the host's own token for that width, so the card
            // lines up with the input box instead of the message list.
            maxWidth: 'var(--dsh-chat-content-width, 100%)',
            boxSizing: 'border-box'
          }
        },
        ...cards
      );
    }

    /**
     * The one-line marker this plugin puts in the composer.
     *
     * Group 1 is the message id. Kept in sync with the string built in
     * QuoteActions; the quote em-dash is part of the contract.
     */
    const QUOTE_MARK = /\[引用消息\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*——[^\]]*\]/g;

    /** Rule id for sent bubbles; must not collide with DSH's own user-text rules. */
    const CARD_NODE = 'dsh-quote-shot-card';

    /**
     * userText rule: find one quote marker at or after `from`.
     *
     * DSH runs these rules over the text of a SENT user message and lets the
     * plugin replace the matched span with a React node, which is how a plain
     * `[引用消息 …]` turns into a card in the bubble.
     */
    const quoteRule = {
      id: CARD_NODE,
      order: 15,
      match(text, from) {
        QUOTE_MARK.lastIndex = from;
        const m = QUOTE_MARK.exec(text);
        if (m === null) return undefined;
        return {
          id: CARD_NODE,
          start: m.index,
          end: m.index + m[0].length,
          data: { messageId: m[1] }
        };
      }
    };

    /**
     * The card a sent quote renders as.
     *
     * It shows nothing about the quoted text until opened: the marker carries
     * only an id, and prefetching the body for every card would fire a request
     * per quote on every render. Opening asks the Host for the text once and
     * caches it on the component.
     *
     * @param props - `node` from the rule (`data.messageId`, `data.text`/`note`).
     * @returns the card element.
     */
    function SentQuoteCard(props) {
      const node = props.node ?? {};
      const messageId = String(node?.data?.messageId ?? '');
      const [open, setOpen] = react.useState(false);
      const [body, setBody] = react.useState(null);
      const [state, setState] = react.useState('idle');
      const [notice, setNotice] = react.useState(null);

      const toggle = async () => {
        if (open) {
          setOpen(false);
          return;
        }
        setOpen(true);
        if (body !== null || state === 'loading') return;
        setState('loading');
        try {
          const response = await fetch('/quote-shot/message', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId })
          });
          const payload = await response.json();
          if (payload.ok === true) {
            setBody(String(payload.text ?? ''));
            setState('done');
          } else {
            setBody('（找不到这条消息的正文）');
            setState('missing');
          }
        } catch {
          setBody('（读取失败）');
          setState('error');
        }
      };

      const shortId = messageId.slice(0, 8);

      const jump = () => {
        if (jumpToMessage(messageId)) return;
        // The row is gone: the virtualised list dropped it, or the page reloaded
        // before any anchor was recorded for this id.
        setNotice('原消息不在当前视图');
        setTimeout(() => setNotice(null), 2200);
      };

      const header = h(
        'span',
        {
          role: 'button',
          tabIndex: 0,
          onClick: jump,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              jump();
            }
          },
          title: '点击回到原消息',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 8px',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            cursor: 'pointer',
            fontSize: '12px',
            lineHeight: '16px',
            color: 'color-mix(in srgb, currentColor 58%, transparent)'
          }
        },
        h('span', { 'aria-hidden': 'true' }, '\u275D'),
        h('span', null, `引用 ${shortId}`),
        notice !== null ? h('span', { style: { opacity: 0.85 } }, notice) : null,
        h(
          'span',
          {
            role: 'button',
            tabIndex: 0,
            onClick: (event) => {
              event.stopPropagation();
              toggle();
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                toggle();
              }
            },
            style: { marginLeft: 'auto', opacity: 0.7, cursor: 'pointer' }
          },
          open ? '收起' : state === 'loading' ? '读取中…' : '展开'
        )
      );

      const children = [header];

      if (open) {
        children.push(
          h(
            'span',
            {
              key: 'body',
              style: {
                display: 'block',
                marginTop: '6px',
                padding: '0 8px 4px',
                maxHeight: '220px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: '13px',
                lineHeight: '1.55',
                color: 'color-mix(in srgb, currentColor 80%, transparent)'
              }
            },
            state === 'loading' ? '…' : body ?? ''
          )
        );
      }

      return h(
        'span',
        {
          style: {
            display: 'block',
            margin: '2px 0 6px',
            borderLeft: '2px solid color-mix(in srgb, currentColor 35%, transparent)',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: 'color-mix(in srgb, currentColor 6%, transparent)',
            userSelect: 'text'
          }
        },
        ...children
      );
    }

    /**
     * Register the dictionaries, the message action and the composer cards.
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      pluginCtx = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'quote-shot: dictionaries');

      // The composer chip. It never offers completion candidates — it exists so
      // the draft can carry a reference this plugin owns, which DSH draws as a
      // compact tag instead of the raw instruction line.
      ctx.effect(
        () =>
          ctx.inputTriggers.registerSource({
            trigger: '@',
            name: CHIP_SOURCE,
            order: 99,
            showGroupTitle: false,
            candidates: () => Promise.resolve([]),
            onPick: () => undefined,
            openReference: () => undefined,
            codec: {
              clipboardText: (ref) => buildMarker(String(ref)),
              serialize: (ref) => Promise.resolve(buildMarker(String(ref)))
            }
          }),
        'quote-shot: chip source'
      );

      // Sent bubble: the marker becomes a card instead of a run of grey text.
      ctx.effect(() => ctx.uiConversation.userText.register(quoteRule), 'quote-shot: user-text rule');
      ctx.slots.inject('conversation.user.text.node', () =>
        ctx.slots.register(
          { name: 'conversation.user.text.node', key: CARD_NODE, priority: 100 },
          SentQuoteCard
        )
      );

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'quote',
            // After the feedback buttons (order 10).
            order: 20,
            locale: NS,
            inject: (sessionId) => ({ sessionId })
          },
          QuoteActions
        )
      );

      // `dock` is the flow area above the composer; `overlay` draws on top of
      // the input and would hide where the user is typing.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'quote-card',
            order: 50,
            locale: NS,
            inject: (sessionId) => ({ sessionId })
          },
          QuoteCard
        )
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'uiConversation', 'conversation', 'sessions', 'inputTriggers'];
    exports.QuoteActions = QuoteActions;
    exports.QuoteCard = QuoteCard;
    exports.SentQuoteCard = SentQuoteCard;
    exports.readQuoteText = readQuoteText;
    exports.previewOf = previewOf;
    exports.injectQuote = injectQuote;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
