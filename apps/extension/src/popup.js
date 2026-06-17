/**
 * Harpe popup / side-panel UI.
 *
 * Flow:
 *   1. On load, ask the background to scan the active tab.
 *   2. Render results as a thumbnail grid with dimension badges.
 *   3. User clicks thumbnails to toggle selection; "Select all" / "Clear" helpers.
 *   4. "Grab N" sends selected URLs + page URL to background → native host → harpe.
 *   5. Show per-image result (tick/cross) after the download finishes.
 */

"use strict";

// ── State ────────────────────────────────────────────────────────────────────

let scanResult = null; // { images, pageUrl, pageTitle }
let selected = new Set(); // Set<url string>
let tabId = null;
let grabInProgress = false;
// Per-type save folders. `img/vid/aud` are engine paths (blank = engine
// default); `sub` is the built-in Downloads subfolder. Defaults are filled in
// from the host's ping reply so the UI shows real paths as placeholders.
let settings = { img: "", vid: "", aud: "", sub: "", group: "site" };
let engineDefaults = {
  image: "~/Pictures/harpe",
  video: "~/Videos/harpe",
  audio: "~/Music/harpe",
};
let engineAvailable = false; // true once the native helper answers a ping

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $status = document.getElementById("status");
const $grid = document.getElementById("grid");
const $btnSelectAll = document.getElementById("btn-select-all");
const $btnClear = document.getElementById("btn-clear");
const $btnGrab = document.getElementById("btn-grab");
const $btnRescan = document.getElementById("btn-rescan");
const $pageTitle = document.getElementById("page-title");
const $count = document.getElementById("count");
const $hostHint = document.getElementById("host-hint");
const $savedBar = document.getElementById("saved-bar");
const $savedText = document.getElementById("saved-text");
const $btnOpenFolder = document.getElementById("btn-open-folder");

// Remembers where the last grab landed so "Open folder" knows what to reveal.
// Engine downloads carry an absolute path; built-in downloads carry a chrome
// download id (chrome.downloads.show needs the id, not the path).
let lastSaved = null; // { path } | { downloadId }

function dirOf(p) {
  const i = Math.max(String(p).lastIndexOf("/"), String(p).lastIndexOf("\\"));
  return i > 0 ? String(p).slice(0, i) : String(p);
}

function showSaved(results) {
  $savedBar.hidden = true;
  lastSaved = null;
  const ok = (results || []).filter((r) => r.ok && (r.path || r.id !== undefined));
  if (!ok.length) return;
  const first = ok[0];
  if (typeof first.path === "string" && first.path.startsWith("/")) {
    // Engine: absolute path → show its folder.
    const dir = dirOf(first.path);
    lastSaved = { path: first.path };
    $savedText.textContent = "Saved to " + dir;
    $savedText.title = dir;
  } else if (first.id !== undefined) {
    // Built-in: relative path under Downloads.
    lastSaved = { downloadId: first.id };
    $savedText.textContent = "Saved to Downloads/" + dirOf(first.path || "");
    $savedText.title = first.path || "";
  } else {
    return;
  }
  $savedBar.hidden = false;
}

async function openSavedFolder() {
  if (!lastSaved) return;
  $btnOpenFolder.disabled = true;
  try {
    let resp;
    if (lastSaved.path) {
      resp = await chrome.runtime.sendMessage({ type: "HARPE_OPEN", path: lastSaved.path });
    } else if (lastSaved.downloadId !== undefined) {
      resp = await chrome.runtime.sendMessage({ type: "HARPE_OPEN_DOWNLOAD", id: lastSaved.downloadId });
    }
    if (resp && resp.ok === false) {
      const where = lastSaved.path ? dirOf(lastSaved.path) : "your Downloads folder";
      setStatus(`Couldn't open the folder automatically — it's at ${where}`, "warn");
    }
  } catch (e) {
    const where = lastSaved.path ? dirOf(lastSaved.path) : "your Downloads folder";
    setStatus(`Couldn't open the folder (${e.message}) — it's at ${where}`, "warn");
  } finally {
    $btnOpenFolder.disabled = false;
  }
}

// A grab error means the native helper is missing/unreachable when the message
// mentions the host or the connection (vs. a normal per-image download failure).
function looksLikeHostError(msg) {
  return /native (messaging )?host|not found|connect to native|disconnected|host not|No such file/i.test(
    String(msg || "")
  );
}
const $btnSettings = document.getElementById("btn-settings");
const $settings = document.getElementById("settings");
const $destImg = document.getElementById("dest-img");
const $destVid = document.getElementById("dest-vid");
const $destAud = document.getElementById("dest-aud");
const $rowVid = document.getElementById("row-vid");
const $rowAud = document.getElementById("row-aud");
const $lblImg = document.getElementById("lbl-img");
const $settingsHelp = document.getElementById("settings-help");
const $modeLine = document.getElementById("mode-line");
const $btnSaveSettings = document.getElementById("btn-save-settings");
const $settingsStatus = document.getElementById("settings-status");
const $btnEnableEngine = document.getElementById("btn-enable-engine");
const $group = document.getElementById("group");
const $rowGroup = document.getElementById("row-group");
const $browseButtons = document.querySelectorAll(".btn-browse");

let nativePermGranted = false; // optional nativeMessaging permission state
let enginePinnedOn = false;    // a successful engine grab proves it works — a
                               // later slow ping must not downgrade the UI

function hasNativePerm() {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ permissions: ["nativeMessaging"] }, (g) =>
        resolve(!!g && !chrome.runtime.lastError)
      );
    } catch {
      resolve(false);
    }
  });
}

// Requesting an optional permission must happen from a user gesture (this is
// wired to the "Enable Harpe engine" button click).
async function enableEngine() {
  $btnEnableEngine.disabled = true;
  try {
    nativePermGranted = await new Promise((resolve) => {
      chrome.permissions.request({ permissions: ["nativeMessaging"] }, (g) =>
        resolve(!!g && !chrome.runtime.lastError)
      );
    });
  } catch {
    nativePermGranted = false;
  }
  $btnEnableEngine.disabled = false;
  if (nativePermGranted) await detectEngine();
  else applyMode();
}

// "Browse…" → ask the engine host to open a native folder chooser, fill the field.
async function browseFor(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: "HARPE_PICK", start: input.value || "" });
    if (r && r.ok && r.path) input.value = r.path;
    else if (r && r.ok === false && r.error && r.error !== "host timed out") {
      setStatus("Folder picker unavailable — type the path instead", "warn");
    }
  } catch { /* ignore */ }
}

// ── Settings (per-type save folders; engine vs built-in is auto-detected) ──────

// The extension uses the Harpe engine automatically when the local helper is
// installed (save anywhere + video/audio); otherwise it downloads in-browser to
// the Downloads folder (images only). No toggle — it uses the best available.
function applyMode() {
  // The engine is opt-in: nativeMessaging is requested only when the user
  // clicks "Enable Harpe engine", so the base install asks for fewer perms.
  $btnEnableEngine.hidden = nativePermGranted;
  if (engineAvailable) {
    $modeLine.textContent = "✓ Harpe engine connected — full power";
    $modeLine.className = "mode-line ok";
    $rowVid.classList.remove("hidden");
    $rowAud.classList.remove("hidden");
    $lblImg.textContent = "Images";
    $destImg.placeholder = engineDefaults.image;
    $destVid.placeholder = engineDefaults.video;
    $destAud.placeholder = engineDefaults.audio;
    $destImg.value = settings.img;
    $destVid.value = settings.vid;
    $destAud.value = settings.aud;
    $rowGroup.classList.remove("hidden");
    $group.value = settings.group;
    for (const b of $browseButtons) b.hidden = false;
    $settingsHelp.innerHTML =
      "One folder per type — <code>~</code> and <code>$VARS</code> allowed. " +
      "Browse… picks a folder; the selector sets how downloads are nested. " +
      "Blank = the default shown.";
  } else {
    if (nativePermGranted) {
      // Permission granted but the local helper isn't answering → needs install.
      $modeLine.innerHTML =
        "Engine enabled, but the helper isn't responding. " +
        "<a id='helper-link' href='https://github.com/NullSense/harpe-extension#installation' target='_blank' rel='noopener'>Install it</a>, then reopen.";
    } else {
      $modeLine.innerHTML =
        "Built-in mode — images + direct videos save to Downloads. " +
        "Enable the engine for save-anywhere, per-type folders, and yt-dlp sources.";
    }
    $modeLine.className = "mode-line";
    $rowVid.classList.add("hidden");
    $rowAud.classList.add("hidden");
    $rowGroup.classList.add("hidden");          // built-in always groups by site
    for (const b of $browseButtons) b.hidden = true;  // browser can't pick a path
    $lblImg.textContent = "Downloads subfolder";
    $destImg.placeholder = "harpe";
    $destImg.value = settings.sub;
    $settingsHelp.innerHTML =
      "Files save to <code>Downloads/&lt;subfolder&gt;/&lt;site&gt;/</code> " +
      "(browser limit). Enable the engine to save anywhere and sort video/audio " +
      "into their own folders.";
  }
}

async function detectEngine() {
  // Never touch the host without the optional permission (avoids a connectNative
  // that would otherwise throw, and keeps the lean-install promise honest).
  nativePermGranted = await hasNativePerm();
  if (!nativePermGranted) {
    engineAvailable = false;
    applyMode();
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: "HARPE_PING" });
    engineAvailable = Boolean(r && r.available) || enginePinnedOn;
    if (r && r.defaults) {
      engineDefaults = {
        image: r.defaults.image || engineDefaults.image,
        video: r.defaults.video || engineDefaults.video,
        audio: r.defaults.audio || engineDefaults.audio,
      };
    }
  } catch {
    engineAvailable = false;
  }
  applyMode();
}

async function loadSettings() {
  try {
    const s = await chrome.storage.local.get(["destImg", "destVid", "destAud", "destSub", "destGroup", "dest"]);
    settings = {
      // `dest` is the legacy single-folder key — migrate it to the image path.
      img: typeof s.destImg === "string" ? s.destImg : (typeof s.dest === "string" ? s.dest : ""),
      vid: typeof s.destVid === "string" ? s.destVid : "",
      aud: typeof s.destAud === "string" ? s.destAud : "",
      sub: typeof s.destSub === "string" ? s.destSub : "",
      group: ["site", "author", "both", "none"].includes(s.destGroup) ? s.destGroup : "site",
    };
  } catch {
    settings = { img: "", vid: "", aud: "", sub: "", group: "site" };
  }
  applyMode();
  detectEngine(); // async — refreshes mode line + real default placeholders
}

async function saveSettings() {
  if (engineAvailable) {
    settings.img = $destImg.value.trim();
    settings.vid = $destVid.value.trim();
    settings.aud = $destAud.value.trim();
    settings.group = $group.value;
  } else {
    settings.sub = $destImg.value.trim();
  }
  try {
    await chrome.storage.local.set({
      destImg: settings.img, destVid: settings.vid,
      destAud: settings.aud, destSub: settings.sub, destGroup: settings.group,
    });
    chrome.storage.local.remove("dest").catch(() => {}); // drop the migrated legacy key
    if (engineAvailable) {
      $settingsStatus.textContent =
        `img → ${settings.img || engineDefaults.image} · ` +
        `vid → ${settings.vid || engineDefaults.video} · ` +
        `aud → ${settings.aud || engineDefaults.audio}`;
    } else {
      $settingsStatus.textContent = `Downloads/${settings.sub || "harpe"}/<site>/`;
    }
    $settingsStatus.hidden = false;
    setTimeout(() => { $settingsStatus.hidden = true; }, 3200);
  } catch (e) {
    $settingsStatus.textContent = "Could not save: " + e.message;
    $settingsStatus.hidden = false;
  }
}

function toggleSettings() {
  const open = $settings.hidden;
  $settings.hidden = !open;
  $btnSettings.setAttribute("aria-expanded", String(open));
  // Re-probe on open so a stale "helper isn't responding" (from a slow startup
  // ping) self-corrects without needing a reload.
  if (open) detectEngine();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg, cls = "") {
  $status.textContent = msg;
  $status.className = "status " + cls;
}

function updateControls() {
  const n = selected.size;
  $btnGrab.textContent = n > 0 ? `Grab ${n}` : "Grab";
  $btnGrab.disabled = n === 0 || grabInProgress;
  $count.textContent =
    scanResult ? `${scanResult.images.length} found` : "";
}

function fmtDims(w, h) {
  if (!w && !h) return "? × ?";
  return `${w} × ${h}`;
}

function fmtArea(area) {
  if (!area) return "";
  if (area >= 1_000_000) return `${(area / 1_000_000).toFixed(1)} MP`;
  if (area >= 1_000) return `${(area / 1_000).toFixed(0)} kpx`;
  return `${area} px²`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderGrid(images) {
  $grid.innerHTML = "";
  if (!images || images.length === 0) {
    const msg = document.createElement("p");
    msg.className = "empty";
    msg.textContent = "No images found on this page.";
    $grid.appendChild(msg);
    return;
  }

  for (const img of images) {
    const card = document.createElement("div");
    card.className = "card" + (img.kind === "video" ? " is-video" : "");
    card.dataset.url = img.url;

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.loading = "lazy";
    thumb.decoding = "async";
    // Videos show their poster (the MP4 url is what gets grabbed).
    thumb.src = img.poster || img.url;
    thumb.alt = "";
    thumb.onerror = () => {
      thumb.src = ""; // blank on error
      card.classList.add("error");
    };

    if (img.kind === "video") {
      const play = document.createElement("div");
      play.className = "play-badge";
      play.textContent = "▶ video";
      card.appendChild(play);
    }

    const info = document.createElement("div");
    info.className = "info";

    const dimSpan = document.createElement("span");
    dimSpan.className = "dims";
    dimSpan.textContent = fmtDims(img.w, img.h);

    const areaSpan = document.createElement("span");
    areaSpan.className = "area";
    areaSpan.textContent = fmtArea(img.area);

    info.appendChild(dimSpan);
    info.appendChild(areaSpan);

    const checkmark = document.createElement("div");
    checkmark.className = "checkmark";
    checkmark.textContent = "✓";

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(checkmark);

    card.addEventListener("click", () => toggleSelect(img.url, card));

    $grid.appendChild(card);
  }
}

function toggleSelect(url, card) {
  if (selected.has(url)) {
    selected.delete(url);
    card.classList.remove("selected");
  } else {
    selected.add(url);
    card.classList.add("selected");
  }
  updateControls();
}

function selectAll() {
  if (!scanResult) return;
  for (const img of scanResult.images) selected.add(img.url);
  for (const card of $grid.querySelectorAll(".card"))
    card.classList.add("selected");
  updateControls();
}

function clearAll() {
  selected.clear();
  for (const card of $grid.querySelectorAll(".card"))
    card.classList.remove("selected");
  updateControls();
}

// ── Scan ─────────────────────────────────────────────────────────────────────

async function doScan() {
  selected.clear();
  $grid.innerHTML = "";
  $savedBar.hidden = true;
  setStatus("Scanning page…", "scanning");
  $btnRescan.disabled = true;
  $btnGrab.disabled = true;
  $pageTitle.textContent = "";
  $count.textContent = "";

  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tabId = tab?.id;
    }
    if (!tabId) throw new Error("No active tab");

    const result = await chrome.runtime.sendMessage({
      type: "HARPE_SCAN_REQUEST",
      tabId,
    });

    if (!result?.ok) throw new Error(result?.error || "Scan failed");

    scanResult = result;
    $pageTitle.textContent = result.pageTitle || result.pageUrl;
    renderGrid(result.images);
    setStatus(
      result.images.length
        ? "Click images to select, then Grab."
        : "No images found.",
      result.images.length ? "ok" : "warn"
    );
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  } finally {
    $btnRescan.disabled = false;
    updateControls();
  }
}

// ── Grab ─────────────────────────────────────────────────────────────────────

async function doGrab() {
  if (!scanResult || selected.size === 0 || grabInProgress) return;
  grabInProgress = true;
  $btnGrab.disabled = true;
  $hostHint.hidden = true;
  $savedBar.hidden = true;
  setStatus(`Downloading ${selected.size} item(s)…`, "scanning");

  // Grey-out non-selected cards
  for (const card of $grid.querySelectorAll(".card")) {
    if (!selected.has(card.dataset.url)) card.classList.add("dim");
  }

  try {
    const urls = [...selected];
    // Per-url descriptive name + author (e.g. an X video's tweet text/account),
    // so the engine names the file and nests it by author when asked.
    const items = {};
    for (const img of scanResult.images || []) {
      if (selected.has(img.url) && (img.name || img.author)) {
        items[img.url] = {};
        if (img.name) items[img.url].name = img.name;
        if (img.author) items[img.url].author = img.author;
      }
    }
    const result = await chrome.runtime.sendMessage({
      type: "HARPE_GRAB",
      urls,
      referer: scanResult.pageUrl,
      // Engine uses per-type dirs + grouping + item metadata; built-in uses the
      // Downloads subfolder. All are sent — background picks based on the host.
      dirs: { image: settings.img, video: settings.vid, audio: settings.aud },
      group: settings.group,
      items,
      folder: settings.sub,
    });

    if (!result) throw new Error("No response from background");

    // The grab is the ground truth: if it ran through the engine, a startup ping
    // that wrongly concluded "no engine" gets corrected here so the settings UI
    // and messaging stay coherent with where files actually landed.
    if (result.engine) {
      enginePinnedOn = true;
      nativePermGranted = true;
      engineAvailable = true;
      applyMode();    // coherent immediately (defaults are correct fallbacks)
      detectEngine(); // best-effort: refine placeholders if the ping succeeds
    }

    // Whole-grab failure (e.g. native helper missing) — no per-image results.
    if (result.ok === false && (!result.results || result.results.length === 0)) {
      const msg = result.error || "Grab failed";
      setStatus(msg, "error");
      if (looksLikeHostError(msg)) $hostHint.hidden = false;
      return;
    }

    // Annotate cards with per-image results
    if (result.results) {
      const byUrl = new Map(result.results.map((r) => [r.url, r]));
      for (const card of $grid.querySelectorAll(".card.selected")) {
        const r = byUrl.get(card.dataset.url);
        if (!r) continue;
        const badge = document.createElement("div");
        badge.className = "result-badge " + (r.ok ? "ok" : "fail");
        badge.textContent = r.ok ? "✓" : "✗";
        badge.title = r.ok ? r.path || "Downloaded" : r.error || "Failed";
        card.appendChild(badge);
      }
    }

    const ok = result.results?.filter((r) => r.ok).length ?? 0;
    const fail = (result.results?.length ?? 0) - ok;
    if (fail === 0) {
      setStatus(`Downloaded ${ok} file${ok !== 1 ? "s" : ""}.`, "ok");
    } else if (ok === 0) {
      setStatus(`All ${fail} download${fail !== 1 ? "s" : ""} failed.`, "error");
    } else {
      setStatus(`${ok} downloaded, ${fail} failed.`, "warn");
    }
    showSaved(result.results);
  } catch (err) {
    setStatus("Grab failed: " + err.message, "error");
    if (looksLikeHostError(err.message)) $hostHint.hidden = false;
  } finally {
    grabInProgress = false;
    // Restore dim cards
    for (const card of $grid.querySelectorAll(".card.dim"))
      card.classList.remove("dim");
    updateControls();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

// Extract tabId from URL params (fallback popup mode)
const params = new URLSearchParams(location.search);
if (params.has("tabId")) tabId = parseInt(params.get("tabId"), 10);

$btnSelectAll.addEventListener("click", selectAll);
$btnClear.addEventListener("click", clearAll);
$btnGrab.addEventListener("click", doGrab);
$btnRescan.addEventListener("click", doScan);
$btnSettings.addEventListener("click", toggleSettings);
$btnSaveSettings.addEventListener("click", saveSettings);
$btnOpenFolder.addEventListener("click", openSavedFolder);
$btnEnableEngine.addEventListener("click", enableEngine);
for (const el of [$destImg, $destVid, $destAud]) {
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });
}
for (const b of $browseButtons) {
  b.addEventListener("click", () => browseFor(b.dataset.for));
}

let inited = false;
function init() {
  if (inited) return; // guard: both the listener and the readyState check can fire
  inited = true;
  loadSettings();
  doScan();
}

document.addEventListener("DOMContentLoaded", init);
// DOMContentLoaded may have already fired (side panel loads synchronously)
if (document.readyState !== "loading") init();
