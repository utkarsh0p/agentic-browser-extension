// SiteWhisper page agent.
//
// Builds the numbered snapshot the LLM uses to address elements. The snapshot is a
// distilled accessibility tree, NOT markup: ~400 characters of button HTML collapses to
// one line like `[15] button "Sign in"`. That is what makes it both generic (every site
// has an a11y tree) and cheap (~500-2k tokens versus 50k+ for raw HTML).
//
// Element references never leave the page. Only `[15] button "Sign in"` travels to the
// backend, and only `click(15)` comes back — resolved here against `state.elements`.

(() => {
  'use strict';

  // Injected on demand only, via executeScript — the manifest declares no content script,
  // so nothing runs on a page until the user actually asks something of it. That makes a
  // second injection into the same page ordinary rather than exceptional: the panel
  // re-injects whenever a send finds no receiver. Re-running would reset live element
  // refs, and the handles in the map the model is holding would stop resolving, so bail.
  if (window.__siteWhisper) return;

  const MAX_ELEMENTS   = 200;   // beyond this the snapshot costs more than it's worth
  const MAX_NAME_CHARS = 120;
  const MAX_VALUE_CHARS = 80;
  const MAX_OPTIONS    = 20;

  const state = {
    // [{ id, el, role, name }] in document order. The number in the snapshot is a HANDLE,
    // not a position: it is assigned to an element the first time that element is listed
    // and stays with it for as long as it is on the page.
    //
    // This used to be the array index, which meant one row arriving at the top renumbered
    // everything below it — so a handle the model was still holding silently pointed at a
    // different element. That single property is what forced the batch-wide staleness
    // vetoes, blinded the repeated-call guard (the same target had different args every
    // time), and made map diffing impossible.
    elements: [],
    handles: new WeakMap(),   // element → its handle, assigned once
    byId: new Map(),          // handle → WeakRef(element), for resolve()
    nextId: 1,
    generation: 0,  // bumped every snapshot; reported to the model as context, not a veto
    url: '',        // location at snapshot time
    scoped: false,  // true when the map covers only an open dialog, not the page
    // Last serialized map. Compared, not assumed: a "nothing changed" decision taken from
    // the verb would be wrong, because type fires input events that open autocomplete
    // lists and hover opens menus — both change the map.
    lastMap: '',
  };
  window.__siteWhisper = state;

  // ── What counts as interactive ───────────────────────────────────────────────
  // `[role]` alone is far too broad (role="presentation", role="main"…), so explicit
  // roles are whitelisted while native interactive tags are taken as-is.
  const NATIVE_SEL =
    'a[href], button, input, select, textarea, summary, ' +
    '[contenteditable=""], [contenteditable="true"]';

  // Containers are deliberately absent (listbox, radiogroup, menu, tablist): the options
  // inside them are the actionable things, and listing the wrapper adds a line whose name
  // is every child's text concatenated. Native <select multiple> still qualifies through
  // NATIVE_SEL rather than this whitelist.
  const ACTIONABLE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
  ]);

  // Roles that describe a wrapper around other controls. Listing one of these would
  // duplicate its children and hand the model a line whose name is every child's text
  // joined together.
  const CONTAINER_ROLES = new Set([
    'grid', 'table', 'rowgroup', 'columnheader', 'rowheader',
    'list', 'listbox', 'menu', 'menubar', 'tablist', 'toolbar', 'tree', 'treegrid',
    'navigation', 'main', 'region', 'banner', 'contentinfo', 'complementary',
    'form', 'search', 'group', 'radiogroup', 'presentation', 'none', 'generic',
    'document', 'application', 'article', 'dialog', 'alertdialog',
  ]);

  function isInteractive(el) {
    const role = (el.getAttribute('role') || '').trim().toLowerCase();
    if (role && ACTIONABLE_ROLES.has(role)) return true;
    if (el.matches(NATIVE_SEL)) return true;
    // A role outside the whitelist used to return false right here, which quietly made a
    // whole class of control unreachable: an app that builds its rows as role="row" — a
    // mail list, a table of records — has clickable, focusable, named rows that never
    // appeared in the map at all. The agent could see their checkboxes (all sharing one
    // accessible name) but never the rows themselves, so "the first mail" had nothing to
    // point at. Containers still stay out; everything else falls through to the same
    // clickable-and-named test as an unroled div.
    if (role && CONTAINER_ROLES.has(role)) return false;
    // Click handlers and focusable elements are only worth a line if they're named —
    // otherwise they are layout noise that would crowd out the real controls.
    if (el.hasAttribute('onclick') || el.tabIndex >= 0) return !!accessibleName(el);
    return false;
  }

  // ── Visibility ──────────────────────────────────────────────────────────────
  // Deliberately NOT a viewport test: an element below the fold is still actionable,
  // that's what the scroll verb is for. This only excludes what a user could never see.
  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
    const r = el.getBoundingClientRect();
    // Zero-size is usually a visually-hidden input; keep it if it's a real form control
    // with a name, since sites hide native checkboxes behind styled labels constantly.
    if (r.width === 0 && r.height === 0) {
      return /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !!accessibleName(el);
    }
    return true;
  }

  // ── Accessible name ─────────────────────────────────────────────────────────
  // Same precedence the a11y tree uses, so the label the model sees is the label a
  // human sees. Falls through to trimmed text last.
  function accessibleName(el) {
    const attr = (n) => (el.getAttribute(n) || '').trim();

    const ariaLabel = attr('aria-label');
    if (ariaLabel) return clip(ariaLabel, MAX_NAME_CHARS);

    const labelledBy = attr('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const txt = labelledBy.split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : null))
        .filter(Boolean)
        .map((n) => (n.textContent || '').trim())
        .join(' ')
        .trim();
      if (txt) return clip(txt, MAX_NAME_CHARS);
    }

    // el.labels only exists on form controls, and covers both wrapping and for= labels.
    if (el.labels && el.labels.length) {
      const txt = Array.from(el.labels).map((l) => (l.textContent || '').trim())
        .join(' ').trim();
      if (txt) return clip(txt, MAX_NAME_CHARS);
    }

    for (const a of ['placeholder', 'alt', 'title', 'name']) {
      const v = attr(a);
      if (v) return clip(v, MAX_NAME_CHARS);
    }

    // A button wrapping only an icon has no text; its image's alt is the real name.
    const img = el.querySelector?.('img[alt]:not([alt=""])');
    if (img) return clip(img.getAttribute('alt').trim(), MAX_NAME_CHARS);

    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return clip(text, MAX_NAME_CHARS);

    return (el.value && String(el.value).trim()) ? clip(String(el.value).trim(), MAX_NAME_CHARS) : '';
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ── Role, normalised to something the model can reason about ────────────────
  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit;

    switch (el.tagName) {
      case 'A':        return 'link';
      case 'BUTTON':   return 'button';
      case 'SELECT':   return el.multiple ? 'listbox' : 'select';
      case 'TEXTAREA': return 'textarea';
      case 'SUMMARY':  return 'button';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox')  return 'checkbox';
        if (t === 'radio')     return 'radio';
        if (t === 'range')     return 'slider';
        if (t === 'file')      return 'file';
        if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
        return t === 'text' ? 'input' : t;   // email, password, search, number, date…
      }
      default:
        if (el.isContentEditable) return 'textbox';
        // A div with a click handler behaves like a button but calling it one would be a
        // lie the model might rely on; "clickable" is honest and still actionable.
        return (el.hasAttribute('onclick') || el.tabIndex >= 0) ? 'clickable' : 'element';
    }
  }

  // ── State flags: identity alone causes toggle bugs ──────────────────────────
  // Without [checked], "accept the terms" unchecks a pre-checked box. Without
  // [pressed], "like this video" un-likes it. State is not decoration.
  function stateFlags(el, role) {
    const flags = [];
    if (el.disabled) flags.push('disabled');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const aria = el.getAttribute('aria-checked');
      const on = aria !== null ? aria === 'true' : !!el.checked;
      flags.push(on ? 'checked' : 'unchecked');
    }
    if (el.getAttribute('aria-pressed') === 'true')  flags.push('pressed');
    if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) flags.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.required) flags.push('required');
    if (el.getAttribute('aria-invalid') === 'true') flags.push('invalid');
    return flags;
  }

  // ── Current value ───────────────────────────────────────────────────────────
  // Only controls that actually hold a value get one. <button>, <a> and <option> all
  // expose a .value property, so testing for it blindly stamps a meaningless `= ""` on
  // every button on the page — pure token waste, and it reads as a fillable field.
  const VALUELESS_INPUT_TYPES = new Set([
    'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file',
  ]);

  function holdsValue(el) {
    if (el.isContentEditable) return true;
    switch (el.tagName) {
      case 'TEXTAREA':
      case 'SELECT':
        return true;
      case 'INPUT':
        return !VALUELESS_INPUT_TYPES.has((el.type || 'text').toLowerCase());
      default:
        return false;
    }
  }

  function valueOf(el, role) {
    if (!holdsValue(el)) return null;
    if (role === 'password') {
      // Never send the user's password to the backend. The length is all the model needs
      // in order to know whether the field still wants filling.
      return el.value ? `(${el.value.length} chars hidden)` : '';
    }
    if (el.isContentEditable) {
      return clip((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), MAX_VALUE_CHARS);
    }
    return clip(String(el.value ?? '').replace(/\s+/g, ' '), MAX_VALUE_CHARS);
  }

  // ── Traversal, crossing open shadow roots ───────────────────────────────────
  // Closed shadow roots are unreachable by design; open ones are where most design
  // systems put their real controls, so skipping them would miss whole apps.
  function collect(root, out) {
    let nodes;
    try { nodes = root.querySelectorAll('*'); } catch { return; }
    for (const el of nodes) {
      if (out.length >= MAX_ELEMENTS) return;
      if (el.shadowRoot) collect(el.shadowRoot, out);
      try {
        if (isInteractive(el) && isVisible(el)) out.push(el);
      } catch { /* an exotic custom element threw; skip it rather than fail the snapshot */ }
    }
  }

  // ── The active modal, if there is one ───────────────────────────────────────
  // When a dialog is open it is the ONLY thing the user can touch: focus is trapped and
  // everything behind it is unclickable. Snapshotting the whole document then is both
  // wrong and expensive — on a feed page the background fills MAX_ELEMENTS and pushes the
  // dialog, which is usually a portal at the end of <body>, out of the map entirely. That
  // is exactly how "I clicked Start a post but there is no text field" happens.
  //
  // Ordered most to least trustworthy. :modal covers showModal(), whose inertness is
  // spec-level and carries no attribute for [inert] to match.
  const MODAL_SEL = [
    'dialog[open]',
    '[role="dialog"][aria-modal="true"]',
    '[role="alertdialog"][aria-modal="true"]',
    '[aria-modal="true"]',
  ];

  function activeModal() {
    try {
      const native = document.querySelectorAll('dialog[open]');
      for (let i = native.length - 1; i >= 0; i--) {
        // :modal is the real test — a non-modal <dialog open> does not trap anything.
        try { if (native[i].matches(':modal')) return native[i]; } catch { /* older engine */ }
      }
    } catch { /* no matter, the selectors below still apply */ }

    for (const sel of MODAL_SEL) {
      let found;
      try { found = document.querySelectorAll(sel); } catch { continue; }
      // Last match wins: stacked dialogs put the topmost one last in the DOM.
      for (let i = found.length - 1; i >= 0; i--) {
        if (isVisible(found[i])) return found[i];
      }
    }

    // Nothing declared itself. Fall back to the overlay that currently holds focus, which
    // catches the many dialogs built from a plain positioned div with a focus trap.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      for (let el = active; el && el !== document.body; el = el.parentElement) {
        let pos;
        try { pos = getComputedStyle(el).position; } catch { break; }
        if (pos !== 'fixed' && pos !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        // Big enough to be a panel rather than a tooltip or a sticky header.
        if (r.width >= 240 && r.height >= 160) return el;
      }
    }
    return null;
  }

  // The map's delimiters are " = " before a value and "[...]" around flags, so a name or
  // value containing either would make a line ambiguous to parse. Names are accessible
  // text, so this practically never fires — but a page that does it must not be able to
  // corrupt the approval prompt's idea of which element it is describing.
  function clean(s) {
    return String(s).replace(/[[\]]/g, '').replace(/\s=\s/g, ' ').trim();
  }

  function describe(entry) {
    const { el, id, role, name } = entry;
    const flags = stateFlags(el, role);
    const value = valueOf(el, role);

    let line = `${id} ${role}`;
    if (name) line += ` ${clean(name)}`;
    if (value !== null && value !== undefined) line += ` = ${clean(value)}`;
    if (flags.length) line += ` [${flags.join(' ')}]`;

    // Without the options listed, the model has to guess what to pass to select().
    if (el.tagName === 'SELECT' && el.options?.length) {
      const opts = Array.from(el.options).slice(0, MAX_OPTIONS)
        .map((o) => (o.textContent || '').trim()).filter(Boolean);
      if (opts.length) {
        line += ` options: ${opts.join(' | ')}`;
        if (el.options.length > MAX_OPTIONS) line += ` | …+${el.options.length - MAX_OPTIONS} more`;
      }
    }
    return line;
  }

  // The collection half of buildSnapshot, with none of its bookkeeping. Split out so the
  // stability probe below counts exactly what a snapshot would list and cannot drift from
  // it — a probe that measured something else would settle on the wrong signal.
  function collectAll() {
    const found = [];
    const modal = activeModal();
    // Scope to the dialog when one is open, so the map describes what is actually
    // reachable. Its own controls come first because collect() starts at the root.
    collect(modal || document, found);
    // A dialog with nothing in it is not worth locking the map down to.
    if (modal && !found.length) collect(document, found);
    return { found, modal };
  }

  function buildSnapshot(opts = {}) {
    const { found, modal } = collectAll();

    state.elements = found.map((el) => {
      let id = state.handles.get(el);
      if (id === undefined) {
        id = state.nextId++;
        state.handles.set(el, id);
      }
      const role = roleOf(el);
      const name = accessibleName(el);
      state.byId.set(id, { ref: new WeakRef(el), role, name });
      return { id, el, role, name };
    });

    // byId holds weak references so a removed element can be collected; drop the handles
    // whose element already has been, or the map grows for the life of the page.
    for (const [id, known] of state.byId) {
      if (known.ref.deref() === undefined) state.byId.delete(id);
    }

    state.generation += 1;
    state.url = location.href;
    state.scoped = !!(modal && found.length);

    const lines = state.elements.map(describe);
    const header = [
      `page: ${document.title || '(untitled)'}`,
      `url: ${location.href}`,
      `generation: ${state.generation}`,
    ];
    if (state.scoped) {
      const name = accessibleName(modal);
      header.push(`scope: the open dialog${name ? ` "${name}"` : ''} — ` +
                  'the rest of the page is behind it and cannot be clicked. ' +
                  'Close the dialog to reach the page again.');
    }
    // Said out loud because a partial map is otherwise indistinguishable from a complete
    // one: the two notices below only fire at zero elements and at the cap, so anything in
    // between reads as the whole truth. It is not, on a page that was still drawing — and
    // the acting rules tell the model to trust the map it was handed rather than re-read.
    if (opts.provisional) {
      header.push('(this page was STILL RENDERING when the map was taken, so controls that ' +
                  'exist may be missing below and the line order may not be final. Before ' +
                  'concluding anything is absent here, act with {"verb":"wait"} and look again)');
    }
    if (!lines.length) {
      header.push('(no interactive elements found — the page may still be loading, ' +
                  'or its controls may be drawn on a canvas)');
    } else if (found.length >= MAX_ELEMENTS) {
      // NOT "scroll to see more": collection is document order, not viewport order, so
      // scrolling returns the same first MAX_ELEMENTS every time.
      header.push(`(only the first ${MAX_ELEMENTS} elements are listed — a control can be ` +
                  'on the page and missing from this list. Open the menu or dialog that ' +
                  'holds it, or act on what has focus)');
    }

    const snapshot = header.join('\n') + (lines.length ? '\n\n' + lines.join('\n') : '');

    // Compared against the previous map on the element lines alone: the header carries the
    // generation counter, which changes every time by design. Only the caller that appends
    // a map as a bonus (an act result) may act on this — an explicit read_page must always
    // return the real thing, because re-reading is how the agent recovers a map that was
    // dropped from its context.
    const body = lines.join('\n');
    const unchanged = !!state.lastMap && body === state.lastMap;
    state.lastMap = body;

    return {
      ok: true,
      generation: state.generation,
      url: location.href,
      title: document.title || '',
      count: found.length,
      truncated: found.length >= MAX_ELEMENTS,
      scoped: state.scoped,
      provisional: !!opts.provisional,
      unchanged,
      snapshot,
    };
  }

  // ══ Actions ═══════════════════════════════════════════════════════════════════

  // Verbs that are expected to change the page. The batch stops after one so the next
  // decision is made against a fresh snapshot: ids shift on re-render, and a custom
  // dropdown's options do not exist in the DOM until the trigger has been clicked.
  const TERMINAL_VERBS = new Set(['click', 'submit', 'press', 'back', 'forward']);

  const SETTLE_QUIET_MS = 400;   // no mutations for this long counts as settled
  const SETTLE_MAX_MS   = 3000;  // an animating page never goes quiet; cap the wait

  // A navigation gets its own, much longer budget, because it is a different problem. The
  // settle above asks "did this click do anything", which 3s answers well. After a
  // navigation the question is "has the new page finished drawing its controls", and on an
  // app-shell site the answer is routinely no at 3s — the map comes back holding the
  // masthead and the player while the buttons the task needs have not rendered.
  const STABLE_STEP_MS  = 400;
  const STABLE_MAX_MS   = 8000;
  // Consecutive non-growing samples before calling it done. Two rather than one because
  // progressive rendering plateaus: a single flat reading mid-render is common.
  const STABLE_CALM     = 2;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait until the page stops GROWING, then report whether it actually settled.
  //
  // Deliberately not a load check. The case this exists for is client-side navigation,
  // where the document is never replaced: readyState stays "complete" from the previous
  // page and chrome.tabs' status never leaves it either, so both say "loaded" while the
  // view is still blank. Element count is the only honest signal available.
  //
  // Counting elements rather than watching mutations also matters — a page with a clock, a
  // ticker or a live chat mutates forever and would always burn the full cap.
  async function waitForStable() {
    // ONE deadline for both phases below, not one each. Giving the parse wait its own full
    // budget and then handing a fresh one to the stability loop means a slow-parsing page
    // can be waited on for twice STABLE_MAX_MS, and the agent is holding a socket open the
    // whole time. The cap is a promise about total latency, so it has to be measured once.
    const deadline = Date.now() + STABLE_MAX_MS;

    // A document that has not finished parsing has no stable map to wait for. This is the
    // one place a load signal is the right one, and it only fires on real navigations.
    if (document.readyState === 'loading') {
      await new Promise((done) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; done(); } };
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        setTimeout(finish, Math.max(0, deadline - Date.now()));
      });
    }

    let last = collectAll().found.length;
    let calm = 0;

    // Clamped to what is left rather than a flat step, so the cap is exact. Checking the
    // deadline and only then sleeping a full step overshoots it by up to one step, and this
    // number is the promise being made about worst-case latency — a click already spent up
    // to SETTLE_MAX_MS before reaching here, and the socket is held open for the total.
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(STABLE_STEP_MS, left));
      const now = collectAll().found.length;
      // Only growth resets the timer. A count that DROPPED is a page rearranging itself or
      // unmounting what scrolled out of view, not one still filling in — waiting for it to
      // climb back would stall on every site that virtualises a list.
      if (now > last) calm = 0;
      else calm += 1;
      last = now;
      if (calm >= STABLE_CALM) return { stable: true, count: now };
    }

    return { stable: false, count: last };
  }

  class ActionError extends Error {}

  // ── Resolving an id back to a live element ──────────────────────────────────
  // Handles are resolved against the element they were minted for, so a number the model
  // is still holding either finds that same element or fails saying so. It can never find
  // a different one, which is what the old positional lookup did silently.
  function resolve(id) {
    if (!Number.isInteger(id)) {
      throw new ActionError(`"${id}" is not an element number. Read the page and use one of its numbers.`);
    }

    const known = state.byId.get(id);
    const el = known?.ref.deref();
    if (!el) {
      throw new ActionError(
        `Element ${id} is not on this page. It may have been removed, or the number may be ` +
        'from a different page. Read the page again for current numbers.'
      );
    }
    if (!el.isConnected) {
      throw new ActionError(`Element ${id} has been removed from the page. Read the page again.`);
    }

    // Element identity is not the same as element purpose: a re-render can reuse a node for
    // something else, and clicking that would be worse than failing. Checked against what
    // the element was when it was last listed, which is recorded even for elements that did
    // not make it into the most recent map.
    const name = accessibleName(el);
    if (name !== known.name) {
      throw new ActionError(
        `Element ${id} is now "${name}" but was "${known.name}" when you last read the page. ` +
        'It changed underneath — read the page again.'
      );
    }

    // Checked here as well as at collection time. Nothing else now stops an action landing
    // on a control that a dialog has since covered: it is still in the DOM, still has its
    // name, and a user could not touch it.
    if (!isVisible(el)) {
      throw new ActionError(
        `Element ${id} ("${name}") is on the page but not reachable — it is hidden, or ` +
        'something like a dialog is covering it. Read the page again to see what is on top.'
      );
    }

    return { id, el, role: known.role, name: known.name };
  }

  // ── Event helpers ───────────────────────────────────────────────────────────
  function fire(el, type, Ctor = Event, init = {}) {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  }

  function fireMouse(el, types) {
    for (const t of types) {
      // PointerEvent is absent in some embedded engines; MouseEvent is close enough.
      const Ctor = typeof PointerEvent === 'function' && t.startsWith('pointer')
        ? PointerEvent : MouseEvent;
      try { fire(el, t, Ctor, { view: window, button: 0 }); } catch { /* non-fatal */ }
    }
  }

  // Assigns through the prototype's value setter rather than the property.
  //
  // Content scripts run in an isolated world, where React's per-instance value tracker
  // (a main-world JS property) isn't even visible — so a plain `el.value = x` here already
  // reaches the native setter. This stays explicit so the same code is still correct if it
  // ever runs in the main world, where a plain assignment would be swallowed.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : el instanceof HTMLSelectElement   ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // Clicking an element the user cannot see usually lands on whatever is covering it —
  // most often a sticky header — and reads back as "the click did nothing". Always centre
  // first, and never as a step the model has to remember to ask for.
  function reveal(el) {
    try { el.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* jsdom */ }
  }

  function writeText(el, text) {
    reveal(el);
    el.focus?.();
    if (el.isContentEditable) {
      el.textContent = text;
      fire(el, 'input', Event);
      return;
    }
    setNativeValue(el, text);
    // Both events, in this order: frameworks listen for `input` while plain validation
    // code and jQuery listen for `change`.
    fire(el, 'input', Event);
    fire(el, 'change', Event);
  }

  function isChecked(el) {
    const aria = el.getAttribute('aria-checked');
    return aria !== null ? aria === 'true' : !!el.checked;
  }

  function activate(el) {
    reveal(el);
    fireMouse(el, ['pointerover', 'mouseover', 'pointerdown', 'mousedown']);
    el.focus?.();
    fireMouse(el, ['pointerup', 'mouseup']);
    // .click() rather than a dispatched click: it runs the element's activation
    // behaviour, which is what actually toggles a checkbox or follows a link.
    el.click();
  }

  // ── The verbs ───────────────────────────────────────────────────────────────
  const VERBS = {
    click(_a, entry) {
      activate(entry.el);
      return `clicked "${entry.name}"`;
    },

    type(action, entry) {
      if (typeof action.text !== 'string') throw new ActionError('type requires "text".');
      writeText(entry.el, action.text);
      const shown = entry.role === 'password' ? '(hidden)' : JSON.stringify(action.text);
      return `typed ${shown} into "${entry.name}"`;
    },

    clear(_a, entry) {
      writeText(entry.el, '');
      return `cleared "${entry.name}"`;
    },

    // check/uncheck exist because click() on a checkbox is a *toggle*: asking the model to
    // click "I accept the terms" un-accepts it whenever the site pre-checked the box.
    check(_a, entry) {
      if (isChecked(entry.el)) return `"${entry.name}" was already checked — no change`;
      activate(entry.el);
      return isChecked(entry.el) ? `checked "${entry.name}"`
                                 : `clicked "${entry.name}" but it is still unchecked`;
    },

    uncheck(_a, entry) {
      if (!isChecked(entry.el)) return `"${entry.name}" was already unchecked — no change`;
      activate(entry.el);
      return !isChecked(entry.el) ? `unchecked "${entry.name}"`
                                  : `clicked "${entry.name}" but it is still checked`;
    },

    select(action, entry) {
      const el = entry.el;
      if (el.tagName !== 'SELECT') {
        throw new ActionError(
          `[${action.id}] ("${entry.name}") is a ${entry.role}, not a <select>. ` +
          'Custom dropdowns need a click to open, then read_page, then a click on the option.'
        );
      }
      const want = String(action.value ?? action.text ?? '').trim().toLowerCase();
      if (!want) throw new ActionError('select requires "value".');
      const match = Array.from(el.options).find((o) =>
        (o.textContent || '').trim().toLowerCase() === want ||
        String(o.value).trim().toLowerCase() === want);
      if (!match) {
        const available = Array.from(el.options).slice(0, 20)
          .map((o) => (o.textContent || '').trim()).join(' | ');
        throw new ActionError(`No option matching "${action.value ?? action.text}". Available: ${available}`);
      }
      reveal(el);
      setNativeValue(el, match.value);
      fire(el, 'input', Event);
      fire(el, 'change', Event);
      return `selected "${(match.textContent || '').trim()}" in "${entry.name}"`;
    },

    press(action, entry) {
      const key = String(action.key || action.text || '').trim();
      if (!key) throw new ActionError('press requires "key" (for example "Enter" or "Escape").');
      const el = entry ? entry.el : (document.activeElement || document.body);
      if (entry) { reveal(el); el.focus?.(); }
      const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
      for (const t of ['keydown', 'keypress', 'keyup']) {
        if (t === 'keypress' && key.length > 1) continue;   // no keypress for named keys
        try { fire(el, t, KeyboardEvent, init); } catch { /* non-fatal */ }
      }
      // A synthetic Enter does not submit a form — the browser's implicit submission is
      // driven by the real key press, not the event. requestSubmit() is the honest path,
      // and unlike form.submit() it still fires validation and the submit handler.
      if (key === 'Enter') {
        const form = el.closest?.('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
          return 'pressed Enter and submitted the form';
        }
      }
      return `pressed ${key}`;
    },

    hover(_a, entry) {
      reveal(entry.el);
      fireMouse(entry.el, ['pointerover', 'mouseover', 'pointermove', 'mousemove']);
      // mouseenter does not bubble, so it has to be aimed at the element itself.
      try { entry.el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); } catch {}
      return `hovered "${entry.name}"`;
    },

    scroll(action, entry) {
      if (entry) { reveal(entry.el); return `scrolled "${entry.name}" into view`; }
      const dir = String(action.direction || 'down').toLowerCase();
      const box = scrollableTarget(action);
      const page = (box === document.scrollingElement || box === document.body)
        ? window.innerHeight : box.clientHeight;
      switch (dir) {
        case 'top':    box.scrollTop = 0;               return 'scrolled to the top';
        case 'bottom': box.scrollTop = box.scrollHeight; return 'scrolled to the bottom';
        case 'up':     box.scrollTop -= page * 0.85;    return 'scrolled up';
        default:       box.scrollTop += page * 0.85;    return 'scrolled down';
      }
    },

    submit(action, entry) {
      const form = entry ? (entry.el.closest('form') || (entry.el.tagName === 'FORM' ? entry.el : null))
                         : document.querySelector('form');
      if (!form) throw new ActionError('No <form> found to submit.');
      reveal(form);
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return 'submitted the form';
    },

    wait() { return 'waited for the page to settle'; },

    // Browser history, so a multi-page task can return to a list it came from. Doing this
    // by re-navigating to a remembered URL does not work on app-style sites, where the
    // results view often has no address that can be typed back in.
    //
    // A real back navigation destroys this content script, so SW_ACT never answers — which
    // is already handled: runClientTool treats a missing reply as a navigation and waits
    // for the new page before snapshotting it.
    back() {
      history.back();
      return 'went back';
    },

    forward() {
      history.forward();
      return 'went forward';
    },
  };

  // Finds the thing that actually scrolls: a modal body or chat log scrolls itself while
  // the document does not move at all.
  function scrollableTarget(action) {
    if (Number.isInteger(action.container)) {
      const el = resolve(action.container).el;
      return el;
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  // ── Settle ──────────────────────────────────────────────────────────────────
  // Snapshotting mid-render returns half a DOM, so wait for mutations to stop before
  // looking again.
  // Watch from BEFORE the action runs. Attaching the observer afterwards misses every
  // mutation the click flushed synchronously — a framework inserting a modal in the same
  // task — so "I saw nothing" was indistinguishable from "nothing happened", and the
  // 400ms quiet timer fired on a page that was in fact mid-render.
  function watch() {
    if (typeof MutationObserver !== 'function') {
      return { settle: () => new Promise((r) => setTimeout(() => r('blind'), SETTLE_QUIET_MS)) };
    }
    let seen = 0;
    const obs = new MutationObserver((records) => { seen += records.length; bump(); });
    let bump = () => {};
    obs.observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });

    return {
      settle() {
        return new Promise((done) => {
          let quiet, finished = false;
          const finish = (why) => {
            if (finished) return;
            finished = true;
            clearTimeout(quiet); clearTimeout(cap); obs.disconnect();
            done(why);
          };
          bump = () => { clearTimeout(quiet); quiet = setTimeout(() => finish('quiet'), SETTLE_QUIET_MS); };
          // Nothing has changed yet. Give the page a beat to start before believing it:
          // an async render (a lazily loaded dialog) has not even begun at this point.
          quiet = setTimeout(() => finish(seen ? 'quiet' : 'still'), SETTLE_QUIET_MS);
          const cap = setTimeout(() => finish('busy'), SETTLE_MAX_MS);
        });
      },
      get seen() { return seen; },
    };
  }

  // ── Running a batch ─────────────────────────────────────────────────────────
  async function runActions(message) {
    const actions = Array.isArray(message.actions) ? message.actions : [];
    if (!actions.length) return { ok: false, error: 'No actions supplied.' };

    // Neither of these refuses the batch any more. They used to have to: with positional
    // ids a stale number pointed at a different element, so the only safe answer was to
    // reject everything and demand a re-read. Handles carry identity now, so resolve()
    // catches a dead number precisely, per action — and a hash-routed app that re-renders
    // between every step (Gmail) no longer loses a whole round trip to a veto for elements
    // that are still perfectly valid.
    const drift = [];
    if (Number.isInteger(message.generation) && message.generation !== state.generation) {
      drift.push(`the page has been read again since you chose these (map ${message.generation} → ${state.generation})`);
    }
    if (state.url && state.url !== location.href) {
      drift.push(`the view moved to ${location.href}`);
    }

    // What the map looked like going in, so the reply can say what the action actually
    // did. Without this the model's only evidence is a fresh snapshot, and a click that
    // opened a dialog it could not see reads exactly like a click that did nothing.
    const before = new Set(state.elements.map((e) => `${e.role}|${e.name}`));
    const wasScoped = state.scoped;
    // The live location, not state.url. state.url is only refreshed by buildSnapshot, so
    // comparing against it detects a navigation that happened BEFORE this batch (which is
    // what `drift` above reports) and never the one this batch is about to cause.
    const urlBefore = location.href;
    const watcher = watch();

    const results = [];
    let stoppedAfter = null;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i] || {};
      const verb = String(action.verb || '').toLowerCase();
      const run = VERBS[verb];

      if (!run) {
        results.push({ verb, ok: false, detail: `Unknown verb "${verb}". Known verbs: ${Object.keys(VERBS).join(', ')}.` });
        break;   // the rest of the batch was planned around this step; don't guess
      }

      // press/scroll/submit/wait may legitimately have no target.
      let entry = null;
      try {
        if (Number.isInteger(action.id)) entry = resolve(action.id);
        else if (!['press', 'scroll', 'submit', 'wait', 'back', 'forward'].includes(verb)) {
          throw new ActionError(`${verb} requires an element id from read_page.`);
        }
        results.push({ verb, id: action.id, ok: true, detail: run(action, entry) });
      } catch (err) {
        results.push({
          verb, id: action.id, ok: false,
          detail: err instanceof ActionError ? err.message : `${err.name}: ${err.message}`,
        });
        break;   // a failed step invalidates whatever was planned after it
      }

      if (TERMINAL_VERBS.has(verb) && i < actions.length - 1) { stoppedAfter = i; break; }
      if (TERMINAL_VERBS.has(verb)) break;
    }

    const why = await watcher.settle();

    // The click navigated. The map is about to be replaced wholesale, so it is worth
    // waiting for the new page to finish drawing rather than photographing it mid-render:
    // this snapshot is the only thing the model gets, and the acting rules tell it to work
    // from what an act returns instead of reading again. A map missing the button the task
    // needs sends it down the recovery ladder for a control that was simply not there yet.
    const navigated = location.href !== urlBefore;
    const stability = navigated ? await waitForStable() : null;
    const fresh = buildSnapshot({ provisional: stability ? !stability.stable : false });

    const after = state.elements.map((e) => `${e.role}|${e.name}`);
    const appeared = after.filter((k) => !before.has(k));
    const gone = before.size - (after.length - appeared.length);

    let changed;
    if (navigated) {
      // Ahead of every other branch: after a navigation the appeared/gone diff is two
      // unrelated pages subtracted from each other, and reporting "184 new, 176 gone"
      // invites the model to read it as the old page having changed under it.
      changed = `the page navigated to ${location.href} — this is a different page, so the ` +
                'map below replaces everything you had and element numbers from before are ' +
                'dead' +
                (stability && !stability.stable
                  ? '. It was still rendering when this was taken, so look again before ' +
                    'deciding a control is missing'
                  : '');
    } else if (fresh.scoped && !wasScoped) {
      changed = `a dialog opened — the map below is its contents (${after.length} controls)`;
    } else if (wasScoped && !fresh.scoped) {
      changed = 'the dialog closed — the map below is the page again';
    } else if (appeared.length || gone > 0) {
      const bits = [];
      if (appeared.length) bits.push(`${appeared.length} new`);
      if (gone > 0) bits.push(`${gone} gone`);
      changed = `the page changed (${bits.join(', ')})`;
    } else if (why === 'busy') {
      changed = 'the page is still changing and did not settle — it may not be finished yet';
    } else if (why === 'still') {
      changed = 'nothing happened at all — the page never even started to change. If you ' +
                'expected something to open, it did not. Read the page again, or try a ' +
                'different element.';
    } else {
      changed = 'nothing visible changed. The control you want may be present but not ' +
                'listed below — try act with {"verb":"wait"}, or act on what has focus.';
    }

    return {
      ok: results.every((r) => r.ok),
      results,
      changed,
      // Context, not a complaint: it explains a failed action without implying the whole
      // batch was wrong to attempt.
      drift: drift.length ? drift.join('; ') : null,
      settled: why,
      navigated,
      provisional: fresh.provisional,
      stopped_after: stoppedAfter,
      remaining: stoppedAfter === null ? 0 : actions.length - stoppedAfter - 1,
      generation: fresh.generation,
      // NOTE: `unchanged` is deliberately still not forwarded, even though buildSnapshot
      // computes it and formatActResult reads it. It has never been sent, so that whole
      // "the map is unchanged, reuse your ids" path in the panel has never once run — an
      // act result has always carried the full map. Switching it on is a real token saving
      // and a genuinely untested code path, so it does not belong in a change whose whole
      // subject is handing the model a trustworthy map. If it is ever enabled: it must be
      // forced false when `navigated`, because every id was retired by the navigation.
      snapshot: fresh.snapshot,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SW_SNAPSHOT') {
      // Opt-in, not the default. The caller that has just landed on a fresh page (a goto,
      // or a click that triggered a real load) wants to wait for it to draw; read_page must
      // stay immediate, because re-reading is the recovery move the acting rules lean on and
      // making it slow would tax every attempt to get un-stuck.
      if (message.waitForStable) {
        waitForStable()
          .then((s) => sendResponse(buildSnapshot({ provisional: !s.stable })))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
      }
      try {
        sendResponse(buildSnapshot());
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }

    if (message?.type === 'SW_ACT') {
      // Async: the batch waits for the DOM to settle before re-snapshotting, so the
      // channel has to stay open until then.
      runActions(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }

    return false;
  });
})();
