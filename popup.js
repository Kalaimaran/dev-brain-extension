/**
 * popup.js — Controls the extension popup UI
 *
 * Responsibilities:
 *  - Handle login (email/password) and token storage
 *  - Show account menu (profile + logout)
 *  - Show event stats from API
 *  - Persist tracking toggles
 *  - Trigger transcript/conversation capture actions
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const PROD_ENDPOINT = "https://data-nexus-541643753386.asia-south1.run.app";
const DEV_ENDPOINT = "http://localhost:8080";
const REDIRECT_BASE_URL = "https://dev-brain-hub-541643753386.asia-south1.run.app";

const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");

const inputEmail    = document.getElementById("inputEmail");
const inputPassword = document.getElementById("inputPassword");
const inputEndpoint = document.getElementById("inputEndpoint");
const btnLogin      = document.getElementById("btnLogin");
const feedbackAuth  = document.getElementById("feedbackAuth");
const sectionAuth   = document.getElementById("sectionAuth");

const profileWrap   = document.getElementById("profileWrap");
const profileButton = document.getElementById("profileButton");
const profileMenu   = document.getElementById("profileMenu");
const profileEmail  = document.getElementById("profileEmail");
const toggleDeveloperMode = document.getElementById("toggleDeveloperMode");
const btnLogout     = document.getElementById("btnLogout");

const toggleVisits   = document.getElementById("toggleVisits");
const toggleSearches = document.getElementById("toggleSearches");

const statVisits        = document.getElementById("statVisits");
const statAI            = document.getElementById("statAI");
const weeklyGraphChart  = document.getElementById("weeklyGraphChart");
const weeklyGraphLabels = document.getElementById("weeklyGraphLabels");

const btnSaveTranscript   = document.getElementById("btnSaveTranscript");
const btnSaveConversation = document.getElementById("btnSaveConversation");
const statusTranscript    = document.getElementById("statusTranscript");
const statusConversation  = document.getElementById("statusConversation");

const toggleHistorySync   = document.getElementById("toggleHistorySync");
const historySyncBody     = document.getElementById("historySyncBody");
const btnPickHistory      = document.getElementById("btnPickHistory");
const btnHistorySyncNow   = document.getElementById("btnHistorySyncNow");
const historyStatusDot    = document.getElementById("historyStatusDot");
const historyStatusText   = document.getElementById("historyStatusText");
const feedbackHistory     = document.getElementById("feedbackHistory");
const historyStatsRow     = document.getElementById("historyStatsRow");
const historyStatTotal    = document.getElementById("historyStatTotal");
const historyStatSynced   = document.getElementById("historyStatSynced");
const historyStatPending  = document.getElementById("historyStatPending");
const historyStatLastSync = document.getElementById("historyStatLastSync");

let currentFileHandle = null;    // in-memory fallback when IDB persistence fails

// ---------------------------------------------------------------------------
// Search panel — DOM references + state
// ---------------------------------------------------------------------------
const tabBtnView       = document.getElementById("tabBtnView");
const tabBtnSearch     = document.getElementById("tabBtnSearch");
const panelView        = document.getElementById("panelView");
const panelSearch      = document.getElementById("panelSearch");
const searchForm       = document.getElementById("searchForm");
const searchInput      = document.getElementById("searchInput");
const filterTypes      = document.getElementById("filterTypes");
const filterDates      = document.getElementById("filterDates");
const searchResults    = document.getElementById("searchResults");
const searchPagination = document.getElementById("searchPagination");

const searchState = { page: 0, limit: 10, total: 0 };

// ---------------------------------------------------------------------------
// Shell History — IndexedDB helpers (FileSystemFileHandle can't go in storage)
// ---------------------------------------------------------------------------
function openHistoryIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("devbrain-history", 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("handles")) {
        req.result.createObjectStore("handles");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("handles", "readonly").objectStore("handles").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("handles", "readwrite").objectStore("handles").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Shell History — parsers (popup owns all history logic)
// ---------------------------------------------------------------------------
function parseZshHistory(text) {
  const entries = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^: (\d+):\d+;(.*)$/);
    if (m) {
      let cmd = m[2];
      while (cmd.endsWith("\\") && i + 1 < lines.length) {
        i++;
        cmd = cmd.slice(0, -1) + "\n" + lines[i];
      }
      if (cmd.trim())
        entries.push({ ts: parseInt(m[1], 10) * 1000, command: cmd.trim() });
    }
    i++;
  }
  // Fallback: plain-text history (no EXTENDED_HISTORY / no timestamps)
  if (entries.length === 0) {
    for (const line of lines) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith("#"))
        entries.push({ ts: null, command: cmd });
    }
  }
  return entries;
}

function parseBashHistory(text) {
  const entries = [];
  let ts = null;
  for (const line of text.split("\n")) {
    if (/^#\d+$/.test(line.trim())) { ts = parseInt(line.slice(1), 10) * 1000; continue; }
    if (line.trim()) { entries.push({ ts, command: line.trim() }); ts = null; }
  }
  return entries;
}

// Reads the history file directly and updates the count display.
// Called once on popup open and again after a sync to refresh numbers.
async function refreshHistoryDisplay() {
  try {
    const { historySync: sync = {} } = await chrome.storage.local.get("historySync");
    if (sync?.syncEnabled === false) return;

    let handle = currentFileHandle;
    if (!handle) {
      try {
        const db = await openHistoryIdb();
        handle = await idbGet(db, "fileHandle");
        if (handle) currentFileHandle = handle;
      } catch { /* IDB unavailable */ }
    }
    if (!handle) return;

    const perm = await handle.queryPermission({ mode: "read" });
    if (perm === "denied") {
      historyStatusText.textContent = "Access denied — pick a new file";
      historyStatusDot.className = "status-dot";
      return;
    }
    if (perm === "prompt") {
      if (sync.fileName) {
        historyStatusText.textContent = `${sync.fileName} — tap 📂 to reconnect`;
        historyStatusDot.className = "status-dot";
      }
      return;
    }

    const file    = await handle.getFile();
    const buf     = await file.arrayBuffer();
    const text    = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const isZsh   = handle.name.toLowerCase().includes("zsh");
    const entries = isZsh ? parseZshHistory(text) : parseBashHistory(text);

    const total   = entries.length;
    const synced  = Math.min(sync.entryCount ?? 0, total);
    const pending = Math.max(0, total - synced);

    historyStatTotal.textContent   = total.toLocaleString();
    historyStatSynced.textContent  = synced.toLocaleString();
    historyStatPending.textContent = pending.toLocaleString();
    historyStatsRow.style.display  = "flex";
    btnHistorySyncNow.disabled     = pending === 0;
  } catch (err) {
    console.warn("[DevBrain] refreshHistoryDisplay:", err.name, err.message);
  }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Re-grant FileSystemFileHandle permission during DOMContentLoaded (user-gesture window).
// Permissions reset to "prompt" on every panel open — this silently re-grants them.
async function warmUpHistoryPermission() {
  try {
    const db = await openHistoryIdb();
    const handle = await idbGet(db, "fileHandle");
    if (!handle) return;
    // requestPermission() is idempotent: returns "granted" immediately if already
    // allowed, and only shows a prompt if in "prompt" state. Skipping queryPermission()
    // removes one async IDB round-trip and maximises our chance of calling
    // requestPermission() while still within the user-gesture activation window.
    const result = await handle.requestPermission({ mode: "read" });
    if (result === "granted") currentFileHandle = handle;
  } catch { /* non-fatal — gesture window may have expired or IDB unavailable */ }
}

async function loadHistoryStatus() {
  const { historySync: sync = {} } = await chrome.storage.local.get("historySync");
  const enabled = sync.syncEnabled !== false;
  toggleHistorySync.checked = enabled;
  historySyncBody.style.display = enabled ? "block" : "none";

  if (!sync.fileName) {
    historyStatusDot.className = "status-dot";
    historyStatusText.textContent = "No file selected";
    historyStatsRow.style.display = "none";
    btnHistorySyncNow.disabled = true;
    return;
  }

  historyStatusDot.className = "status-dot active";
  historyStatusText.textContent = sync.fileName;
  historyStatLastSync.textContent = sync.lastSyncAt ? timeAgo(sync.lastSyncAt) : "Never";
}


// ---------------------------------------------------------------------------
// Shell History — event listeners
// ---------------------------------------------------------------------------
toggleHistorySync.addEventListener("change", async () => {
  const { historySync: sync = {} } = await chrome.storage.local.get("historySync");
  await chrome.storage.local.set({ historySync: { ...sync, syncEnabled: toggleHistorySync.checked } });
  historySyncBody.style.display = toggleHistorySync.checked ? "block" : "none";
});

btnPickHistory.addEventListener("click", async () => {
  // This handler always runs with a user gesture — safe to call requestPermission.
  try {
    let db;
    try { db = await openHistoryIdb(); } catch { /* IDB unavailable */ }

    // ── Step 1: Re-grant permission on existing handle (avoids picker) ──
    if (db) {
      const existing = await idbGet(db, "fileHandle").catch(() => null);
      if (existing) {
        try {
          const perm = await existing.requestPermission({ mode: "read" });
          if (perm === "granted") {
            currentFileHandle = existing;
            await loadHistoryStatus();
            await refreshHistoryDisplay();
            showFeedback(feedbackHistory, `Reconnected: ${existing.name}`, "ok");
            return;
          }
        } catch { /* fall through to file picker */ }
      }
    }

    // ── Step 2: Pick a new file ──
    const [handle] = await window.showOpenFilePicker({ multiple: false });
    currentFileHandle = handle;

    // ── Step 3: Persist handle in IDB ──
    try {
      if (!db) db = await openHistoryIdb();
      await idbSet(db, "fileHandle", handle);
    } catch (idbErr) {
      console.warn("[DevBrain] IDB persist failed:", idbErr.name, idbErr.message);
    }

    // ── Step 4: Reset sync state ──
    const { historySync: sync = {} } = await chrome.storage.local.get("historySync");
    await chrome.storage.local.set({
      historySync: { ...sync, fileName: handle.name, entryCount: 0, lastSyncAt: null },
    });

    await loadHistoryStatus();
    await refreshHistoryDisplay();
    showFeedback(feedbackHistory, `Selected: ${handle.name}`, "ok");

  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("[DevBrain] btnPickHistory:", err.name, err.message, err);
      showFeedback(feedbackHistory, `${err.name}: ${err.message || "see DevTools console"}`, "err");
    }
  }
});

btnHistorySyncNow.addEventListener("click", async () => {
  try {
    const handle = currentFileHandle;
    if (!handle) { showFeedback(feedbackHistory, "No file — pick one first", "err"); return; }

    const file    = await handle.getFile();
    const buf     = await file.arrayBuffer();
    const text    = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const isZsh   = handle.name.toLowerCase().includes("zsh");
    const entries = isZsh ? parseZshHistory(text) : parseBashHistory(text);

    const { historySync: sync = {} } = await chrome.storage.local.get("historySync");
    const prevCount  = sync.entryCount ?? 0;
    const newEntries = entries.slice(prevCount);

    if (newEntries.length === 0) {
      showFeedback(feedbackHistory, "Already up to date", "ok");
      return;
    }

    const tsNow  = new Date().toISOString();
    const events = newEntries.map(e => {
      const cmd = e.command ?? "";
      return {
        eventType : "terminal_command",
        domain    : "shell history",
        query     : cmd,
        pageTitle : `[shell_history] ${cmd.split(" ").slice(0, 3).join(" ")}`,
        pageText  : JSON.stringify({ command: cmd, source: "shell_history" }),
        timestamp : e.ts ? new Date(e.ts).toISOString() : tsNow,
      };
    });

    showFeedback(feedbackHistory, `Syncing ${newEntries.length} commands...`, "ok");

    chrome.runtime.sendMessage({ type: "HISTORY_FLUSH_EVENTS", events }, async () => {
      void chrome.runtime.lastError;
      await chrome.storage.local.set({
        historySync: { ...sync, entryCount: entries.length, lastSyncAt: tsNow },
      });
      await loadHistoryStatus();
      await refreshHistoryDisplay();
      showFeedback(feedbackHistory, `Synced ${newEntries.length} commands`, "ok");
    });

  } catch (err) {
    showFeedback(feedbackHistory, `${err.name}: ${err.message}`, "err");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.historySync) {
    loadHistoryStatus();
    refreshHistoryDisplay();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // warmUpHistoryPermission MUST be first — it calls requestPermission which requires
  // user activation. The activation window (from clicking the extension icon) expires
  // after the first few awaits, so this must run before loadSettings() etc.
  await warmUpHistoryPermission();
  await loadSettings();
  await ensureValidSession();
  await hydrateAuthUI();
  await updateStatusBadge();
  await checkAISite();
  await refreshStats();
  registerLiveRefreshListeners();
  registerProfileMenuListeners();
  await loadHistoryStatus();
  await refreshHistoryDisplay();    // read file directly on panel open, update counts
});

// ---------------------------------------------------------------------------
// Settings + auth
// ---------------------------------------------------------------------------
async function loadSettings() {
  const data = await chrome.storage.sync.get([
    "loginId",
    "email",
    "endpoint",
    "developerMode",
    "trackVisits",
    "trackSearches"
  ]);

  inputEmail.value = data.loginId ?? data.email ?? "";
  const developerMode = data.developerMode === true;
  inputEndpoint.value = resolveEndpoint(developerMode);
  inputEndpoint.readOnly = true;
  toggleDeveloperMode.checked = developerMode;

  toggleVisits.checked   = data.trackVisits   !== false;
  toggleSearches.checked = data.trackSearches !== false;

  await chrome.storage.sync.set({ endpoint: inputEndpoint.value });
  await chrome.storage.local.set({ endpoint: inputEndpoint.value });
  updateActionButtonsState();
}

function resolveEndpoint(developerMode) {
  return developerMode ? DEV_ENDPOINT : PROD_ENDPOINT;
}

async function getAuthState() {
  const sync = await chrome.storage.sync.get([
    "accessToken",
    "refreshToken",
    "tokenType",
    "expiresIn",
    "endpoint",
    "developerMode",
    "loginId",
    "email",
    "user"
  ]);
  const local = await chrome.storage.local.get(["accessToken"]);
  const endpoint = resolveEndpoint(sync.developerMode === true);

  return {
    accessToken: sync.accessToken || local.accessToken || null,
    refreshToken: sync.refreshToken || null,
    tokenType: sync.tokenType || "Bearer",
    expiresIn: sync.expiresIn || null,
    endpoint,
    loginId: sync.loginId || sync.email || null,
    user: sync.user || null,
  };
}

async function saveAuthTokens(auth, endpointBase) {
  await chrome.storage.sync.set({
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken || null,
    tokenType: auth.tokenType || "Bearer",
    expiresIn: auth.expiresIn || null,
    user: auth.user || null,
  });
  await chrome.storage.local.set({
    accessToken: auth.accessToken,
    endpoint: endpointBase,
  });
}

async function refreshAccessToken(authState) {
  if (!authState.refreshToken) return null;

  const res = await fetch(`${authState.endpoint}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: authState.refreshToken }),
  });

  const body = await res.json().catch(() => ({}));
  const data = body?.data || {};
  if (!res.ok || !body?.success || !data?.accessToken) return null;

  await saveAuthTokens({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || authState.refreshToken,
    tokenType: data.tokenType || "Bearer",
    expiresIn: data.expiresIn || null,
    user: data.user || authState.user || null,
  }, authState.endpoint);

  return data.accessToken;
}

async function fetchCurrentUser(endpoint, accessToken) {
  const res = await fetch(`${endpoint}/api/v1/auth/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) return { ok: false, status: res.status, user: null };

  const body = await res.json().catch(() => ({}));
  const user = body?.data?.user || body?.data || body?.user || null;
  return { ok: true, status: res.status, user };
}

async function clearAuthSession() {
  await chrome.storage.sync.remove([
    "accessToken",
    "refreshToken",
    "tokenType",
    "expiresIn",
    "user"
  ]);
  await chrome.storage.local.remove(["accessToken"]);
}

async function ensureValidSession() {
  let auth = await getAuthState();
  if (!auth.accessToken) return null;

  let me = await fetchCurrentUser(auth.endpoint, auth.accessToken);
  if (me.ok) {
    if (me.user) await chrome.storage.sync.set({ user: me.user });
    return await getAuthState();
  }

  const refreshedToken = await refreshAccessToken(auth);
  if (!refreshedToken) {
    await clearAuthSession();
    return null;
  }

  auth = await getAuthState();
  me = await fetchCurrentUser(auth.endpoint, auth.accessToken);
  if (me.ok) {
    if (me.user) await chrome.storage.sync.set({ user: me.user });
    return await getAuthState();
  }

  await clearAuthSession();
  return null;
}

function userInitial(user, loginId) {
  const base = user?.fullName || loginId || "U";
  return (base.trim()[0] || "U").toUpperCase();
}

async function hydrateAuthUI() {
  const auth = await getAuthState();
  const loggedIn = !!auth.accessToken;

  sectionAuth.hidden = loggedIn;
  profileWrap.hidden = !loggedIn;

  if (loggedIn) {
    profileButton.textContent = userInitial(auth.user, auth.loginId);
    profileEmail.textContent = auth.user?.email || auth.loginId || "Signed in";
  } else {
    profileMenu.hidden = true;
  }

  updateActionButtonsState();
}

btnLogin.addEventListener("click", async () => {
  const loginId = inputEmail.value.trim();
  const password = inputPassword.value;
  const endpoint = resolveEndpoint(toggleDeveloperMode.checked);

  if (!loginId || !password) {
    showFeedback(feedbackAuth, "Enter username/email and password.", "err");
    return;
  }

  btnLogin.disabled = true;
  showFeedback(feedbackAuth, "Signing in...", "ok");

  try {
    const attempts = [
      { identifier: loginId, password },
      { username: loginId, password },
      { email: loginId, password },
    ];

    let payload = null;
    let lastError = "Login failed";

    for (const requestBody of attempts) {
      const res = await fetch(`${endpoint}/api/v1/auth/login/ext`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const body = await res.json().catch(() => ({}));
      const data = body?.data || {};
      if (res.ok && body?.success && data?.accessToken) {
        payload = data;
        break;
      }
      lastError = body?.message || lastError;
    }

    if (!payload?.accessToken) {
      throw new Error(lastError);
    }

    await chrome.storage.sync.set({
      endpoint,
      loginId,
      email: payload?.user?.email || loginId,
    });
    await saveAuthTokens({
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken || null,
      tokenType: payload.tokenType || "Bearer",
      expiresIn: payload.expiresIn || null,
      user: payload.user || null,
    }, endpoint);

    // Backward compatibility cleanup
    await chrome.storage.sync.remove(["apiKey"]);
    await chrome.storage.local.remove(["apiKey"]);

    inputPassword.value = "";
    showFeedback(feedbackAuth, "Logged in successfully.", "ok");

    await hydrateAuthUI();
    await updateStatusBadge();
    await refreshStats();
  } catch (err) {
    showFeedback(feedbackAuth, err.message || "Login failed.", "err");
  } finally {
    btnLogin.disabled = false;
  }
});

btnLogout.addEventListener("click", async () => {
  await clearAuthSession();

  profileMenu.hidden = true;
  statVisits.textContent = "—";
  statAI.textContent = "—";
  weeklyGraphChart.innerHTML = "";
  weeklyGraphLabels.innerHTML = "";
  const topSitesContainer = document.getElementById("topSitesContainer");
  if (topSitesContainer) topSitesContainer.innerHTML = "";

  await hydrateAuthUI();
  await updateStatusBadge();
  showFeedback(feedbackAuth, "Logged out.", "ok");
});

function registerProfileMenuListeners() {
  profileButton.addEventListener("click", (evt) => {
    evt.stopPropagation();
    profileMenu.hidden = !profileMenu.hidden;
  });

  document.addEventListener("click", () => {
    profileMenu.hidden = true;
  });

  profileMenu.addEventListener("click", (evt) => {
    evt.stopPropagation();
  });

  toggleDeveloperMode.addEventListener("change", async () => {
    const endpoint = resolveEndpoint(toggleDeveloperMode.checked);
    inputEndpoint.value = endpoint;
    await chrome.storage.sync.set({
      developerMode: toggleDeveloperMode.checked,
      endpoint,
    });
    await chrome.storage.local.set({ endpoint });
    await updateStatusBadge();
    await refreshStats();
  });
}

// ---------------------------------------------------------------------------
// Tracking toggle persistence
// ---------------------------------------------------------------------------
async function saveToggles() {
  await chrome.storage.sync.set({
    trackVisits:   toggleVisits.checked,
    trackSearches: toggleSearches.checked
  });
  updateActionButtonsState();
}

toggleVisits.addEventListener("change", saveToggles);
toggleSearches.addEventListener("change", saveToggles);

function updateActionButtonsState() {
  const disabledByTracking = !toggleVisits.checked;
  btnSaveTranscript.disabled = disabledByTracking;
  btnSaveConversation.disabled = disabledByTracking;

  if (disabledByTracking) {
    btnSaveTranscript.title = "Enable Website Visits tracking to use this feature";
    btnSaveConversation.title = "Enable Website Visits tracking to use this feature";
  } else {
    btnSaveTranscript.title = "";
    btnSaveConversation.title = "";
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
async function refreshStats() {
  const auth = await ensureValidSession();
  if (!auth?.accessToken) {
    await hydrateAuthUI();
    await updateStatusBadge();
    return;
  }

  try {
    const res = await fetch(`${auth.endpoint}/api/events/stats`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });

    if (!res.ok) throw new Error("Stats API failed");

    const body = await res.json();
    const data = body.data || body;

    statVisits.textContent = data.visitsToday ?? "0";
    statAI.textContent = data.aiPromptsToday ?? "0";

    if (Array.isArray(data.weeklyGraph)) {
      renderWeeklyGraph(data.weeklyGraph);
    }

    if (Array.isArray(data.topSites)) {
      renderTopSites(data.topSites);
    }
  } catch (err) {
    console.error("[DevBrain] Error fetching stats:", err);
    statVisits.textContent = "—";
    statAI.textContent = "—";
  }
}

function renderWeeklyGraph(dataPoints) {
  weeklyGraphChart.innerHTML = "";
  weeklyGraphLabels.innerHTML = "";

  if (dataPoints.length === 0) return;

  const maxVal = Math.max(...dataPoints.map((d) => d.count), 1);

  dataPoints.forEach((point) => {
    const heightPct = Math.max((point.count / maxVal) * 100, 4);

    const bar = document.createElement("div");
    bar.style.width = "12%";
    bar.style.height = `${heightPct}%`;
    bar.style.backgroundColor = "var(--accent)";
    bar.style.borderRadius = "2px 2px 0 0";
    bar.style.opacity = point.count > 0 ? "1" : "0.3";
    bar.title = `${point.count} events`;
    weeklyGraphChart.appendChild(bar);

    const label = document.createElement("div");
    label.style.width = "12%";
    label.style.textAlign = "center";
    label.textContent = point.dayShort;
    weeklyGraphLabels.appendChild(label);
  });
}

function renderTopSites(sitesArr) {
  const container = document.getElementById("topSitesContainer");
  if (!container) return;
  container.innerHTML = "";

  if (sitesArr.length === 0) {
    container.innerHTML = '<div style="text-align:center; font-size:10px; color:var(--muted)">No data available</div>';
    return;
  }

  sitesArr.slice(0, 5).forEach((site) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "4px";

    const info = document.createElement("div");
    info.style.display = "flex";
    info.style.justifyContent = "space-between";
    info.style.fontSize = "11px";
    info.style.color = "var(--text)";

    const nameStr = document.createElement("span");
    nameStr.textContent = site.domain;
    nameStr.style.fontWeight = "500";

    const pctStr = document.createElement("span");
    pctStr.textContent = `${site.percent}%`;
    pctStr.style.color = "var(--muted)";
    pctStr.style.fontSize = "10px";

    info.appendChild(nameStr);
    info.appendChild(pctStr);

    const track = document.createElement("div");
    track.style.width = "100%";
    track.style.height = "6px";
    track.style.backgroundColor = "var(--border)";
    track.style.borderRadius = "3px";
    track.style.overflow = "hidden";

    const fill = document.createElement("div");
    fill.style.width = `${site.percent}%`;
    fill.style.height = "100%";
    fill.style.backgroundColor = "var(--accent)";
    fill.style.borderRadius = "3px";

    track.appendChild(fill);
    row.appendChild(info);
    row.appendChild(track);
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
async function updateStatusBadge() {
  const auth = await getAuthState();

  if (!auth.accessToken) {
    setStatus("error", "Not signed in — tracking queued");
  } else {
    setStatus("active", "Signed in and tracking active");
  }
}

function setStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function showFeedback(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${type}`;
  setTimeout(() => {
    el.textContent = "";
    el.className = "feedback";
  }, 3000);
}

function showBtnStatus(btn, statusEl, message, type) {
  statusEl.textContent = message;
  btn.classList.remove("success", "error");
  btn.classList.add(type);
  setTimeout(() => {
    statusEl.textContent = "";
    btn.classList.remove("success", "error");
  }, 3000);
}

// ---------------------------------------------------------------------------
// AI site checks + panel live refresh
// ---------------------------------------------------------------------------
const AI_HOSTNAMES = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
];

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    console.log("[DevBrain popup] Injecting content scripts into tab", tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["tracker.js", "contentScript.js"],
    });
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function checkAISite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      btnSaveConversation.hidden = true;
      return;
    }
    const hostname = new URL(tab.url).hostname;
    const isAI = AI_HOSTNAMES.some((h) => hostname.includes(h));
    btnSaveConversation.hidden = !isAI;
  } catch {
    btnSaveConversation.hidden = true;
  }
}

let panelRefreshScheduled = false;

function schedulePanelRefresh() {
  if (panelRefreshScheduled) return;
  panelRefreshScheduled = true;
  setTimeout(async () => {
    panelRefreshScheduled = false;
    await checkAISite();
    await refreshStats();
  }, 200);
}

function registerLiveRefreshListeners() {
  chrome.tabs.onActivated.addListener(() => {
    schedulePanelRefresh();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) return;
    if (changeInfo.status === "complete" || changeInfo.url) {
      schedulePanelRefresh();
    }
  });

  chrome.windows.onFocusChanged.addListener(() => {
    schedulePanelRefresh();
  });

  // History sync is manual only — popup reads the file directly on open and on sync click.
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------
btnSaveTranscript.addEventListener("click", async () => {
  try {
    const auth = await ensureValidSession();
    if (!auth?.accessToken) {
      await hydrateAuthUI();
      await updateStatusBadge();
      showBtnStatus(btnSaveTranscript, statusTranscript, "Please login", "error");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showBtnStatus(btnSaveTranscript, statusTranscript, "No active tab", "error");
      return;
    }

    statusTranscript.textContent = "Capturing…";
    await ensureContentScripts(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, { type: "getPageText" });
    if (!response?.pageText) {
      showBtnStatus(btnSaveTranscript, statusTranscript, "No text found", "error");
      return;
    }

    await chrome.runtime.sendMessage({
      eventType: "page_content",
      domain: new URL(tab.url).hostname,
      url: tab.url,
      pageTitle: tab.title,
      pageText: response.pageText,
    });

    showBtnStatus(btnSaveTranscript, statusTranscript, "✓ Saved", "success");
  } catch (err) {
    showBtnStatus(btnSaveTranscript, statusTranscript, "Failed", "error");
    console.error("[DevBrain] Save transcript error:", err);
  }
});

btnSaveConversation.addEventListener("click", async () => {
  try {
    const auth = await ensureValidSession();
    if (!auth?.accessToken) {
      await hydrateAuthUI();
      await updateStatusBadge();
      showBtnStatus(btnSaveConversation, statusConversation, "Please login", "error");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showBtnStatus(btnSaveConversation, statusConversation, "No active tab", "error");
      return;
    }

    statusConversation.textContent = "Capturing…";
    await ensureContentScripts(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, { type: "getAIConversation" });

    if (!response?.conversation || response.conversation.length === 0) {
      showBtnStatus(btnSaveConversation, statusConversation, "No conversation found", "error");
      return;
    }

    const resolvedUrl = response.url || tab.url || "";
    const resolvedDomain = resolvedUrl ? new URL(resolvedUrl).hostname : null;

    await chrome.runtime.sendMessage({
      eventType: "ai_prompt",
      aiService: response.aiService,
      domain: resolvedDomain,
      url: resolvedUrl,
      pageTitle: response.pageTitle || tab.title || "AI Conversation",
      promptText: JSON.stringify(response.conversation),
    });

    showBtnStatus(
      btnSaveConversation,
      statusConversation,
      `✓ Saved (${response.conversation.length} pairs)`,
      "success"
    );
  } catch (err) {
    showBtnStatus(btnSaveConversation, statusConversation, "Failed", "error");
    console.error("[DevBrain] Save conversation error:", err);
  }
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
tabBtnView.addEventListener("click", () => {
  tabBtnView.classList.add("active");
  tabBtnSearch.classList.remove("active");
  panelView.hidden = false;
  panelSearch.hidden = true;
  document.body.classList.remove("search-active");
});

tabBtnSearch.addEventListener("click", () => {
  tabBtnSearch.classList.add("active");
  tabBtnView.classList.remove("active");
  panelSearch.hidden = false;
  panelView.hidden = true;
  document.body.classList.add("search-active");
  setTimeout(() => searchInput.focus(), 50);
});

// ---------------------------------------------------------------------------
// Search — filter chip + form listeners
// ---------------------------------------------------------------------------
filterTypes.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  chip.classList.toggle("active");
  searchState.page = 0;
  performSearch();
});

filterDates.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  filterDates.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  searchState.page = 0;
  performSearch();
});

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  searchState.page = 0;
  performSearch();
});

// Click delegation: terminal card = copy; URL card = open tab
searchResults.addEventListener("click", (e) => {
  const copyBtn = e.target.closest("[data-action='copy']");
  if (copyBtn) {
    const termCard = e.target.closest(".result-card[data-cmd]");
    if (!termCard) return;
    navigator.clipboard.writeText(termCard.dataset.cmd || "").then(() => {
      termCard.setAttribute("data-copied", "true");
      setTimeout(() => termCard.removeAttribute("data-copied"), 1500);
    }).catch(() => {});
    return;
  }

  const termCard = e.target.closest(".result-card[data-cmd]");
  if (termCard) {
    navigator.clipboard.writeText(termCard.dataset.cmd || "").then(() => {
      termCard.setAttribute("data-copied", "true");
      setTimeout(() => termCard.removeAttribute("data-copied"), 1500);
    }).catch(() => {});
    return;
  }
  const urlCard = e.target.closest(".result-card[data-url]");
  if (urlCard) chrome.tabs.create({ url: urlCard.dataset.url });
});

searchPagination.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.id === "searchPrevBtn") { searchState.page = Math.max(0, searchState.page - 1); performSearch(); }
  else if (btn.id === "searchNextBtn") { searchState.page++; performSearch(); }
});

// ---------------------------------------------------------------------------
// Search — core
// ---------------------------------------------------------------------------
async function performSearch() {
  const q           = searchInput.value.trim();
  const activeTypes = [...filterTypes.querySelectorAll(".chip.active")].map(c => c.dataset.type);
  const activeDate  = filterDates.querySelector(".chip.active")?.dataset.date ?? "";

  // Require at least a query or a type filter to avoid fetching everything
  if (!q && activeTypes.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">Type to search your activity.</div>';
    searchPagination.hidden = true;
    return;
  }

  const auth = await getAuthState();
  if (!auth?.accessToken) {
    searchResults.innerHTML = '<div class="search-empty">Please login to search.</div>';
    return;
  }

  const params = new URLSearchParams();
  if (q)                  params.set("q",     q);
  if (activeTypes.length) params.set("types", activeTypes.join(","));
  if (activeDate === "today") {
    params.set("startDate", new Date().toISOString().split("T")[0]);
  } else if (activeDate === "7d") {
    const d = new Date(); d.setDate(d.getDate() - 7);
    params.set("startDate", d.toISOString().split("T")[0]);
  } else if (activeDate === "30d") {
    const d = new Date(); d.setDate(d.getDate() - 30);
    params.set("startDate", d.toISOString().split("T")[0]);
  }
  params.set("page",  String(searchState.page));
  params.set("limit", String(searchState.limit));

  showSearchSkeleton();
  searchPagination.hidden = true;

  try {
    const res = await fetch(`${auth.endpoint}/api/events/search?${params}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body  = await res.json();
    const items = body.data?.items ?? body.items ?? [];
    const total = body.data?.total ?? body.total ?? 0;
    searchState.total = total;
    renderSearchResults(items, total, auth.endpoint);
  } catch (err) {
    searchResults.innerHTML = `<div class="search-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

function renderSearchResults(items, total, endpoint = "") {
  searchResults.scrollTop = 0;

  if (items.length === 0) {
    searchResults.innerHTML = '<div class="search-empty"><div class="search-empty-icon">🔍</div>No results found.</div>';
    searchPagination.hidden = true;
    return;
  }

  searchResults.innerHTML = "";
  const q = searchInput.value.trim();

  // Result count header
  if (total > 0) {
    const countEl = document.createElement("div");
    countEl.className = "search-count";
    countEl.textContent = `${total.toLocaleString()} result${total === 1 ? "" : "s"}${q ? ` for "${q}"` : ""}`;
    searchResults.appendChild(countEl);
  }

  const frag = document.createDocumentFragment();

  items.forEach((item) => {
    const src        = item.source ?? "web";
    const title      = getResultTitle(item);
    const preview    = getResultPreview(item);
    const dateStr    = item.created_at ? formatResultDate(item.created_at) : "";
    const isTerminal = src === "terminal";

    // Resolve URL
    const url = resolveResultUrl(item, src, endpoint);

    const card = document.createElement("div");
    card.className = "result-card";
    if (url)        card.dataset.url = url;
    if (isTerminal) card.dataset.cmd = title;

    // Badge
    const badge = document.createElement("span");
    badge.className = `result-badge badge-${src}`;
    badge.textContent = src;
    card.appendChild(badge);

    // Title
    const titleEl = document.createElement("div");
    titleEl.className = `result-title${isTerminal ? " terminal" : ""}`;
    titleEl.innerHTML = highlight(title, q);
    titleEl.title = title;
    card.appendChild(titleEl);

    // Preview snippet
    if (preview) {
      const prevEl = document.createElement("div");
      prevEl.className = "result-preview";
      prevEl.innerHTML = highlight(preview, q);
      card.appendChild(prevEl);
    }

    // Footer: date + hint for terminal
    const footer = document.createElement("div");
    footer.className = "result-footer";
    const dateEl = document.createElement("span");
    dateEl.className = "result-date";
    dateEl.textContent = dateStr;
    footer.appendChild(dateEl);

    if (isTerminal) {
      const right = document.createElement("div");
      right.className = "result-footer-right";
      const hint = document.createElement("span");
      hint.className = "result-date";
      hint.textContent = "click to copy";
      hint.style.opacity = "0.5";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "result-copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.setAttribute("data-action", "copy");
      right.appendChild(hint);
      right.appendChild(copyBtn);
      footer.appendChild(right);
    }
    card.appendChild(footer);
    frag.appendChild(card);
  });

  searchResults.appendChild(frag);

  // Pagination
  const totalPages = Math.ceil(total / searchState.limit);
  if (totalPages > 1) {
    searchPagination.hidden = false;
    searchPagination.innerHTML = "";

    const prev = document.createElement("button");
    prev.id = "searchPrevBtn"; prev.className = "btn-ghost";
    prev.style.cssText = "padding:3px 10px;font-size:11px;";
    prev.textContent = "← Prev";
    prev.disabled = searchState.page === 0;

    const info = document.createElement("span");
    info.textContent = `${searchState.page + 1} / ${totalPages}`;

    const next = document.createElement("button");
    next.id = "searchNextBtn"; next.className = "btn-ghost";
    next.style.cssText = "padding:3px 10px;font-size:11px;";
    next.textContent = "Next →";
    next.disabled = (searchState.page + 1) >= totalPages;

    searchPagination.appendChild(prev);
    searchPagination.appendChild(info);
    searchPagination.appendChild(next);
  } else {
    searchPagination.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Search — helpers
// ---------------------------------------------------------------------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showSearchSkeleton() {
  searchResults.innerHTML = "";
  const patterns = [["35%","85%","55%"], ["40%","70%","80%"], ["28%","90%","45%"]];
  patterns.forEach((widths) => {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    card.style.marginBottom = "6px";
    widths.forEach((w, j) => {
      const line = document.createElement("div");
      line.className = "skeleton-line";
      line.style.cssText = `width:${w};${j < widths.length - 1 ? "margin-bottom:6px;" : ""}`;
      card.appendChild(line);
    });
    searchResults.appendChild(card);
  });
}

// XSS-safe: escapes text+query then wraps matched terms with <mark>
function highlight(text, query) {
  const safe = escHtml(String(text || ""));
  if (!query) return safe;
  const terms = escHtml(query.trim())
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
}

function formatResultDate(iso) {
  try {
    const s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const days = Math.floor(s / 86400);
    if (days < 7)  return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return ""; }
}

function parseTerminalJson(text) {
  try { const o = JSON.parse(text ?? ""); return o?.command ?? o?.query ?? null; } catch { return null; }
}

function parseUrlFromText(text) {
  try {
    const o = JSON.parse(text ?? "");
    return o?.url || o?.pageUrl || o?.page_url || o?.link || o?.href || null;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function resolveResultUrl(item, src, endpoint = "") {
  const raw =
    item.url ||
    item.pageUrl ||
    item.page_url ||
    item.link ||
    item.href ||
    parseUrlFromText(item.pageText ?? item.page_text) ||
    (src === "note"  && item.id ? `${REDIRECT_BASE_URL}/notes/${item.id}` : null) ||
    (src === "issue" && item.id ? `${REDIRECT_BASE_URL}/issues/${item.id}` : null) ||
    (item.domain ? item.domain : null);
  return normalizeUrl(raw);
}

function getResultTitle(item) {
  switch (item.source) {
    case "terminal": {
      const cmd = item.command || item.query
        || parseTerminalJson(item.pageText ?? item.page_text)
        || item.title || "";
      return cmd || "(no command)";
    }
    case "ai":         return item.title || item.ai_service || "AI response";
    case "note":       return item.title || "Untitled note";
    case "issue":      return item.title || "Untitled issue";
    case "transcript": return item.title || item.domain || "Transcript";
    default:           return item.title || item.domain || item.url || "—";
  }
}

function getResultPreview(item) {
  return item.snippet || item.preview || item.summary || item.body || "";
}
