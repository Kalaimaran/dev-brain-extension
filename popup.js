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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await ensureValidSession();
  await hydrateAuthUI();
  await updateStatusBadge();
  await checkAISite();
  await refreshStats();
  registerLiveRefreshListeners();
  registerProfileMenuListeners();
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
