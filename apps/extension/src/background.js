/**
 * Harpe background service worker (MV3).
 *
 * Responsibilities:
 *   1. Open the side panel when the toolbar icon is clicked.
 *   2. Relay SCAN requests from the popup to the active tab's content script.
 *   3. Accept GRAB requests: forward chosen URLs to the native messaging host,
 *      receive harpe's JSON response, relay it back to the popup, and surface
 *      a browser notification.
 *
 * Native messaging host name: "com.nullsense.harpe"
 * Protocol: Chrome native messaging (4-byte LE length prefix), JSON messages.
 *
 * Outgoing to host: { urls, referer, dirs?, items?, group? } | { ping } |
 *                    { open: path } | { pick: true, start? }
 * Incoming from host: { results: [{url, ok, path?, kind?, error?}, ...] } |
 *                     { ok, defaults, version } | { ok, path }
 */

// Native-messaging host name comes from @harpe/core — single source of truth
// shared with the engine's host registration (no more drift between repos).
import { HOST_NAME } from "@harpe/core";

// ── Panel: each browser's native surface ──────────────────────────────────────
// Firefox → native sidebar (sidebarAction). Chrome/Edge → native side panel.
// Anything else → a popup window. All API access is guarded so the same bundle
// loads on a browser that lacks any one of them.

if (typeof chrome !== "undefined" && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (chrome.sidebarAction?.toggle) {
      try { await chrome.sidebarAction.toggle(); return; } catch {}
    }
    if (chrome.sidePanel?.open) {
      try { await chrome.sidePanel.open({ tabId: tab.id }); return; } catch {}
    }
    const url = chrome.runtime.getURL("popup.html") + "?tabId=" + tab.id;
    await chrome.windows.create({ url, type: "popup", width: 900, height: 700 });
  });
}

// Chrome: clicking the toolbar icon opens the side panel directly.
if (typeof chrome !== "undefined") {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}

// ── Message routing ──────────────────────────────────────────────────────────

if (typeof chrome !== "undefined") chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "HARPE_SCAN_REQUEST") {
    handleScan(msg.tabId).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === "HARPE_PING") {
    pingHost().then((m) =>
      sendResponse({ available: !!(m && m.ok), defaults: (m && m.defaults) || null })
    );
    return true;
  }

  if (msg.type === "HARPE_GRAB") {
    handleGrab(msg.urls, msg.referer, {
      dirs: msg.dirs, folder: msg.folder, items: msg.items, group: msg.group,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Native folder chooser for the settings "Browse…" button (engine only).
  if (msg.type === "HARPE_PICK") {
    pickInHost(msg.start).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  // Reveal a saved file in its folder. Engine downloads go through the native
  // host (it can open any OS folder); built-in downloads use chrome.downloads.
  if (msg.type === "HARPE_OPEN") {
    openInHost(msg.path).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
  if (msg.type === "HARPE_OPEN_DOWNLOAD") {
    try {
      chrome.downloads.show(msg.id);
      sendResponse({ ok: true });
    } catch (e) {
      try { chrome.downloads.showDefaultFolder(); sendResponse({ ok: true }); }
      catch (e2) { sendResponse({ ok: false, error: String(e2) }); }
    }
    return false;
  }

  return false;
});

// nativeMessaging is an OPTIONAL permission (granted on demand from the popup)
// so the base store install stays lean. Every native-host call gates on it.
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

// One request → one reply over a fresh native-messaging port. Resolves the
// host's reply object, or {ok:false,error} on missing permission/timeout/death.
// Used by ping, grab, open-folder, and pick-folder.
async function hostRoundtrip(payload, timeoutMs = 8000) {
  if (!(await hasNativePerm())) return { ok: false, error: "engine not enabled" };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { port.disconnect(); } catch {} resolve(v); } };
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      return resolve({ ok: false, error: String(e) });
    }
    const timer = setTimeout(() => finish({ ok: false, error: "host timed out" }), timeoutMs);
    port.onMessage.addListener((m) => { clearTimeout(timer); finish(m || { ok: false, error: "empty reply" }); });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      finish({ ok: false, error: chrome.runtime.lastError?.message || "host disconnected" });
    });
    try { port.postMessage(payload); } catch (e) { clearTimeout(timer); finish({ ok: false, error: String(e) }); }
  });
}

// Reveal a saved path in the OS file manager.
function openInHost(path) {
  return hostRoundtrip({ open: path }, 4000);
}

// Open a native folder chooser; resolves {ok, path} (path null if cancelled).
function pickInHost(start) {
  return hostRoundtrip({ pick: true, start: start || "" }, 120000);
}

// ── Helper detection + routing ────────────────────────────────────────────────

// Probe the native host. Resolves its ping reply ({ok, defaults, version}); when
// the permission is absent or it doesn't answer, ok is false → built-in mode.
// 5s timeout covers the python/uv cold start.
function pingHost() {
  return hostRoundtrip({ ping: true }, 5000);
}

async function handleGrab(urls, referer, cfg) {
  // Try the engine directly when the permission is granted — a results array means
  // the host handled it (even if some files failed). No separate ping first: that
  // spawned a second cold-start host per grab. A connection failure (no results
  // array) falls through to the built-in downloader. `engine` tags which ran so
  // the popup can correct its mode.
  if (await hasNativePerm()) {
    const r = await handleGrabHost(urls, referer, cfg);
    if (Array.isArray(r.results)) return { ...r, engine: true };
  }
  const r = await handleGrabBuiltin(urls, referer, cfg.folder);
  return { ...r, engine: false };
}

// ── Built-in downloader (chrome.downloads — no native host) ───────────────────

function safeFilename(url) {
  try {
    const u = new URL(url);
    let base = decodeURIComponent((u.pathname.split("/").pop() || "").split("?")[0]);
    base = base.replace(/[^\w.\- ]+/g, "_").slice(0, 100);
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += ".jpg";
    return base || "image.jpg";
  } catch {
    return "image.jpg";
  }
}

// Build a Downloads-relative subfolder: "<folder>/<site>" (no absolute paths,
// no traversal — chrome.downloads rejects those).
function buildSubfolder(folder, referer) {
  let f = (folder || "harpe").trim()
    .replace(/^[/\\]+/, "")
    .replace(/\.\.+/g, "")
    .replace(/[<>:"|?*]+/g, "_");
  try {
    const host = new URL(referer).hostname.replace(/^www\./, "");
    if (host) f += "/" + host;
  } catch { /* no referer */ }
  return f.replace(/\/+/g, "/").replace(/[/\\]+$/, "");
}

function downloadOne(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          resolve({ url, ok: false, error: chrome.runtime.lastError?.message || "download failed" });
        } else {
          resolve({ url, ok: true, path: filename, id });
        }
      });
    } catch (e) {
      resolve({ url, ok: false, error: String(e?.message || e) });
    }
  });
}

async function handleGrabBuiltin(urls, referer, folder) {
  const sub = buildSubfolder(folder, referer);
  const results = [];
  for (const url of urls) {
    results.push(await downloadOne(url, sub ? `${sub}/${safeFilename(url)}` : safeFilename(url)));
  }
  notifyDone(results);
  return { ok: results.every((r) => r.ok), results };
}

// ── Scan ─────────────────────────────────────────────────────────────────────

async function handleScan(tabId) {
  // Ensure content script is injected (handles cases where the tab was opened
  // before the extension was installed, or the tab is a special page).
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["js/content.js"],
    });
  } catch {
    // Already injected or restricted page — ignore, carry on.
  }

  const response = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "HARPE_SCAN" }, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });

  // Fold any grabbable videos into the image grid (prepended): direct <video>
  // files the content script found, plus X/Twitter MP4s resolved here.
  if (response && response.ok) {
    const vids = [...(response.videos || [])];
    if (response.tweetId) {
      try { vids.push(...await resolveTweetVideos(response.tweetId)); } catch { /* best-effort */ }
    }
    if (vids.length) response.images = [...vids, ...(response.images || [])];
  }
  return response;
}

// X/Twitter public syndication endpoint → MP4 variants. No auth, no yt-dlp; the
// background can fetch cross-origin thanks to <all_urls> host permission.
function tweetToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}
async function resolveTweetVideos(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tweetToken(id)}&lang=en`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return [];
  const j = await r.json();
  // A descriptive filename + account so the engine saves "i envision a world….mp4"
  // under the author's folder, instead of the opaque CDN basename.
  const author = j.user?.screen_name || j.user?.name || "";
  const name = (j.text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const out = [];
  for (const m of (j.mediaDetails || [])) {
    if ((m.type === "video" || m.type === "animated_gif") && m.video_info?.variants) {
      const best = m.video_info.variants
        .filter((v) => v.content_type === "video/mp4" && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best) {
        const dm = /\/(\d+)x(\d+)\//.exec(best.url);
        const w = dm ? +dm[1] : 0, h = dm ? +dm[2] : 0;
        out.push({
          url: best.url, kind: "video", poster: m.media_url_https || null,
          w, h, area: w * h, author: author || undefined, name: name || undefined,
        });
      }
    }
  }
  return out;
}

// ── Grab ─────────────────────────────────────────────────────────────────────

async function handleGrabHost(urls, referer, cfg) {
  // dirs = per-type folders; items = per-url {name, author}; group = nesting.
  const msg = await hostRoundtrip({
    urls,
    referer,
    dirs: cfg.dirs || {},
    items: cfg.items || {},
    group: cfg.group || "site",
  }, 300000);
  if (msg && Array.isArray(msg.results)) {
    notifyDone(msg.results);
    return { ok: msg.results.every((r) => r.ok !== false), results: msg.results };
  }
  return { ok: false, error: (msg && msg.error) || "Unexpected response from native host" };
}

// ── Notification ─────────────────────────────────────────────────────────────

function notifyDone(results) {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;

  // Surface the folder the files landed in (engine returns absolute paths).
  const firstPath = results.find((r) => r.ok && r.path)?.path;
  const folder = firstPath ? dirOf(firstPath) : "";

  let message;
  if (fail === 0) {
    message = `Downloaded ${ok} file${ok !== 1 ? "s" : ""}` + (folder ? ` → ${folder}` : ".");
  } else if (ok === 0) {
    message = `All ${fail} download${fail !== 1 ? "s" : ""} failed.`;
  } else {
    message = `${ok} downloaded, ${fail} failed` + (folder ? ` → ${folder}` : ".");
  }

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Harpe",
    message,
  });
}

// Folder portion of a saved path (handles both / and \ separators).
function dirOf(p) {
  const i = Math.max(String(p).lastIndexOf("/"), String(p).lastIndexOf("\\"));
  return i > 0 ? String(p).slice(0, i) : String(p);
}

// Expose the pure helpers for unit tests (ESM). The chrome.* registrations above
// are guarded behind `typeof chrome`, so importing this module headlessly (Node)
// is side-effect-free.
export { dirOf, safeFilename, buildSubfolder, tweetToken };
