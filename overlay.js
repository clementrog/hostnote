// The notes layer: marks, rectangles, cards and the note field, in a shadow root over the page.
(() => {
  if (window.__hostnote) return;
  window.__hostnote = true;
  const API = '/__hostnote';

  // Colours follow the page behind each note, not prefers-color-scheme: on a light page the amber
  // is the light-page one and the card is dark; .on-dark (a dark page) turns both round.
  const css = `
    :host { --mark: rgba(245,173,26,.50); --lit: rgba(245,163,13,.90); --lines: rgba(255,255,255,.85); --fill: rgba(245,173,26,.08);
      --bg: #1e1e1e; --sep: rgba(255,255,255,.12); --text: #f2f2f2; --text2: #a0a0a0; }
    .on-dark { --mark: rgba(250,194,71,.55); --lit: rgba(255,199,77,.95); --lines: rgba(26,26,26,.55); --fill: rgba(250,194,71,.08);
      --bg: #fff; --sep: rgba(0,0,0,.1); --text: #1d1d1f; --text2: #6e6e73; }
    * { box-sizing: border-box; }
    .ui { font: 13px/1.35 system-ui, -apple-system, sans-serif; }
    .mark { position: fixed; z-index: 1; width: 19px; height: 20px; padding: 3px; pointer-events: auto; cursor: pointer; }
    .mark svg { display: block; }
    .mark path { fill: var(--mark); }
    .mark rect { fill: var(--lines); }
    .mark:hover path, .mark.lit path { fill: var(--lit); }
    .outline { position: fixed; outline: 1px solid var(--mark); border-radius: 2px; pointer-events: none; }
    .outline.faint { opacity: .5; }
    .outline.hover { outline-color: var(--lit); }
    .line { position: fixed; height: 2px; border-radius: 1px; background: var(--mark); pointer-events: none; }
    .line.lit { background: var(--lit); }
    .box { position: fixed; border: 1.5px solid var(--mark); border-radius: 3px; background: var(--fill); pointer-events: none; }
    .box.lit { border-color: var(--lit); }
    .card { position: fixed; z-index: 2; max-width: 360px; padding: 7px 10px 8px 10px; background: var(--bg); color: var(--text);
      border: 1px solid var(--sep); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.12), 0 1px 3px rgba(0,0,0,.08); pointer-events: auto; }
    .card::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; background: var(--mark); }
    .card .text { max-width: 340px; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
    .card .del { all: unset; display: block; margin-top: 4px; font-size: 11px; color: var(--text2); cursor: pointer; }
    .card .del:hover { color: var(--text); }
    .field { position: fixed; z-index: 2; width: 320px; padding: 5px 8px; background: var(--bg); color: var(--text); border: 1px solid var(--sep);
      border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08); pointer-events: auto; }
    .field input, .card .edit { all: unset; display: block; width: 100%; font: inherit; color: var(--text); }
    .card .edit { width: 320px; }
    .field input::placeholder { color: var(--text2); }
    .pill { position: fixed; right: 12px; bottom: 12px; padding: 3px 9px; border-radius: 10px; background: var(--mark);
      color: rgba(0,0,0,.75); font-size: 12px; pointer-events: auto; cursor: pointer; }
    .pill:hover { background: var(--lit); }
  `;
  const MARK_SVG = '<svg width="13" height="14" viewBox="0 0 13 14"><path d="M3 0h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3z"/>' +
    '<path d="M3 9.5V13L7 9.5z"/><rect x="3" y="3" width="7" height="1"/><rect x="3" y="6" width="5" height="1"/></svg>';

  const host = document.createElement('hostnote-layer');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css}</style><div class="ui"></div>`;
  const ui = root.querySelector('.ui');
  const attach = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  attach();
  const pickStyle = document.createElement('style');
  pickStyle.textContent = 'html[data-hostnote-pick], html[data-hostnote-pick] * { cursor: crosshair !important; }';
  (document.head || document.documentElement).appendChild(pickStyle);

  const div = (cls, parent = ui) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const ours = (e) => e.composedPath().includes(host);

  // ---- The page's lightness ---------------------------------------------------------------

  // Any CSS colour (oklch too) as sRGB 0–255 and alpha 0–1, through a 1×1 canvas.
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const colours = new Map();
  function rgba(c) {
    if (!colours.has(c)) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      colours.set(c, [r, g, b, a / 255]);
    }
    return colours.get(c);
  }

  // Whether the background behind an element is dark: its own and its ancestors' backgrounds up
  // to the first opaque one, laid over white.
  function isDark(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let [r, g, b] = [255, 255, 255];
    for (const [lr, lg, lb, a] of layers.reverse()) { r += (lr - r) * a; g += (lg - g) * a; b += (lb - b) * a; }
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }
  const tone = (el, dark) => el.classList.toggle('on-dark', dark);
  const pageDark = () => isDark(document.body || document.documentElement);

  // ---- Anchors --------------------------------------------------------------------------------

  function query(selector) { try { return document.querySelector(selector); } catch { return null; } }

  function selectorOf(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (e === document.body) { parts.unshift('body'); break; }
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id) && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) {
        parts.unshift('#' + CSS.escape(e.id));
        break;
      }
      let part = CSS.escape(e.localName);
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === e.localName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
    }
    return parts.join(' > ');
  }

  // The quoted text inside an element, matched without whitespace (a selection and the DOM's
  // text do not agree on line breaks between blocks).
  function findText(el, quote) {
    const needle = quote.replace(/\s+/g, '');
    if (!needle) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let flat = '';
    const nodes = [], offsets = [];
    for (let n; (n = walker.nextNode());) {
      const t = n.data;
      for (let i = 0; i < t.length; i++) if (!/\s/.test(t[i])) { flat += t[i]; nodes.push(n); offsets.push(i); }
      if (flat.length > 300000) break;
    }
    const at = flat.indexOf(needle);
    if (at < 0) return null;
    const end = at + needle.length - 1;
    const range = document.createRange();
    range.setStart(nodes[at], offsets[at]);
    range.setEnd(nodes[end], offsets[end] + 1);
    return range;
  }

  // note id → its Range (text) or element (element note), or null when not found; cleared when
  // the DOM or the notes change.
  const anchors = new Map();
  // An element's first 60 characters, as the notes file keeps them.
  const excerpt = (e) => oneLine(oneLine(e.textContent).slice(0, 60));

  // A range's line boxes: its text nodes' rects only, not the boxes of the elements it holds.
  function lineRects(range) {
    const c = range.commonAncestorContainer;
    let rects = [];
    if (c.nodeType === Node.TEXT_NODE) rects = [...range.getClientRects()];
    else {
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        if (!range.intersectsNode(n)) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        if (n === range.startContainer) r.setStart(n, range.startOffset);
        if (n === range.endContainer) r.setEnd(n, range.endOffset);
        rects.push(...r.getClientRects());
        if (n === range.endContainer) break;
      }
    }
    return rects.filter((r) => r.width && r.height);
  }

  // Where a note is on screen now: { rect, lines and line (text: its line boxes, the last), el },
  // or null.
  function resolve(n) {
    if (n.kind === 'box') {
      const el = query(n.selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, rect: new DOMRect(r.left + n.x, r.top + n.y, n.w, n.h) };
    }
    if (!anchors.has(n.id)) anchors.set(n.id, find(n));
    const found = anchors.get(n.id);
    if (!found) return null;
    if (n.kind === 'text') {
      const lines = lineRects(found);
      if (!lines.length) return null;
      return { el: found.startContainer.parentElement, rect: found.getBoundingClientRect(), lines, line: lines[lines.length - 1] };
    }
    const rect = found.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { el: found, rect };
  }

  function find(n) {
    const el = query(n.selector);
    if (!el) return null;
    if (n.kind === 'text') return findText(el, n.text);
    // The selector may now name a sibling: the element must still start with the saved text,
    // or be the only one of its tag that does.
    if (excerpt(el) === n.text) return el;
    const same = [...document.getElementsByTagName(el.localName)].filter((e) => excerpt(e) === n.text);
    return same.length === 1 ? same[0] : null;
  }

  function markSpot(n, at) {
    let x, y;
    if (n.kind === 'text') { x = at.line.right - 4; y = at.line.top - 9; }
    else { x = at.rect.right - 10; y = at.rect.top - 10; }
    return { x: Math.min(Math.max(x, 2), innerWidth - 21), y: Math.min(Math.max(y, 2), innerHeight - 22) };
  }

  function elementAt(x, y) {
    const el = document.elementsFromPoint(x, y).find((e) => e !== host);
    return !el || el === document.documentElement ? document.body : el;
  }

  // ---- State ------------------------------------------------------------------------------

  let notes = [];
  const drawn = new Map(); // id → { mark, outline, box, at }
  let card = null; // { id, el, pinned, edit (the input while its text is edited) }
  let field = null; // { el, input, pending, anchor }
  let pick = false;
  let gesture = null; // { x, y, dragging }
  let swallow = false;
  let hoverOutline = null, dragBox = null;
  let pill = null, unplaced = [], unplacedAt = 0;
  let current = null; // the note Next/Previous went to last
  let page = location.pathname;

  async function load() {
    try {
      notes = await (await fetch(API + '/notes', { cache: 'no-store' })).json();
    } catch { return; }
    anchors.clear();
    // An open card follows the file: gone when its line is, its new text when edited.
    const shown = card && notes.find((n) => n.id === card.id);
    if (card && !shown) hideCard();
    else if (shown && !card.edit) card.el.querySelector('.text').textContent = shown.note;
    schedule();
  }

  // ---- Drawing ----------------------------------------------------------------------------

  let frame = 0;
  function schedule() { if (!frame) frame = requestAnimationFrame(draw); }

  function draw() {
    frame = 0;
    attach();
    const here = notes.filter((n) => n.page === location.pathname);
    const ids = new Set(here.map((n) => n.id));
    for (const [id, d] of drawn) if (!ids.has(id)) { d.mark.remove(); d.outline?.remove(); d.box?.remove(); d.lines?.forEach((l) => l.remove()); drawn.delete(id); }
    unplaced = [];
    for (const n of here) {
      let d = drawn.get(n.id);
      if (!d) { d = makeDrawn(n); drawn.set(n.id, d); }
      const at = resolve(n);
      d.at = at;
      d.note = n;
      const show = !!at;
      d.mark.style.display = show ? '' : 'none';
      if (!show) {
        unplaced.push(n);
        for (const el of [d.outline, d.box, ...(d.lines || [])]) if (el) el.style.display = 'none';
        continue;
      }
      d.dark = isDark(at.el);
      const spot = markSpot(n, at);
      place(d.mark, spot.x, spot.y);
      const lit = card?.id === n.id || !!d.hover;
      d.mark.classList.toggle('lit', lit);
      tone(d.mark, d.dark);
      if (d.box) { d.box.style.display = ''; placeRect(d.box, at.rect); d.box.classList.toggle('lit', lit); tone(d.box, d.dark); }
      // What the note is on stays shown with its card closed: a faint outline, an underline.
      if (d.outline) { d.outline.style.display = ''; placeRect(d.outline, at.rect); d.outline.classList.toggle('faint', !lit); tone(d.outline, d.dark); }
      if (d.lines) {
        while (d.lines.length < at.lines.length) d.lines.push(div('line'));
        while (d.lines.length > at.lines.length) d.lines.pop().remove();
        at.lines.forEach((r, i) => {
          const l = d.lines[i];
          l.style.display = '';
          place(l, r.left, r.bottom - 1);
          l.style.width = r.width + 'px';
          l.classList.toggle('lit', lit);
          tone(l, d.dark);
        });
      }
    }
    drawPill();
    if (field) {
      const dark = isDark(field.anchor);
      tone(field.el, dark);
      if (field.pending.kind !== 'text') {
        const at = resolve(field.pending);
        if (!field.shape) field.shape = div(field.pending.kind === 'box' ? 'box' : 'outline');
        if (at) placeRect(field.shape, at.rect);
        field.shape.style.display = at ? '' : 'none';
        tone(field.shape, dark);
      }
    }
    if (card) placeCard();
  }

  function makeDrawn(n) {
    const d = { mark: div('mark') };
    d.mark.innerHTML = MARK_SVG;
    d.mark.dataset.id = n.id;
    if (n.kind === 'element') d.outline = div('outline');
    if (n.kind === 'box') d.box = div('box');
    if (n.kind === 'text') d.lines = [];
    d.mark.addEventListener('mouseenter', () => { d.hover = true; cancelHide(); if (!card?.pinned) showCard(n.id, false); schedule(); });
    d.mark.addEventListener('mouseleave', () => { d.hover = false; laterHide(); schedule(); });
    d.mark.addEventListener('click', (e) => { e.stopPropagation(); showCard(n.id, true); });
    return d;
  }

  function place(el, x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
  function placeRect(el, r) { place(el, r.left, r.top); el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; }

  function drawPill() {
    if (!unplaced.length) { pill?.remove(); pill = null; return; }
    if (!pill) {
      pill = div('pill');
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!unplaced.length) return;
        unplacedAt = (unplacedAt + (card && unplaced.some((n) => n.id === card.id) ? 1 : 0)) % unplaced.length;
        showCard(unplaced[unplacedAt].id, true);
      });
    }
    pill.textContent = unplaced.length === 1 ? '1 note not placed' : `${unplaced.length} notes not placed`;
    tone(pill, pageDark());
  }

  // ---- The card ---------------------------------------------------------------------------

  let hideTimer = 0;
  function cancelHide() { clearTimeout(hideTimer); }
  function laterHide() { cancelHide(); hideTimer = setTimeout(() => { if (card && !card.pinned) hideCard(); }, 200); }

  function showCard(id, pinned) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    if (card?.id !== id) {
      hideCard();
      const el = div('card');
      const text = div('text', el);
      text.textContent = n.note;
      text.addEventListener('click', (e) => { e.stopPropagation(); editCard(); });
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        hideCard();
        notes = notes.filter((x) => x.id !== id);
        schedule();
        await fetch(`${API}/notes/${id}`, { method: 'DELETE' }).catch(() => {});
        load();
      });
      el.appendChild(del);
      el.addEventListener('mouseenter', cancelHide);
      el.addEventListener('mouseleave', laterHide);
      card = { id, el, pinned };
    }
    card.pinned = card.pinned || pinned;
    placeCard();
    schedule();
  }

  function hideCard() { cancelHide(); card?.el.remove(); card = null; schedule(); }

  // The card's text becomes a one-line field: Return saves, Escape or a click elsewhere cancels.
  function editCard() {
    const n = card && notes.find((x) => x.id === card.id);
    if (!n || card.edit) return;
    const c = card;
    c.pinned = true;
    cancelHide();
    const text = c.el.querySelector('.text');
    const input = document.createElement('input');
    input.className = 'edit';
    input.spellcheck = true;
    input.value = n.note;
    text.style.display = 'none';
    text.after(input);
    c.edit = input;
    const end = () => {
      if (c.edit !== input) return;
      c.edit = null;
      input.remove();
      text.style.display = '';
      schedule();
    };
    oneLineField(input, async () => {
      const note = oneLine(input.value);
      end();
      // Empty keeps the old text: no note is deleted by accident.
      if (!note || note === n.note) return;
      try {
        const res = await fetch(`${API}/notes/${n.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
        if (res.ok) {
          const saved = await res.json();
          const i = notes.findIndex((x) => x.id === n.id);
          if (i >= 0) notes[i] = saved;
          if (card === c) text.textContent = saved.note;
        } else if (res.status === 404 && card === c) text.textContent = 'This note has gone from the notes file.';
      } catch {}
      schedule();
    }, end);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    schedule();
  }

  function placeCard() {
    const d = drawn.get(card.id);
    let anchor;
    tone(card.el, d?.at ? d.dark : pageDark());
    if (d?.at) anchor = d.mark.getBoundingClientRect();
    else if (pill) anchor = pill.getBoundingClientRect();
    else return;
    const w = card.el.offsetWidth, h = card.el.offsetHeight;
    const x = Math.min(Math.max(anchor.left + anchor.width / 2 - 16, 4), innerWidth - w - 4);
    let y = anchor.top - h - 2;
    if (y < 4) y = anchor.bottom + 2;
    place(card.el, x, y);
  }

  // ---- The note field ---------------------------------------------------------------------

  // A one-line input of ours: pasted line breaks become spaces, the page hears none of its keys,
  // Return calls enter, Escape and a click elsewhere call cancel.
  function oneLineField(input, enter, cancel) {
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text == null) return;
      e.preventDefault();
      input.setRangeText(text.replace(/\s*[\r\n]+\s*/g, ' '), input.selectionStart, input.selectionEnd, 'end');
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enter(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    for (const type of ['keyup', 'keypress', 'input']) input.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('blur', cancel);
  }

  function openField(pending, spot, anchor) {
    closeField();
    const el = div('field');
    const input = document.createElement('input');
    input.placeholder = 'Note for the agent';
    input.spellcheck = true;
    el.appendChild(input);
    const f = { el, input, pending, anchor, done: false };
    field = f;
    tone(el, isDark(anchor));
    const w = 320, h = el.offsetHeight || 30;
    let y = spot.bottom + 6;
    if (y + h > innerHeight - 4) y = Math.max(4, spot.top - h - 6);
    place(el, Math.min(Math.max(spot.left, 4), innerWidth - w - 4), y);
    oneLineField(input, () => submit(f), () => { if (field === f) closeField(); });
    input.focus({ preventScroll: true });
    schedule();
  }

  function closeField() {
    if (!field) return;
    const f = field;
    field = null;
    f.done = true;
    f.el.remove();
    f.shape?.remove();
    schedule();
  }

  async function submit(f) {
    if (f.done) return;
    const note = oneLine(f.input.value);
    closeField();
    if (!note) return;
    const body = { ...f.pending, note, page: location.pathname };
    try {
      const res = await fetch(API + '/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { notes.push(await res.json()); anchors.clear(); schedule(); }
    } catch {}
  }

  // ---- Adding -----------------------------------------------------------------------------

  function addNote() {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && oneLine(sel.toString())) {
      const range = sel.getRangeAt(0);
      let el = range.commonAncestorContainer;
      if (el.nodeType !== 1) el = el.parentElement;
      if (el && !host.contains(el) && el !== host) {
        const text = oneLine(range.toString()).slice(0, 300);
        const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
        const last = rects[rects.length - 1] || range.getBoundingClientRect();
        openField({ kind: 'text', selector: selectorOf(el), text }, last, el);
        return;
      }
    }
    setPick(true);
  }

  function setPick(on) {
    pick = on;
    if (on) document.documentElement.setAttribute('data-hostnote-pick', '');
    else { document.documentElement.removeAttribute('data-hostnote-pick'); hoverOutline?.remove(); hoverOutline = null; }
  }

  function elementNote(x, y) {
    const el = elementAt(x, y);
    const pending = { kind: 'element', selector: selectorOf(el), text: excerpt(el) };
    openField(pending, new DOMRect(x, y, 0, 0), el);
  }

  function boxNote(r) {
    // Kept relative to the smallest element that holds the whole rectangle.
    let el = elementAt(r.left + r.width / 2, r.top + r.height / 2);
    const holds = (b) => b.left <= r.left + 1 && b.top <= r.top + 1 && b.right >= r.right - 1 && b.bottom >= r.bottom - 1;
    while (el && el !== document.body && !holds(el.getBoundingClientRect())) el = el.parentElement;
    if (!el || el === document.documentElement) el = document.body;
    const b = el.getBoundingClientRect();
    const pending = { kind: 'box', selector: selectorOf(el), x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height) };
    openField(pending, r, el);
  }

  // ---- Next and Previous ------------------------------------------------------------------

  function go(step) {
    const placed = [...drawn.values()].filter((d) => d.at && d.note.page === location.pathname);
    if (!placed.length) return;
    const top = (d) => d.at.rect.top + scrollY;
    placed.sort((a, b) => top(a) - top(b) || a.at.rect.left - b.at.rect.left);
    let i = placed.findIndex((d) => d.note.id === (card?.id || current));
    if (i < 0) {
      i = placed.findIndex((d) => d.at.rect.top >= 0);
      if (i < 0) i = 0;
      if (step < 0) i = (i - 1 + placed.length) % placed.length;
    } else i = (i + step + placed.length) % placed.length;
    const d = placed[i];
    current = d.note.id;
    if (d.note.kind !== 'box') d.at.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = resolve(d.note)?.rect;
    if (r && (r.top < 0 || r.bottom > innerHeight)) scrollBy(0, r.top - innerHeight / 3);
    hideCard();
    draw();
    showCard(d.note.id, true);
  }

  // ---- Events -----------------------------------------------------------------------------

  // C adds a note, N and ⇧N go to the next and previous one, as Figma's C for comments: single
  // keys, because macOS and the browser own the ⌘ ones (⌥⌘M hides every window). Not while typing.
  const typing = (e) => {
    const t = e.composedPath()[0];
    return t instanceof Element && (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null);
  };
  addEventListener('keydown', (e) => {
    if ((field || card?.edit) && ours(e)) return;
    if (!e.metaKey && !e.altKey && !e.ctrlKey && !e.repeat && (e.code === 'KeyC' || e.code === 'KeyN') && !typing(e)) {
      if (e.code === 'KeyC' && e.shiftKey) return;
      stop(e);
      if (field) return;
      if (e.code === 'KeyC') addNote();
      else go(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Escape' && pick) { stop(e); setPick(false); return; }
    if (card?.pinned && !['Shift', 'Alt', 'Meta', 'Control', 'CapsLock'].includes(e.key)) hideCard();
  }, true);

  addEventListener('pointerdown', (e) => {
    if (ours(e)) return;
    if (card?.pinned) hideCard();
    const alt = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (e.button !== 0 || !(pick || alt)) return;
    e.stopImmediatePropagation();
    gesture = { x: e.clientX, y: e.clientY, dragging: false };
    swallow = true;
  }, true);

  addEventListener('pointermove', (e) => {
    if (gesture) {
      e.stopImmediatePropagation();
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      if (!gesture.dragging && Math.hypot(dx, dy) > 4) {
        gesture.dragging = true;
        hoverOutline?.remove();
        hoverOutline = null;
        dragBox = div('box');
        tone(dragBox, isDark(elementAt(gesture.x, gesture.y)));
      }
      if (gesture.dragging) placeRect(dragBox, gesture.rect = rectOf(gesture.x, gesture.y, e.clientX, e.clientY));
      return;
    }
    if (pick && !ours(e)) {
      const el = elementAt(e.clientX, e.clientY);
      if (!hoverOutline) hoverOutline = div('outline hover');
      placeRect(hoverOutline, el.getBoundingClientRect());
      tone(hoverOutline, isDark(el));
    }
  }, true);

  addEventListener('pointerup', (e) => {
    if (!gesture) return;
    e.stopImmediatePropagation();
    const g = gesture;
    gesture = null;
    setTimeout(() => { swallow = false; }, 400);
    dragBox?.remove();
    dragBox = null;
    setPick(false);
    if (g.dragging && g.rect.width > 2 && g.rect.height > 2) boxNote(g.rect);
    else elementNote(g.x, g.y);
  }, true);

  addEventListener('pointercancel', () => { gesture = null; swallow = false; dragBox?.remove(); dragBox = null; }, true);

  // While a gesture runs, the page gets no click (no link followed, no ⌥-click download),
  // no focus change, no text selection and no drag.
  for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'dragstart', 'selectstart', 'contextmenu']) {
    addEventListener(type, (e) => {
      if (!swallow || ours(e)) return;
      stop(e);
      if (type === 'click') swallow = false;
    }, true);
  }

  function rectOf(x1, y1, x2, y2) { return new DOMRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }

  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule);
  new MutationObserver(() => { anchors.clear(); schedule(); })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(() => {
    if (location.pathname !== page) { page = location.pathname; current = null; hideCard(); }
    schedule();
  }, 250);

  new EventSource(API + '/events').onmessage = load;
  load();
})();
