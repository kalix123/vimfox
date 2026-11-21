// Vim key notation, shared by the browser window and every page.
// Plain script (no imports): the browser loads it with loadSubScript, and it
// is prepended to the page script (content.js) that runs in page processes.
//
//   VimKeys.keyName(keyboardEvent) -> "j", "G", "<C-d>", "<Esc>", "<S-Insert>", or null
//   VimKeys.parseKeys("gg<C-d>")   -> ["g", "g", "<C-d>"]
//   VimKeys.feedKey(state, key, config) -> what a key press means (see below)
//   VimKeys.PAGE_COMMANDS            commands that run inside the page
//
// Canonical form: modifiers in the order C (ctrl), A (alt), M (meta), S
// (shift). Shift is only written for named keys and for letters combined with
// another modifier; otherwise it is already in the character ("G").

var VimKeys = (() => {
  const NAMED = {
    Escape: "Esc", Enter: "CR", Tab: "Tab", Backspace: "BS", Insert: "Insert", Delete: "Del",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
  };
  const CANON = {
    esc: "Esc", escape: "Esc", space: "Space", cr: "CR", enter: "CR", return: "CR", tab: "Tab",
    bs: "BS", backspace: "BS", insert: "Insert", ins: "Insert", del: "Del", delete: "Del",
    up: "Up", down: "Down", left: "Left", right: "Right", pageup: "PageUp", pagedown: "PageDown",
    home: "Home", end: "End", lt: "lt",
  };
  const MOD_ORDER = ["C", "A", "M", "S"];
  const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "OS", "Dead", "Unidentified", "Process", "NumLock"]);

  function format(mods, base) {
    if (mods.length === 0) return base.length === 1 ? base : `<${base}>`;
    return `<${MOD_ORDER.filter((m) => mods.includes(m)).join("-")}-${base}>`;
  }

  function keyName(e) {
    if (MODIFIER_KEYS.has(e.key)) return null;
    let base;
    if (e.key === " ") base = "Space";
    else if (e.key === "<") base = "lt";
    else if (e.key.length === 1) base = e.key;
    else if (NAMED[e.key]) base = NAMED[e.key];
    else if (/^F\d{1,2}$/.test(e.key)) base = e.key;
    else return null;
    const mods = [];
    if (e.ctrlKey) mods.push("C");
    if (e.altKey) mods.push("A");
    if (e.metaKey) mods.push("M");
    if (base.length === 1 && mods.length) {
      // <C-d> / <C-S-d>: letters with modifiers are written lower-case.
      if (e.shiftKey && base.toLowerCase() !== base.toUpperCase()) mods.push("S");
      base = base.toLowerCase();
    } else if (base.length > 1 && e.shiftKey) {
      mods.push("S");
    }
    return format(mods, base);
  }

  function parseToken(inner) {
    const parts = inner.split("-");
    let base = parts.pop();
    if (base === "" && parts.length) base = "-"; // <C-->
    const mods = parts.map((m) => m.toUpperCase()).filter((m) => MOD_ORDER.includes(m));
    if (base.length > 1) {
      base = CANON[base.toLowerCase()] ?? (/^f\d{1,2}$/i.test(base) ? base.toUpperCase() : base);
    } else if (mods.some((m) => m !== "S")) {
      if (base !== base.toLowerCase() && !mods.includes("S")) mods.push("S");
      base = base.toLowerCase();
    }
    return format(mods, base);
  }

  function parseKeys(text) {
    const keys = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "<") {
        const end = text.indexOf(">", i + 2);
        if (end > i) {
          keys.push(parseToken(text.slice(i + 1, end)));
          i = end;
          continue;
        }
        keys.push("<lt>");
        continue;
      }
      keys.push(text[i] === " " ? "<Space>" : text[i]);
    }
    return keys;
  }

  // Elements where keys belong to the user's typing, not to Vim.
  const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "password", "tel", "number", "date", "datetime-local", "month", "time", "week"]);
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const name = el.localName;
    if (name === "textarea" || name === "select") return true;
    if (name === "input") return TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
    if (name === "moz-input-text" || name === "moz-input-search") return true;
    return el.ownerDocument?.designMode === "on";
  }

  // One key press against the bindings. `state` ({ buffer: [], count: "" })
  // is updated in place. Returns:
  //   { type: "run", binding, count }  a complete binding
  //   { type: "pending", display }     a count or the start of a sequence
  //   { type: "cancel" }               <Esc> dropped a pending sequence
  //   { type: "none" }                 not ours; let the key through
  function feedKey(state, key, config) {
    const clear = () => {
      state.buffer = [];
      state.count = "";
    };
    if (key === "<Esc>" && (state.buffer.length || state.count)) {
      clear();
      return { type: "cancel" };
    }
    if (/^[0-9]$/.test(key) && !state.buffer.length && (state.count || key !== "0") && !config.bindings[key]) {
      state.count += key;
      return { type: "pending", display: state.count };
    }
    state.buffer.push(key);
    const seq = state.buffer.join("");
    const binding = config.bindings[seq];
    if (binding) {
      const count = Number(state.count || 0);
      clear();
      return { type: "run", binding, count };
    }
    if (config.prefixes.includes(seq)) return { type: "pending", display: state.count + seq };
    // A key that ends a dead sequence gets a fresh look on its own ("g" then "j").
    const hadPending = state.buffer.length > 1;
    clear();
    return hadPending ? feedKey(state, key, config) : { type: "none" };
  }

  const PAGE_COMMANDS = [
    "scrolldown", "scrollup", "scrollleft", "scrollright", "halfpagedown", "halfpageup",
    "pagedown", "pageup", "scrolltop", "scrollbottom", "hint", "hinttab", "focusinput", "toggleignore",
  ];

  return { keyName, parseKeys, isEditable, feedKey, PAGE_COMMANDS };
})();
