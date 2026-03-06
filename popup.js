/**
 * popup.js — Controls the extension popup UI
 *
 * Responsibilities:
 *  - Load saved API key & endpoint and populate fields on open
 *  - Save API key & endpoint to chrome.storage.sync when the user clicks Save
 *  - Show today's event stats (visits, searches, AI prompts) from local storage
 *  - Persist tracking toggle states (visits / searches / AI)
 *
 * Events are sent automatically every 1 minute by the background service worker.
 *
 * chrome.storage.sync  — stores small settings that sync across devices
 * chrome.storage.local — stores the event queue (large, local only)
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");

const inputApiKey   = document.getElementById("inputApiKey");
const inputEndpoint = document.getElementById("inputEndpoint");
const btnSaveKey    = document.getElementById("btnSaveKey");
const feedbackKey   = document.getElementById("feedbackKey");

const toggleVisits   = document.getElementById("toggleVisits");
const toggleSearches = document.getElementById("toggleSearches");

const statVisits   = document.getElementById("statVisits");
const statAI       = document.getElementById("statAI");
const weeklyGraphChart  = document.getElementById("weeklyGraphChart");
const weeklyGraphLabels = document.getElementById("weeklyGraphLabels");

const btnSaveTranscript    = document.getElementById("btnSaveTranscript");
const btnSaveConversation  = document.getElementById("btnSaveConversation");
const statusTranscript     = document.getElementById("statusTranscript");
const statusConversation   = document.getElementById("statusConversation");

// ---------------------------------------------------------------------------
// Initialise popup
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await updateStatusBadge();
  await checkAISite();
  await refreshStats(); // Now fetches from API
});

// ---------------------------------------------------------------------------
// Load saved settings from chrome.storage.sync
// ---------------------------------------------------------------------------
async function loadSettings() {
  const data = await chrome.storage.sync.get([
    "apiKey",
    "endpoint",
    "trackVisits",
    "trackSearches"
  ]);

  if (data.apiKey) {
    const k = data.apiKey;
    inputApiKey.value =
      k.length > 8 ? k.slice(0, 4) + "••••••••" + k.slice(-4) : "••••••••";
    inputApiKey.dataset.saved = "true";
  }

  inputEndpoint.value = data.endpoint ?? "http://localhost:8080";

  toggleVisits.checked   = data.trackVisits   !== false;
  toggleSearches.checked = data.trackSearches !== false;

  updateActionButtonsState();
}

// ---------------------------------------------------------------------------
// Save API key & endpoint
// ---------------------------------------------------------------------------
btnSaveKey.addEventListener("click", async () => {
  const rawKey   = inputApiKey.value.trim();
  const endpoint = inputEndpoint.value.trim();

  if (inputApiKey.dataset.saved === "true" && rawKey.includes("••••")) {
    if (endpoint) await chrome.storage.sync.set({ endpoint });
    showFeedback(feedbackKey, "Settings saved.", "ok");
    await refreshStats();
    return;
  }

  if (!rawKey) {
    showFeedback(feedbackKey, "Please enter an API key.", "err");
    inputApiKey.classList.add("invalid");
    return;
  }

  inputApiKey.classList.remove("invalid");
  inputApiKey.classList.add("valid");
  inputApiKey.dataset.saved = "true";

  await chrome.storage.sync.set({
    apiKey: rawKey,
    endpoint: endpoint || "http://localhost:8080",
  });

  // Also copy to local so background.js can read it without sync latency
  await chrome.storage.local.set({ apiKey: rawKey, endpoint });

  showFeedback(feedbackKey, "API key saved successfully.", "ok");
  await updateStatusBadge();
  await refreshStats();
});

inputApiKey.addEventListener("input", () => {
  inputApiKey.dataset.saved = "false";
  inputApiKey.classList.remove("valid", "invalid");
});

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

toggleVisits.addEventListener("change",   saveToggles);
toggleSearches.addEventListener("change", saveToggles);

function updateActionButtonsState() {
  const disabled = !toggleVisits.checked;
  btnSaveTranscript.disabled = disabled;
  btnSaveConversation.disabled = disabled;
  if (disabled) {
    btnSaveTranscript.title = "Enable Website Visits tracking to use this feature";
    btnSaveConversation.title = "Enable Website Visits tracking to use this feature";
  } else {
    btnSaveTranscript.title = "";
    btnSaveConversation.title = "";
  }
}

// ---------------------------------------------------------------------------
// Stats — fetch from API
// ---------------------------------------------------------------------------
async function refreshStats() {
  const sync = await chrome.storage.sync.get(["apiKey", "endpoint"]);
  const local = await chrome.storage.local.get(["apiKey"]);
  const apiKey = sync.apiKey || local.apiKey;
  const endpoint = sync.endpoint || "http://localhost:8080";

  if (!apiKey) return;

  try {
    const res = await fetch(`${endpoint}/api/events/stats`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    
    if (!res.ok) throw new Error("Stats API failed");
    
    const body = await res.json();
    const data = body.data || body; // Adjust based on ApiResponse structure
    
    statVisits.textContent = data.visitsToday ?? "0";
    statAI.textContent     = data.aiPromptsToday ?? "0";
    
    if (data.weeklyGraph && Array.isArray(data.weeklyGraph)) {
      renderWeeklyGraph(data.weeklyGraph);
    }
    
    // Render top 5 sites if data is available
    if (data.topSites && Array.isArray(data.topSites)) {
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
  
  const maxVal = Math.max(...dataPoints.map(d => d.count), 1); // Avoid div by 0
  
  dataPoints.forEach(point => {
    // Height percentage (min 4% so 0-count bars are still slightly visible)
    const heightPct = Math.max((point.count / maxVal) * 100, 4);
    
    // Create bar
    const bar = document.createElement("div");
    bar.style.width = "12%";
    bar.style.height = `${heightPct}%`;
    bar.style.backgroundColor = "var(--accent)";
    bar.style.borderRadius = "2px 2px 0 0";
    bar.style.opacity = point.count > 0 ? "1" : "0.3";
    bar.title = `${point.count} events`;
    weeklyGraphChart.appendChild(bar);
    
    // Create label
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
    container.innerHTML = `<div style="text-align:center; font-size:10px; color:var(--muted)">No data available</div>`;
    return;
  }
  
  sitesArr.slice(0, 5).forEach(site => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "4px";
    
    // 1. Label and percentage row
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
    
    // 2. Progress bar outer track
    const track = document.createElement("div");
    track.style.width = "100%";
    track.style.height = "6px";
    track.style.backgroundColor = "var(--border)";
    track.style.borderRadius = "3px";
    track.style.overflow = "hidden";
    
    // 3. Progress bar inner fill
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
// Status badge
// ---------------------------------------------------------------------------
async function updateStatusBadge() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");

  if (!apiKey) {
    setStatus("error", "No API key — tracking paused");
  } else {
    setStatus("active", "Auto-sending every 1 min");
  }
}

function setStatus(type, text) {
  statusDot.className   = `status-dot ${type}`;
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function showFeedback(el, message, type) {
  el.textContent = message;
  el.className   = `feedback ${type}`;
  setTimeout(() => {
    el.textContent = "";
    el.className   = "feedback";
  }, 3000);
}

// ---------------------------------------------------------------------------
// Action button feedback helper
// ---------------------------------------------------------------------------
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
// Known AI site hostnames (used for URL-based detection in popup)
// ---------------------------------------------------------------------------
const AI_HOSTNAMES = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
];

// ---------------------------------------------------------------------------
// Ensure content scripts are injected into the given tab.
// After extension reload, existing tabs lose their content scripts.
// We programmatically inject them so our messages have a receiver.
// ---------------------------------------------------------------------------
async function ensureContentScripts(tabId) {
  try {
    // Try a quick probe first — if the content script is already loaded it will respond
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    // Content script is NOT loaded — inject it now
    console.log("[DevBrain popup] Injecting content scripts into tab", tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["tracker.js", "contentScript.js"],
    });
    // Give scripts a moment to initialise
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------------------
// Check if current tab is an AI site → show/hide "Save Conversation" button
// Uses the tab URL directly — no content script needed.
// ---------------------------------------------------------------------------
async function checkAISite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const hostname = new URL(tab.url).hostname;
    const isAI = AI_HOSTNAMES.some((h) => hostname.includes(h));
    if (isAI) {
      btnSaveConversation.hidden = false;
    }
  } catch {
    // Ignore — button stays hidden
  }
}

// ---------------------------------------------------------------------------
// Save Transcript — grabs page text from current tab
// ---------------------------------------------------------------------------
btnSaveTranscript.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showBtnStatus(btnSaveTranscript, statusTranscript, "No active tab", "error");
      return;
    }

    statusTranscript.textContent = "Capturing…";

    // Ensure content scripts are injected before sending the message
    await ensureContentScripts(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, { type: "getPageText" });

    if (!response?.pageText) {
      showBtnStatus(btnSaveTranscript, statusTranscript, "No text found", "error");
      return;
    }

    // Send to background for event queueing
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

// ---------------------------------------------------------------------------
// Save Conversation — grabs AI chat from current tab
// ---------------------------------------------------------------------------
btnSaveConversation.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showBtnStatus(btnSaveConversation, statusConversation, "No active tab", "error");
      return;
    }

    statusConversation.textContent = "Capturing…";

    // Ensure content scripts are injected before sending the message
    await ensureContentScripts(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, { type: "getAIConversation" });

    if (!response?.conversation || response.conversation.length === 0) {
      showBtnStatus(btnSaveConversation, statusConversation, "No conversation found", "error");
      return;
    }

    // Stringify the full conversation and send as a single event
    await chrome.runtime.sendMessage({
      eventType: "ai_prompt",
      aiService: response.aiService,
      domain: new URL(response.url).hostname,
      url: response.url,
      pageTitle: response.pageTitle,
      promptText: JSON.stringify(response.conversation),
    });

    showBtnStatus(btnSaveConversation, statusConversation, `✓ Saved (${response.conversation.length} pairs)`, "success");
  } catch (err) {
    showBtnStatus(btnSaveConversation, statusConversation, "Failed", "error");
    console.error("[DevBrain] Save conversation error:", err);
  }
});
