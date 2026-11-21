// Entry point for the profile's JavaScript. The autoconfig stub in the
// Firefox folder (firefox/config.js in this repo) registers
// chrome/js/chrome.manifest as resource://profile-js/ and imports this module
// once per browser start.
//
// Vim keys:
//   - chrome/vimrc is parsed (vim/config.sys.mjs) and shared with every
//     process as sharedData "vim:config"; re-read whenever the file changes.
//   - vim/keys.js + vim/content.js run in every process as a process script
//     and handle keys inside pages.
//   - Keys pressed while focus is in the browser window itself (not a page or
//     a text field) are handled here with the same bindings.
//   - Browser-level commands live in vim/commands.sys.mjs.

import { applyLine, parseConfig } from "resource://profile-js/vim/config.sys.mjs";
import { ALIASES, COMMANDS } from "resource://profile-js/vim/commands.sys.mjs";
import { showCmdline, showHelp } from "resource://profile-js/vim/ui.sys.mjs";
import { clearTimeout, setInterval, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { AddonManager } from "resource://gre/modules/AddonManager.sys.mjs";
import { applyLayoutOnce, newAddonsGoToTray } from "resource://profile-js/toolbar.sys.mjs";

const CHROME_DIR = Services.dirsvc.get("UChrm", Ci.nsIFile).path;
const VIM_DIR = PathUtils.join(CHROME_DIR, "js", "vim");
const USER_VIMRC = PathUtils.join(CHROME_DIR, "vimrc"); // the user's; never overwritten
const DEFAULTS_VIMRC = PathUtils.join(VIM_DIR, "defaults.vimrc"); // shipped defaults

const keysScope = {};
Services.scriptloader.loadSubScript("resource://profile-js/vim/keys.js", keysScope);
const { VimKeys } = keysScope;
const PAGE_COMMANDS = new Set(VimKeys.PAGE_COMMANDS);

// --- config ----------------------------------------------------------------
// Built-in defaults, then the user's chrome/vimrc, then :set/:bind/:unbind
// typed this session (kept until the browser restarts).
let config = { bindings: {}, prefixes: [], settings: {}, errors: [] };
let configStamp = "";
const sessionLines = [];

// Startup reads are synchronous on purpose: this module runs before any page
// loads, and pages that load before the page script is registered (restored
// tabs, a URL passed on the command line) would otherwise miss the keys.
function readSync(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  if (!file.exists()) return "";
  const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
  stream.init(file, 0x01, 0, 0);
  try {
    return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
  } finally {
    stream.close();
  }
}

function share() {
  Services.ppmm.sharedData.set("vim:config", {
    bindings: config.bindings,
    prefixes: config.prefixes,
    settings: config.settings,
  });
  Services.ppmm.sharedData.flush();
}

function loadConfig() {
  config = parseConfig(
    [
      { name: "defaults.vimrc", text: readSync(DEFAULTS_VIMRC) },
      { name: "vimrc", text: readSync(USER_VIMRC) },
      { name: "this session", text: sessionLines.join("\n") },
    ],
    VimKeys
  );
  for (const err of config.errors) console.warn(`vim: ${err}`);
  share();
  if (config.errors.length) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      showStatus(win, `config: ${config.errors[0]}`, true);
    }
  }
}

async function checkConfig() {
  const stamp = [];
  for (const path of [DEFAULTS_VIMRC, USER_VIMRC]) {
    try {
      stamp.push((await IOUtils.stat(path)).lastModified);
    } catch {
      stamp.push(0);
    }
  }
  if (stamp.join() !== configStamp) {
    configStamp = stamp.join();
    loadConfig();
  }
}

// :set / :bind / :unbind — apply for this session only.
function sessionDirective(win, line) {
  const probe = { bindings: {}, settings: {}, errors: [] };
  applyLine(probe, line, "command", VimKeys);
  if (probe.errors.length) return probe.errors[0];
  sessionLines.push(line);
  loadConfig();
  return `${line.split(/\s+/)[0]}: done (this session; :config to keep it)`;
}

// Open the user's vimrc in an editor: `set editor <program> [args]`, else the
// system's handler (Notepad on Windows, since the file has no extension).
function findProgram(name) {
  const candidates = [];
  if (PathUtils.isAbsolute(name)) candidates.push(name);
  else {
    const win = Services.appinfo.OS === "WINNT";
    const exts = win ? ["", ...(Services.env.get("PATHEXT") || ".EXE;.CMD;.BAT").split(";")] : [""];
    for (const dir of Services.env.get("PATH").split(win ? ";" : ":").filter(Boolean)) {
      for (const ext of exts) candidates.push(PathUtils.join(dir, name + ext.toLowerCase()));
    }
  }
  for (const path of candidates) {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    try {
      f.initWithPath(path);
      if (f.exists() && f.isFile()) return f;
    } catch {}
  }
  return null;
}

async function openConfig() {
  if (!(await IOUtils.exists(USER_VIMRC))) {
    await IOUtils.writeUTF8(USER_VIMRC, '" Your Vim key config: bind <keys> <command>, unbind <keys>, set <name> <value>.\n');
  }
  const [program, ...args] = (config.settings.editor ?? (Services.appinfo.OS === "WINNT" ? "notepad" : "")).split(/\s+/).filter(Boolean);
  if (program) {
    const exe = findProgram(program);
    if (!exe) return `editor not found: ${program}`;
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(exe);
    proc.runw(false, [...args, USER_VIMRC], args.length + 1);
    return `opened ${PathUtils.filename(USER_VIMRC)} in ${program}`;
  }
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(USER_VIMRC);
  file.launch();
  return "opened config";
}

// Commands that need this module's state (config, UI).
const META = {
  help: (win) => showHelp(win, { config, userConfig: USER_VIMRC, defaultsConfig: DEFAULTS_VIMRC }),
  // `bind t cmdline tabopen` opens the line pre-filled with "tabopen ".
  cmdline: (win, n, args) => showCmdline(win, { run: (line) => runLine(win, line), initial: args.length ? args.join(" ") + " " : "" }),
  config: (win) => {
    openConfig().then((msg) => showStatus(win, msg, true), (e) => showStatus(win, `config: ${e.message}`, true));
  },
  source: (win) => {
    loadConfig();
    showStatus(win, config.errors.length ? `config: ${config.errors[0]}` : "config re-read", true);
  },
  set: (win, n, args) => sessionDirective(win, ["set", ...args].join(" ")),
  bind: (win, n, args) => sessionDirective(win, ["bind", ...args].join(" ")),
  unbind: (win, n, args) => sessionDirective(win, ["unbind", ...args].join(" ")),
};

// A line typed on the : command line, e.g. "tabopen github.com" or "5 scrolldown".
function runLine(win, line) {
  let [name, ...args] = line.replace(/^:/, "").trim().split(/\s+/);
  let count = 0;
  if (/^\d+$/.test(name) && args.length) {
    count = Number(name);
    [name, ...args] = args;
  }
  runCommand(win, ALIASES[name] ?? name, args, count);
}

// --- page script -------------------------------------------------------------
function loadPageScript() {
  const keys = readSync(PathUtils.join(VIM_DIR, "keys.js"));
  const content = readSync(PathUtils.join(VIM_DIR, "content.js"));
  const source = `(function () {\n${keys}\n${content}\n})();`;
  Services.ppmm.loadProcessScript("data:text/javascript;charset=utf-8," + encodeURIComponent(source), true);
}

// Pages already open when the page script arrives (or that loaded in a race
// with it) get attached too: every process looks up the tabs it is showing.
function attachExistingPages() {
  const browserIds = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const tab of win.gBrowser?.tabs ?? []) browserIds.push(tab.linkedBrowser.browserId);
  }
  Services.ppmm.broadcastAsyncMessage("Vim:AttachExisting", { browserIds });
}

// --- status display (sidebar footer) ----------------------------------------
const tabStatus = new WeakMap(); // <browser> -> text the page last reported

function showStatus(win, text, transient = false) {
  const el = win.document.getElementById("vim-status");
  if (!el) return;
  el.textContent = text ?? "";
  el.toggleAttribute("active", !!text);
  clearTimeout(win.__vimStatusTimer);
  if (transient && text) {
    win.__vimStatusTimer = setTimeout(() => showStatus(win, tabStatus.get(win.gBrowser.selectedBrowser) ?? ""), 1500);
  }
}

// --- running commands ------------------------------------------------------------
function runCommand(win, cmd, args = [], count = 0, principal = null) {
  const fn = META[cmd] ?? COMMANDS[cmd];
  if (fn) {
    const msg = fn(win, count, args, principal);
    if (msg) showStatus(win, msg, true);
    return;
  }
  if (PAGE_COMMANDS.has(cmd)) {
    const browser = win.gBrowser.selectedBrowser;
    browser.focus();
    Services.ppmm.broadcastAsyncMessage("Vim:Run", { bcId: browser.browsingContext.id, cmd, args, count });
    return;
  }
  showStatus(win, `unknown command: ${cmd}`, true);
}

// (Element.ownerGlobal is undefined for these elements in Firefox 160; use the document.)
const windowOf = (el) => el?.ownerDocument?.defaultView ?? null;

function browserFor(bcId) {
  const browser = BrowsingContext.get(bcId)?.top?.embedderElement;
  return windowOf(browser)?.gBrowser ? browser : null;
}

// Messages from page processes. Those processes run untrusted web content,
// so a command is only carried out if it is one of the user's own bindings
// (exactly as bound) — never e.g. :set editor followed by :config. The one
// extra is opentab from link hints, limited to http(s) links and opened with
// the page's own permissions.
function isBound(cmd, args) {
  const want = JSON.stringify([cmd, ...(Array.isArray(args) ? args : [])]);
  return Object.values(config.bindings).some((b) => JSON.stringify([b.cmd, ...b.args]) === want);
}

const pageMessages = {
  receiveMessage(msg) {
    const browser = browserFor(msg.data?.bcId);
    if (!browser) return;
    const win = windowOf(browser);
    if (msg.name === "Vim:Command") {
      const { cmd, args, count } = msg.data;
      const fromHint = cmd === "opentab" && Array.isArray(args) && args.length <= 2 && typeof args[0] === "string";
      if (!fromHint && !isBound(cmd, args)) return;
      const principal = fromHint ? BrowsingContext.get(msg.data.bcId)?.currentWindowGlobal?.documentPrincipal : null;
      try {
        runCommand(win, cmd, fromHint ? args : [...args], Math.min(Math.max(Number(count) || 0, 0), 999), principal);
      } catch (e) {
        console.error(`vim: ${cmd} failed`, e);
      }
    } else if (msg.name === "Vim:Status") {
      const text = String(msg.data.text ?? "").slice(0, 60);
      tabStatus.set(browser, text);
      if (browser === win.gBrowser.selectedBrowser) showStatus(win, text);
    }
  },
};

// --- keys pressed in the browser window itself --------------------------------
function onChromeKey(win, e) {
  if (!e.isTrusted) return;
  const target = e.composedTarget ?? e.originalTarget ?? e.target;
  // Keys typed in a page are handled by the page script; the help panel and
  // command line handle their own.
  if (!target || windowOf(target) !== win || target.localName === "browser") return;
  if (target.closest?.("#vim-help, #vim-cmdline")) return;
  const key = VimKeys.keyName(e);
  if (!key) return;
  const st = (win.__vim ??= { buffer: [], count: "", timer: null });

  if (VimKeys.isEditable(target) || target.closest?.("#urlbar, findbar")) {
    // <Esc> in an idle address bar goes back to the page, like leaving insert mode.
    if (key === "<Esc>" && target.closest?.("#urlbar") && !win.gURLBar.view.isOpen) {
      setTimeout(() => win.gBrowser.selectedBrowser.focus(), 0);
    }
    return;
  }
  if (win.document.querySelector("menupopup[open], panel[panelopen]")) return;

  const wasPending = st.buffer.length > 0 || st.count !== "";
  const result = VimKeys.feedKey(st, key, config);
  clearTimeout(st.timer);
  if (result.type === "none") {
    if (wasPending) showStatus(win, "");
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (result.type === "pending") {
    showStatus(win, result.display);
    st.timer = setTimeout(() => {
      st.buffer = [];
      st.count = "";
      showStatus(win, "");
    }, Number(config.settings.timeout ?? 1500));
    return;
  }
  showStatus(win, "");
  if (result.type === "run") runCommand(win, result.binding.cmd, result.binding.args, result.count);
}

let toolbarReady = false;
function setUpToolbar(win) {
  if (toolbarReady) return;
  toolbarReady = true;
  try {
    applyLayoutOnce(win.CustomizableUI);
    newAddonsGoToTray(win.CustomizableUI, AddonManager, setTimeout);
  } catch (e) {
    console.error("vimfox: toolbar setup failed", e);
  }
}

function setUpWindow(win) {
  if (win.__vimReady || !win.gBrowser) return;
  win.__vimReady = true;
  setUpToolbar(win);
  const status = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  status.id = "vim-status";
  win.document.getElementById("browser")?.append(status);
  win.addEventListener("keydown", (e) => onChromeKey(win, e), true);
  win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
    showStatus(win, tabStatus.get(win.gBrowser.selectedBrowser) ?? "");
    keepFocusOnNewTabPage(win);
  });
  win.gBrowser.tabContainer.addEventListener("TabOpen", () => keepFocusOnNewTabPage(win));
}

// Firefox puts the cursor in the address bar on a new tab, so keys like d
// would be typed there. Give focus back to the page (o or Ctrl+L still go to
// the address bar). Checked a few times because Firefox focuses it a little
// after the tab appears.
const NEW_TAB_PAGES = new Set(["about:newtab", "about:home", "about:blank", "about:privatebrowsing"]);
function keepFocusOnNewTabPage(win) {
  for (const delay of [0, 60, 250, 600]) {
    setTimeout(() => {
      const browser = win.gBrowser.selectedBrowser;
      if (NEW_TAB_PAGES.has(browser.currentURI.spec) && win.gURLBar.focused && !win.gURLBar.value) {
        browser.focus();
      }
    }, delay);
  }
}

// --- start -------------------------------------------------------------------
function start() {
  loadConfig();
  loadPageScript();
  Services.ppmm.addMessageListener("Vim:Command", pageMessages);
  Services.ppmm.addMessageListener("Vim:Status", pageMessages);
  Services.obs.addObserver((win) => {
    setUpWindow(win);
    attachExistingPages();
  }, "browser-delayed-startup-finished");
  for (const win of Services.wm.getEnumerator("navigator:browser")) setUpWindow(win);
  attachExistingPages();
  checkConfig();
  setInterval(checkConfig, 1000);
}

try {
  start();
} catch (e) {
  console.error("vim: failed to start", e);
}
