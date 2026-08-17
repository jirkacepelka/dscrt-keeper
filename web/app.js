/**
 * The keeper console.
 *
 * Plain ES modules against the DOM. No framework, no bundler, no build step — the same
 * decision the keeper itself makes about its source, for the same reason: this page can set
 * a signing key, and what runs should be what you can read.
 *
 * The design comes from `globals.css`, copied verbatim from the dSCRT app, so almost
 * nothing here sets a style. Where an element needs a look, it gets a class the app already
 * defines. If you find yourself reaching for an inline colour, the class is missing rather
 * than the rule being wrong.
 */

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ fetch */

/**
 * Every request goes through here.
 *
 * Two things it does that matter: it turns the server's `{ error }` into a thrown `Error`
 * carrying the sentence the server wrote — those sentences are written to be shown — and it
 * treats a 401 as "the session ended", dropping straight back to the sign-in screen rather
 * than leaving a page of stale figures that quietly stops updating.
 */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
  });

  if (res.status === 401 && !path.startsWith("/api/login")) {
    showGate({ configured: true });
    throw new Error("Signed out.");
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

/* ------------------------------------------------------------------ toasts */

/**
 * The app's three kinds, and its timings.
 *
 * `pending` never dismisses itself — it is upgraded in place when the thing it describes
 * finishes. An error stays twice as long as a success because it is the one you might have
 * looked away from.
 */
const toasts = $("toasts");

function toast(kind, message) {
  const el = document.createElement("div");
  el.className = "toast";

  const icon = { pending: "clock", ok: "check", error: "alert" }[kind];
  const tint = { pending: "ink-quiet", ok: "ink-good", error: "ink-bad" }[kind];
  el.innerHTML = `<svg class="${tint}" width="16" height="16"><use href="#icon-${icon}"/></svg><span class="toast-body"></span>`;
  el.querySelector(".toast-body").textContent = message;
  toasts.append(el);

  const dismiss = () => el.remove();
  if (kind !== "pending") setTimeout(dismiss, kind === "error" ? 12_000 : 5_000);

  return {
    resolve(nextKind, nextMessage) {
      dismiss();
      toast(nextKind, nextMessage);
    },
    dismiss,
  };
}

/* ------------------------------------------------------------------ format */

const fromMicro = (u, places = 4) => (Number(u || 0) / 1e6).toFixed(places);

const shortAddress = (a) => (a && a.length > 18 ? `${a.slice(0, 11)}…${a.slice(-6)}` : a || "—");

/** Seconds, as the length of time a person would say out loud. */
function humanise(seconds) {
  const s = Math.max(0, seconds);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5_400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3_600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

const whenFrom = (ms) => (ms ? `${humanise((Date.now() - ms) / 1000)} ago` : "never");

/**
 * When a job next comes round, in words.
 *
 * Three cases rather than one. `null` means the job has no schedule at all — `sync` is only
 * a fallback — and an infinity means the schedule is waiting on the chain to publish a
 * deadline. A time already in the past means the job is due and has not run, which on a
 * keeper with no key is the ordinary state and must not render as "in 0s".
 */
function untilFrom(ms) {
  if (ms === null || ms === undefined) return "on demand";
  if (!Number.isFinite(ms)) return "when something falls due";
  return ms <= Date.now() ? "due now" : `in ${humanise((ms - Date.now()) / 1000)}`;
}

const explorerUrl = (chainId, hash) =>
  `${chainId === "secret-4" ? "https://ping.pub" : "https://testnet.ping.pub"}/secret/tx/${hash}`;

/** Set text without touching markup, so nothing user-shaped is ever parsed as HTML. */
function setText(el, value) {
  if (el) el.textContent = value;
}

function pill(el, kind, label) {
  el.hidden = false;
  el.className = `pill pill--${kind}`;
  el.querySelector("span:last-child").textContent = label;
}

/* ------------------------------------------------------------------ theme */

const themeButton = $("theme");

function paintThemeButton() {
  const light = document.documentElement.dataset.theme === "light";
  themeButton.innerHTML = `<svg width="16" height="16"><use href="#icon-${light ? "moon" : "sun"}"/></svg>`;
  themeButton.title = light ? "Switch to dark" : "Switch to light";
}

themeButton.addEventListener("click", () => {
  window.__keeperTheme.set(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  paintThemeButton();
});
paintThemeButton();

/* ------------------------------------------------------------------ the gate */

const gate = $("gate");
const gateForm = $("gate-form");
let firstRun = false;

function gateError(message) {
  const box = $("gate-error");
  box.hidden = !message;
  if (message) box.querySelector("span").textContent = message;
}

function showGate({ configured }) {
  firstRun = !configured;
  stopPolling();

  gate.hidden = false;
  $("tabs").hidden = true;
  $("logout").hidden = true;
  for (const id of ["tab-overview", "tab-history", "tab-settings"]) $(id).hidden = true;

  setText($("gate-eyebrow"), firstRun ? "First run" : "Sign in");
  setText($("gate-title"), firstRun ? "Choose a password" : "Keeper console");
  setText(
    $("gate-prose"),
    firstRun
      ? "There is no default password, because a shipped default is a published one and this guards a signing key. If you forget it, delete admin.json from the keeper's data directory — which only somebody with the machine can do."
      : "This console can change where the keeper points and replace its key, so it asks first.",
  );
  $("gate-confirm-field").hidden = !firstRun;
  setText($("gate-submit"), firstRun ? "Set password" : "Sign in");
  $("gate-password").setAttribute("autocomplete", firstRun ? "new-password" : "current-password");
  gateError(null);
  $("gate-password").focus();
}

function showConsole() {
  gate.hidden = true;
  $("tabs").hidden = false;
  $("logout").hidden = false;
  selectTab(currentTab);
  startPolling();
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("gate-password").value;
  gateError(null);

  try {
    if (firstRun) {
      if (password !== $("gate-confirm").value) {
        return gateError("Those two do not match.");
      }
      await post("/api/setup", { password });
    } else {
      await post("/api/login", { password });
    }
    $("gate-password").value = "";
    $("gate-confirm").value = "";
    showConsole();
  } catch (err) {
    gateError(err.message);
  }
});

$("logout").addEventListener("click", async () => {
  await post("/api/logout").catch(() => {});
  showGate({ configured: true });
});

/* ------------------------------------------------------------------ tabs */

let currentTab = "overview";

function selectTab(name) {
  currentTab = name;
  for (const button of document.querySelectorAll("#tabs .tab")) {
    const on = button.dataset.tab === name;
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const id of ["overview", "history", "settings"]) $(`tab-${id}`).hidden = id !== name;

  if (name === "history") void loadHistory(true);
  if (name === "settings") void loadSettings();
}

for (const button of document.querySelectorAll("#tabs .tab")) {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
}

/* ------------------------------------------------------------------ overview */

/** Copy for each job, in the words the app's upkeep page uses. Kept in step deliberately. */
const JOBS = {
  compound: {
    title: "Harvest and restake rewards",
    effect:
      "Withdraws them, takes the protocol's fee, and delegates the rest. This is what makes the exchange rate rise.",
  },
  "advance-window": {
    title: "Close the withdrawal window",
    effect:
      "Starts the unbonding clock for everyone in it. Until this runs, their three weeks have not begun.",
  },
  "collect-matured": {
    title: "Mark finished windows claimable",
    effect:
      "Books what came back so holders can claim it. Claims do this for themselves too, so this only helps people who have not asked yet.",
  },
  sync: {
    title: "Refresh the cached figures",
    effect:
      "Re-reads every delegation so the published rate is current. Compound already does this, so it is only here as a fallback.",
  },
};

let status = null;
let poll = null;
let running = false;

function startPolling() {
  void refreshStatus();
  if (poll === null) poll = setInterval(() => void refreshStatus(), 15_000);
}

function stopPolling() {
  if (poll !== null) clearInterval(poll);
  poll = null;
}

async function refreshStatus() {
  try {
    status = await api("/api/status");
  } catch {
    return; // A blip on a poll is not worth a toast every fifteen seconds.
  }
  renderStatus();
}

function renderStatus() {
  const s = status;
  if (!s) return;

  // Shown only off mainnet, exactly as the app's nav does it: a chain badge that is always
  // there stops being read, and the case worth noticing is "this is not the real network".
  $("net").hidden = s.chainId === "secret-4";
  setText($("net-chain"), s.chainId);

  setText(
    $("status-head"),
    s.lastPassAt === null ? "Reading the protocol…" : `Checked ${whenFrom(s.lastPassAt)}`,
  );

  const fresh = s.findings.find((f) => f.check === "freshness");
  if (fresh) {
    pill(
      $("attended"),
      fresh.severity === "ok" ? "good" : "warn",
      fresh.severity === "ok" ? "attended" : "unattended",
    );
  }

  // Address, and the honest version of not having one.
  const address = $("address");
  address.querySelector("span").textContent = shortAddress(s.address);
  address.disabled = !s.address;
  setText(
    $("address-note"),
    s.address
      ? `Signing on ${s.chainId}`
      : s.key.locked
        ? "Encrypted and locked — unlock it in Settings"
        : "No key yet — set one in Settings",
  );

  const gas = s.findings.find((f) => f.check === "keeper-gas");
  const balance = gas ? /([\d.]+)\s*SCRT/.exec(gas.detail) : null;
  $("gas").innerHTML = `${balance ? balance[1] : "—"}<span class="stat-unit">SCRT</span>`;
  setText($("gas-note"), gas ? gas.detail : "");

  setText($("spent-note"), `${s.summary.sent} sent, ${s.summary.failed} failed`);
  $("spent").innerHTML = `${fromMicro(s.summary.spentUscrt, 3)}<span class="stat-unit">SCRT</span>`;

  renderTasks(s);
  renderFindings(s.findings);
  renderKeyBanner(s.key);

  const up = humanise((Date.now() - s.startedAt) / 1000);
  setText($("uptime"), `dSCRT keeper · up ${up} · ${s.writable ? "" : "no volume · "}${s.contract.slice(0, 14)}…`);

  $("run-all").disabled = running || !s.key.configured || s.key.locked;
  setText(
    $("run-hint"),
    !s.key.configured
      ? "No key configured, so nothing can be sent."
      : s.key.locked
        ? "The key is locked."
        : `Costs about ${fromMicro(s.compoundFeeUscrt, 4)} SCRT in gas.`,
  );
}

function renderTasks(s) {
  const host = $("tasks");
  host.replaceChildren();

  for (const task of s.tasks) {
    const meta = JOBS[task.task];
    const row = document.createElement("div");
    row.className = "well task";

    const failed = Boolean(task.error);
    row.innerHTML = `
      <span class="task-mark ${failed ? "ink-bad" : "ink-quiet"}">
        <svg width="16" height="16"><use href="#icon-${failed ? "alert" : "check"}"/></svg>
      </span>
      <div class="task-body">
        <div class="row">
          <span class="h3"></span>
          <span class="hint task-when"></span>
        </div>
        <p class="hint"></p>
        <p class="hint task-effect"></p>
      </div>
      <button class="mini task-mark" type="button">Run</button>`;

    row.querySelector(".h3").textContent = meta.title;
    row.querySelector(".task-when").textContent =
      s.key.configured && !s.key.locked ? untilFrom(task.nextDue) : "waiting for a key";
    row.querySelectorAll("p.hint")[0].textContent =
      task.detail ?? "Not run yet in this process.";
    row.querySelectorAll("p.hint")[1].textContent = meta.effect;

    const button = row.querySelector("button");
    button.disabled = running || !s.key.configured || s.key.locked;
    button.addEventListener("click", () => void runTask(task.task));

    host.append(row);
  }
}

function renderFindings(findings) {
  const host = $("findings");
  host.replaceChildren();

  for (const f of findings) {
    const kind = f.severity === "ok" ? "good" : f.severity === "warn" ? "warn" : "bad";
    const el = document.createElement("div");
    el.className = `notice notice--${kind}`;
    el.innerHTML = `<svg width="16" height="16"><use href="#icon-${
      f.severity === "ok" ? "check" : "alert"
    }"/></svg><span><strong></strong> <span></span></span>`;
    el.querySelector("strong").textContent = f.check;
    el.querySelector("span span").textContent = f.detail;
    host.append(el);
  }
}

async function runTask(name) {
  running = true;
  renderStatus();
  const pending = toast("pending", `Running ${name}…`);

  try {
    const result = await post("/api/run", { task: name });
    if (result.error) pending.resolve("error", `${name}: ${result.error}`);
    else if (result.txs.length > 0) {
      pending.resolve("ok", `${result.detail} — ${result.txs.length} transaction(s).`);
    } else pending.resolve("ok", result.detail);
  } catch (e) {
    pending.resolve("error", e.message);
  } finally {
    running = false;
    await refreshStatus();
    if (currentTab === "history") void loadHistory(true);
  }
}

/**
 * Windows first, then compound.
 *
 * The order the loop uses, and it matters: closing a window and collecting a matured one
 * both change what a compound will find, so running compound first would harvest against
 * figures that are about to move. `sync` is not in the sequence because compound already
 * does everything it did.
 */
$("run-all").addEventListener("click", async () => {
  for (const task of ["advance-window", "collect-matured", "compound"]) {
    await runTask(task);
  }
});

$("address").addEventListener("click", async () => {
  if (!status?.address) return;
  try {
    await navigator.clipboard.writeText(status.address);
    toast("ok", "Address copied.");
  } catch {
    toast("error", "The browser would not let the page copy that.");
  }
});

/* ------------------------------------------------------------------ history */

let historyOffset = 0;
let historyFilter = "";

async function loadHistory(reset) {
  if (reset) historyOffset = 0;

  const params = new URLSearchParams({ limit: "50", offset: String(historyOffset) });
  if (historyFilter === "failed") params.set("outcome", "failed");
  else if (historyFilter) params.set("task", historyFilter);

  let page;
  try {
    page = await api(`/api/history?${params}`);
  } catch (e) {
    return void toast("error", e.message);
  }

  const rows = $("history-rows");
  if (reset) rows.replaceChildren();

  for (const entry of page.entries) rows.append(historyRow(entry, page.chainId));

  historyOffset += page.entries.length;
  $("history-empty").hidden = historyOffset > 0;
  $("history-more").hidden = historyOffset >= page.total;
  setText(
    $("history-count"),
    page.total === 0
      ? ""
      : `${page.total} entr${page.total === 1 ? "y" : "ies"} · ${fromMicro(page.summary.spentUscrt, 3)} SCRT spent`,
  );
}

function historyRow(entry, chainId) {
  const tr = document.createElement("tr");
  const at = new Date(entry.ts);

  const when = document.createElement("td");
  when.className = "mono";
  when.textContent = at.toLocaleString();
  when.title = entry.ts;

  const job = document.createElement("td");
  job.className = "tag";
  job.textContent = entry.task;

  const what = document.createElement("td");
  what.textContent = entry.error ? entry.error : entry.detail;
  if (entry.error) what.className = "ink-bad";

  const tx = document.createElement("td");
  if (entry.txHash) {
    const link = document.createElement("a");
    link.className = "link mono";
    link.href = explorerUrl(chainId, entry.txHash);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${entry.txHash.slice(0, 10)}…`;
    link.title = entry.txHash;
    tx.append(link);
  } else {
    tx.className = "faint";
    tx.textContent = entry.kind === "event" ? "—" : "not sent";
  }

  const fee = document.createElement("td");
  fee.className = "num";
  fee.textContent = entry.feeUscrt ? fromMicro(entry.feeUscrt, 4) : "—";

  tr.append(when, job, what, tx, fee);
  return tr;
}

for (const button of document.querySelectorAll("#history-filter button")) {
  button.addEventListener("click", () => {
    historyFilter = button.dataset.filter;
    for (const other of document.querySelectorAll("#history-filter button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    void loadHistory(true);
  });
}

$("history-more").addEventListener("click", () => void loadHistory(false));

/* ------------------------------------------------------------------ settings */

const SETTING_FIELDS = {
  chainId: "chainId",
  lcdUrl: "lcdUrl",
  contract: "contract",
  contractCodeHash: "contractCodeHash",
  gasPrice: "gasPrice",
  pageLimit: "pageLimit",
  compoundIntervalMs: "compoundInterval",
  windowIntervalMs: "windowInterval",
};

let settings = null;

async function loadSettings() {
  try {
    const [config, wallet] = await Promise.all([api("/api/settings"), api("/api/wallet")]);
    settings = config;
    renderSettings(config);
    renderWallet(wallet);
  } catch (e) {
    toast("error", e.message);
  }
}

function renderSettings(config) {
  $("not-writable").hidden = config.writable;

  for (const [key, id] of Object.entries(SETTING_FIELDS)) {
    const input = $(id);
    if (!input) continue;

    input.value =
      key === "compoundIntervalMs"
        ? config.settings.compoundInterval
        : key === "windowIntervalMs"
          ? config.settings.windowInterval
          : String(config.settings[key] ?? "");

    /*
     * A field the environment owns is shown and disabled.
     *
     * Hiding it would be worse — the value is real and the operator should be able to see
     * what the keeper is actually using — but an editable box whose contents are ignored is
     * the single most dishonest thing a settings screen can contain.
     */
    const pinned = config.provenance[key] === "env";
    const field = document.querySelector(`[data-setting="${key}"]`);
    input.disabled = pinned || !config.writable;
    if (field) {
      field.classList.toggle("field--pinned", pinned);
      const note = field.querySelector(".field-note");
      if (note && !note.textContent.trim()) {
        note.textContent = pinned ? "Set by the environment, so it cannot be changed here." : "";
      } else if (note && pinned) {
        note.textContent = `Set by the environment, so it cannot be changed here. ${note.textContent}`;
      }
    }
  }

  $("compoundFloor").value = config.settings.compoundFloor
    ? String(config.settings.compoundFloor / 1e6)
    : "";

  paintCadence(config.settings.compoundInterval);
}

/** Highlight the preset that matches, and price it. */
function paintCadence(value) {
  for (const button of document.querySelectorAll("#cadence button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }

  const ms = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 }[value];
  const perCompound = status?.compoundFeeUscrt ?? 0;

  if (!ms || !perCompound) {
    setText($("cadence-cost"), "—");
    setText($("cadence-staleness"), value || "—");
    return;
  }

  const runsPerMonth = (30 * 24 * 3_600_000) / ms;
  setText(
    $("cadence-cost"),
    `≈ ${((perCompound * runsPerMonth) / 1e6).toFixed(2)} SCRT a month`,
  );
  setText($("cadence-staleness"), humanise(ms / 1000));
}

for (const button of document.querySelectorAll("#cadence button")) {
  button.addEventListener("click", () => {
    $("compoundInterval").value = button.dataset.value;
    paintCadence(button.dataset.value);
  });
}

$("compoundInterval").addEventListener("input", (e) => paintCadence(e.target.value.trim()));

$("save-cadence").addEventListener("click", async () => {
  const floor = $("compoundFloor").value.trim();
  await saveSettings({
    compoundInterval: $("compoundInterval").value.trim(),
    compoundFloor: floor === "" ? 0 : Math.round(Number(floor) * 1e6),
  });
});

$("chain-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = {};
  for (const [key, id] of Object.entries(SETTING_FIELDS)) {
    const input = $(id);
    if (!input || input.disabled) continue;
    if (key === "compoundIntervalMs") continue; // Owned by the cadence panel.
    if (key === "windowIntervalMs") patch.windowInterval = input.value.trim();
    else patch[key] = key === "pageLimit" ? Number(input.value) : input.value.trim();
  }
  await saveSettings(patch);
});

async function saveSettings(patch) {
  const pending = toast("pending", "Saving…");
  try {
    await post("/api/settings", patch);
    pending.resolve("ok", "Saved. The keeper picked it up without restarting.");
    await loadSettings();
    await refreshStatus();
  } catch (e) {
    pending.resolve("error", e.message);
  }
}

$("probe").addEventListener("click", async () => {
  const note = $("probe-result");
  note.textContent = "Asking…";
  try {
    const health = await post("/api/endpoint/check", {
      url: $("lcdUrl").value,
      chainId: $("chainId").value,
    });
    note.textContent = health.ok
      ? `${health.latencyMs} ms · ${health.chainId} · block ${health.height}`
      : `Not usable: ${health.error}`;
    note.className = `field-note ${health.ok ? "ink-good" : "ink-bad"}`;
  } catch (e) {
    note.textContent = e.message;
    note.className = "field-note ink-bad";
  }
});

/* ------------------------------------------------------------------ the key */

function renderWallet(wallet) {
  const kind = !wallet.configured ? "warn" : wallet.locked ? "warn" : "good";
  const label = !wallet.configured
    ? "not set"
    : wallet.locked
      ? "locked"
      : wallet.source === "env"
        ? "from the environment"
        : wallet.source === "encrypted"
          ? "encrypted"
          : "stored";
  pill($("key-pill"), kind, label);

  setText(
    $("mnemonic-note"),
    !wallet.editable
      ? "KEEPER_MNEMONIC is set in the environment and takes precedence. Remove it from the compose file before setting one here."
      : wallet.configured
        ? `Configured, signing as ${wallet.address ?? "an address that could not be derived"}. Enter a new phrase to replace it — the stored one is never shown.`
        : "Nothing stored yet. The keeper is reading the protocol but cannot sign.",
  );

  $("mnemonic").disabled = !wallet.editable;
  $("passphrase").disabled = !wallet.editable;
  $("save-key").disabled = !wallet.editable;
  $("forget-key").hidden = !wallet.configured || !wallet.editable;
  $("unlock-form").hidden = !wallet.locked;
  renderKeyBanner(wallet);
}

/**
 * A keeper that cannot sign, said at the top of the first screen.
 *
 * Driven from the status poll rather than from the settings tab, because the operator who
 * most needs to read it is the one who has just installed this and has not opened Settings
 * yet. On the overview it is the difference between "quiet because nothing is due" and
 * "quiet because it cannot do anything".
 */
function renderKeyBanner(key) {
  const banner = $("key-state");
  banner.hidden = key.configured && !key.locked;
  if (banner.hidden) return;

  banner.innerHTML = `<div class="notice notice--warn"><svg width="16" height="16"><use href="#icon-wallet"/></svg><span></span></div>`;
  banner.querySelector("span").textContent = key.locked
    ? "The stored key is encrypted and locked. The keeper is reading the protocol but not signing — unlock it in Settings, or set KEEPER_PASSPHRASE in the container's environment."
    : "No key is configured. The keeper is reading the protocol but not signing — set a recovery phrase in Settings.";
}

$("wallet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mnemonic = $("mnemonic").value.trim();
  if (!mnemonic) return void toast("error", "Enter a recovery phrase.");

  const pending = toast("pending", "Storing the key…");
  try {
    const wallet = await post("/api/wallet", {
      mnemonic,
      passphrase: $("passphrase").value || undefined,
    });
    // Cleared immediately. There is no reason for a seed phrase to sit in a DOM node after
    // the request that needed it has returned.
    $("mnemonic").value = "";
    $("passphrase").value = "";
    pending.resolve("ok", `Signing as ${wallet.address}.`);
    renderWallet(wallet);
    await refreshStatus();
  } catch (err) {
    pending.resolve("error", err.message);
  }
});

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pending = toast("pending", "Unlocking…");
  try {
    const wallet = await post("/api/wallet/unlock", {
      passphrase: $("unlock-passphrase").value,
    });
    $("unlock-passphrase").value = "";
    pending.resolve("ok", `Unlocked. Signing as ${wallet.address}.`);
    renderWallet(wallet);
    await refreshStatus();
  } catch (err) {
    pending.resolve("error", err.message);
  }
});

$("forget-key").addEventListener("click", async () => {
  const pending = toast("pending", "Removing the key…");
  try {
    renderWallet(await api("/api/wallet", { method: "DELETE" }));
    pending.resolve("ok", "Key removed. The keeper is reading but not signing.");
    await refreshStatus();
  } catch (e) {
    pending.resolve("error", e.message);
  }
});

$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pending = toast("pending", "Changing the password…");
  try {
    await post("/api/password", {
      current: $("current-password").value,
      password: $("new-password").value,
    });
    $("current-password").value = "";
    $("new-password").value = "";
    pending.resolve("ok", "Changed. Every other session was signed out.");
  } catch (err) {
    pending.resolve("error", err.message);
  }
});

/* ------------------------------------------------------------------ start */

try {
  const session = await api("/api/session");
  if (session.authenticated) showConsole();
  else showGate(session);
} catch {
  document.body.innerHTML =
    '<div class="centred"><p class="prose">The keeper is not answering. Check that the container is running.</p></div>';
}
