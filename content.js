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

  // Injected both declaratively (manifest) and on demand (executeScript, for tabs that
  // predate the extension loading). Re-running would reset live element refs, so bail.
  if (window.__siteWhisper) return;

  const MAX_ELEMENTS   = 200;   // beyond this the snapshot costs more than it's worth
  const MAX_NAME_CHARS = 120;
  const MAX_VALUE_CHARS = 80;
  const MAX_OPTIONS    = 20;

  const state = {
    // index → { el, role, name }. The [n] in the snapshot indexes this. The role and name
    // are kept so an action can prove the element is still the one the model was shown:
    // a bare element reference happily survives a re-render into a different button.
    elements: [],
    generation: 0,  // bumped every snapshot; acting on an older one must error
    url: '',        // location at snapshot time; a navigation invalidates every id
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

  function isInteractive(el) {
    const role = (el.getAttribute('role') || '').trim().toLowerCase();
    if (role) return ACTIONABLE_ROLES.has(role);
    if (el.matches(NATIVE_SEL)) return true;
    // Click handlers and focusable divs are only worth a line if they're named —
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

  function describe(entry, index) {
    const { el, role, name } = entry;
    const flags = stateFlags(el, role);
    const value = valueOf(el, role);

    let line = `[${index}] ${role}`;
    if (name) line += ` "${name}"`;
    if (value !== null && value !== undefined) line += ` = "${value}"`;
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

  function buildSnapshot() {
    const found = [];
    collect(document, found);

    state.elements = found.map((el) => ({ el, role: roleOf(el), name: accessibleName(el) }));
    state.generation += 1;
    state.url = location.href;

    const lines = state.elements.map(describe);
    const header = [
      `page: ${document.title || '(untitled)'}`,
      `url: ${location.href}`,
      `generation: ${state.generation}`,
    ];
    if (!lines.length) {
      header.push('(no interactive elements found — the page may still be loading, ' +
                  'or its controls may be drawn on a canvas)');
    } else if (found.length >= MAX_ELEMENTS) {
      header.push(`(truncated at ${MAX_ELEMENTS} elements — scroll or narrow the page to see more)`);
    }

    return {
      ok: true,
      generation: state.generation,
      url: location.href,
      title: document.title || '',
      count: found.length,
      truncated: found.length >= MAX_ELEMENTS,
      snapshot: header.join('\n') + (lines.length ? '\n\n' + lines.join('\n') : ''),
    };
  }

  // ══ Actions ═══════════════════════════════════════════════════════════════════

  // Verbs that are expected to change the page. The batch stops after one so the next
  // decision is made against a fresh snapshot: ids shift on re-render, and a custom
  // dropdown's options do not exist in the DOM until the trigger has been clicked.
  const TERMINAL_VERBS = new Set(['click', 'submit', 'press']);

  const SETTLE_QUIET_MS = 400;   // no mutations for this long counts as settled
  const SETTLE_MAX_MS   = 3000;  // an animating page never goes quiet; cap the wait

  class ActionError extends Error {}

  // ── Resolving an id back to a live element ──────────────────────────────────
  function resolve(id) {
    if (!Number.isInteger(id) || id < 0 || id >= state.elements.length) {
      throw new ActionError(
        `No element [${id}] in the current snapshot (it has ${state.elements.length}). ` +
        'Call read_page again.'
      );
    }
    const entry = state.elements[id];
    if (!entry.el.isConnected) {
      throw new ActionError(
        `Element [${id}] ("${entry.name}") is no longer on the page. Call read_page again.`
      );
    }
    // The strongest staleness check available: a re-render can hand the same DOM node a
    // different purpose, and clicking it would be worse than failing.
    const nameNow = accessibleName(entry.el);
    if (nameNow !== entry.name) {
      throw new ActionError(
        `Element [${id}] is now "${nameNow}" but the snapshot showed "${entry.name}". ` +
        'The page changed — call read_page again.'
      );
    }
    return entry;
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
  function settle() {
    return new Promise((done) => {
      if (typeof MutationObserver !== 'function') { setTimeout(done, SETTLE_QUIET_MS); return; }
      let quiet, finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(quiet); clearTimeout(cap); obs.disconnect(); done();
      };
      const obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, SETTLE_QUIET_MS);
      });
      obs.observe(document.documentElement || document, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      quiet = setTimeout(finish, SETTLE_QUIET_MS);
      const cap = setTimeout(finish, SETTLE_MAX_MS);
    });
  }

  // ── Running a batch ─────────────────────────────────────────────────────────
  async function runActions(message) {
    const actions = Array.isArray(message.actions) ? message.actions : [];
    if (!actions.length) return { ok: false, error: 'No actions supplied.' };

    // Acting on an older snapshot than the one that produced these ids is exactly how a
    // click lands on the wrong element.
    if (Number.isInteger(message.generation) && message.generation !== state.generation) {
      return {
        ok: false,
        error: `These actions were chosen from snapshot ${message.generation}, but the page ` +
               `is now at ${state.generation}. Call read_page again.`,
      };
    }
    if (state.url && state.url !== location.href) {
      return {
        ok: false,
        error: `The page navigated to ${location.href} since the snapshot. Call read_page again.`,
      };
    }

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
        else if (!['press', 'scroll', 'submit', 'wait'].includes(verb)) {
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

    await settle();
    const fresh = buildSnapshot();

    return {
      ok: results.every((r) => r.ok),
      results,
      stopped_after: stoppedAfter,
      remaining: stoppedAfter === null ? 0 : actions.length - stoppedAfter - 1,
      generation: fresh.generation,
      snapshot: fresh.snapshot,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SW_SNAPSHOT') {
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
