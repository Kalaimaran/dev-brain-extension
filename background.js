/**
 * background.js — Manifest V3 Service Worker
 *
 * Responsibilities:
 *  - Listen for tab lifecycle events (create, update, activate, remove)
 *  - Track time-on-page by recording when a tab becomes active / inactive
 *  - Receive messages from content scripts (searches, AI prompts/responses)
 *  - Batch and flush events to the backend API
 *  - Manage idle detection to stop timers when user is away
 *
 * MV3 Note: Service workers are ephemeral — they spin up for events and shut
 * down when idle. All persistent state lives in chrome.storage.local.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "http://localhost:8080";
const EVENTS_PATH = "/api/events";
const IDLE_THRESHOLD_SEC = 60;    // consider user idle after 60 s of inactivity

// ---------------------------------------------------------------------------
// In-memory state (survives only while the service worker is alive)
// ---------------------------------------------------------------------------

/**
 * { [tabId]: { url, domain, title, startTime, accumulatedMs, windowId } }
 * Only contains tabs that are CURRENTLY being timed (active + focused window).
 */
const activeTabs = {};

/**
 * { [windowId]: tabId }
 * Tracks which tab is active in each window so we can stop it on tab switch.
 */
const activeTabPerWindow = {};

/** The Chrome window that currently has OS focus. -1 = Chrome not focused. */
let focusedWindowId = -1;

/** Pending events waiting to be flushed */
let eventQueue = [];

// Prevent overlapping startup recovery runs.
let recoveryInProgress = false;
let trackingStateHydrated = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract domain from a full URL string. Returns null for chrome:// pages. */
function extractDomain(url) {
  try {
    const { hostname } = new URL(url);
    return hostname || null;
  } catch {
    return null;
  }
}

/** Returns true for URLs we should NOT track (browser internals, etc.) */
function shouldIgnoreUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("data:")
  );
}

/** ISO timestamp string */
const now = () => new Date().toISOString();

/** Persist current in-memory tracking state so it survives SW suspension. */
async function persistTrackingState() {
  try {
    await chrome.storage.local.set({
      trackedActiveTabs: activeTabs,
      trackedActiveTabPerWindow: activeTabPerWindow,
      trackedFocusedWindowId: focusedWindowId,
    });
  } catch (err) {
    console.warn("[DevBrain] Failed to persist tracking state:", err);
  }
}

/** Restore tracking state captured before SW suspension. */
async function hydrateTrackingState() {
  if (trackingStateHydrated) return;
  try {
    const data = await chrome.storage.local.get([
      "trackedActiveTabs",
      "trackedActiveTabPerWindow",
      "trackedFocusedWindowId",
    ]);

    Object.assign(activeTabs, data.trackedActiveTabs || {});
    Object.assign(activeTabPerWindow, data.trackedActiveTabPerWindow || {});
    if (typeof data.trackedFocusedWindowId === "number") {
      focusedWindowId = data.trackedFocusedWindowId;
    }
  } catch (err) {
    console.warn("[DevBrain] Failed to hydrate tracking state:", err);
  } finally {
    trackingStateHydrated = true;
  }
}

/**
 * MV3 service workers reset in-memory state when suspended.
 * Recover focused window + active tab so tracking resumes after wake-up.
 */
async function recoverFocusedContext() {
  if (recoveryInProgress) return;
  recoveryInProgress = true;
  try {
    await hydrateTrackingState();

    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win || !win.focused || win.id === chrome.windows.WINDOW_ID_NONE) {
      focusedWindowId = chrome.windows.WINDOW_ID_NONE;
      await persistTrackingState();
      return;
    }

    focusedWindowId = win.id;
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!activeTab || shouldIgnoreUrl(activeTab.url)) return;

    activeTabPerWindow[win.id] = activeTab.id;
    if (activeTabs[activeTab.id]) {
      resumeTrackingTab(activeTab.id);
    } else {
      startTrackingTab(activeTab.id, activeTab.url, activeTab.title, win.id);
    }
    await persistTrackingState();
  } catch (err) {
    console.warn("[DevBrain] Failed to recover focused context:", err);
  } finally {
    recoveryInProgress = false;
  }
}

async function refreshAccessToken(endpointBase, refreshToken) {
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${endpointBase}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    const body = await res.json().catch(() => ({}));
    const data = body?.data || {};
    if (!res.ok || !body?.success || !data?.accessToken) {
      return null;
    }

    await chrome.storage.sync.set({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      tokenType: data.tokenType || "Bearer",
      expiresIn: data.expiresIn || null,
      user: data.user || null,
    });
    await chrome.storage.local.set({
      accessToken: data.accessToken,
      endpoint: endpointBase,
    });

    return data.accessToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event queue & API flush
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings cache (populated on startup and updated via storage events)
// ---------------------------------------------------------------------------
let trackVisits = true;
let trackSearches = true;

/**
 * Adds an event to the in-memory queue AND persists it to chrome.storage so
 * it survives a service-worker restart before flush completes.
 */
async function enqueueEvent(event) {
  // Check tracking toggles before queueing
  if (event.eventType === "website_visit" && !trackVisits) {
    console.log(`[DevBrain] 🚫 Ignored website_visit event (tracking disabled)`);
    return;
  }
  if (event.eventType === "website_search" && !trackSearches) {
    console.log(`[DevBrain] 🚫 Ignored website_search event (tracking disabled)`);
    return;
  }

  const entry = { ...event, timestamp: event.timestamp ?? now() };
  eventQueue.push(entry);

  // Persist to storage so the event survives a SW restart
  const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");
  await chrome.storage.local.set({ pendingEvents: [...pendingEvents, entry] });

  console.log(`[DevBrain] Queued event: type=${entry.eventType}`, entry);

  // Send immediately — no waiting for a timer
  await flushEvents();
}

/**
 * Reads the access token from storage, then POSTs all queued events to the backend.
 * On success the queue is cleared; on failure events remain for retry.
 */
async function flushEvents() {
  // Use the persisted queue as the single source of truth.
  // (enqueueEvent writes to storage; the in-memory eventQueue is just a warm
  // cache — merging both would create duplicates, so we only use storage here.)
  const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");

  const local = await chrome.storage.local.get(["accessToken", "endpoint"]);
  const sync  = await chrome.storage.sync.get(["accessToken", "endpoint", "refreshToken"]);
  const accessToken = local.accessToken || sync.accessToken || null;
  const refreshToken = sync.refreshToken || null;
  const endpointBase = (sync.endpoint || local.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const eventsEndpoint = `${endpointBase}${EVENTS_PATH}`;

  console.log(
    `[DevBrain] flushEvents() — queue=${pendingEvents.length} event(s), accessToken=${accessToken ? "✓ present" : "✗ missing"}`
  );

  if (pendingEvents.length === 0) {
    console.log("[DevBrain] Queue empty, nothing to flush.");
    return;
  }

  if (!accessToken) {
    console.warn("[DevBrain] No access token — events are queued locally until user logs in from popup.");
    return;
  }

  const payload = { events: pendingEvents };

  console.log(`[DevBrain] Sending ${pendingEvents.length} event(s) to ${eventsEndpoint}`);
  console.log("[DevBrain] Payload:", JSON.stringify(payload, null, 2));

  try {
    let res = await fetch(eventsEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 401 && refreshToken) {
      const newAccessToken = await refreshAccessToken(endpointBase, refreshToken);
      if (newAccessToken) {
        res = await fetch(eventsEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${newAccessToken}`,
          },
          body: JSON.stringify(payload),
        });
      }
    }

    const responseText = await res.text();

    if (res.ok) {
      // Clear both in-memory cache and persisted queue
      eventQueue = [];
      await chrome.storage.local.set({ pendingEvents: [] });
      console.log(`[DevBrain] ✓ Flushed successfully. Status=${res.status} Response=${responseText}`);
    } else {
      console.error(`[DevBrain] ✗ Flush failed. Status=${res.status} Response=${responseText}`);
    }
  } catch (err) {
    console.error("[DevBrain] ✗ Network error during flush:", err.message, err);
    // Events remain in storage for the next flush attempt
  }
}

// ---------------------------------------------------------------------------
// Tab time-tracking helpers
// ---------------------------------------------------------------------------

/**
 * Called when a tab becomes the active, focused tab.
 * Records the start time so we can compute focus time later.
 */
function startTrackingTab(tabId, url, title, windowId) {
  if (shouldIgnoreUrl(url)) return;
  activeTabs[tabId] = {
    url,
    domain: extractDomain(url),
    title: title ?? "",
    startTime: Date.now(),
    accumulatedMs: 0,
    windowId: windowId ?? null,
  };
  void persistTrackingState();
  console.log(`[DevBrain] ▶ Focus started: tab=${tabId} url=${url}`);
}

/** Pause timer without emitting an event (used for idle/unfocused states). */
function pauseTrackingTab(tabId) {
  const info = activeTabs[tabId];
  if (!info || info.startTime == null) return;
  info.accumulatedMs += Date.now() - info.startTime;
  info.startTime = null;
  void persistTrackingState();
}

/** Resume timer after pause (keeps previously accumulated active time). */
function resumeTrackingTab(tabId) {
  const info = activeTabs[tabId];
  if (!info || info.startTime != null) return;
  info.startTime = Date.now();
  void persistTrackingState();
}

/**
 * Called when a tab loses focus or navigates away.
 * Computes time spent and enqueues a `website_visit` event.
 */
async function stopTrackingTab(tabId) {
  await hydrateTrackingState();
  const info = activeTabs[tabId];
  if (!info) {
    console.log(`[DevBrain] ⏹ stopTrackingTab(${tabId}) — no active info (SW may have restarted)`);
    return;
  }

  const runningMs = info.startTime == null ? 0 : (Date.now() - info.startTime);
  const timeSpentMs = (info.accumulatedMs ?? 0) + runningMs;
  delete activeTabs[tabId];
  await persistTrackingState();

  // Ignore visits shorter than 2 seconds (likely accidental/redirects)
  if (timeSpentMs < 2000) {
    console.log(`[DevBrain] ⏹ stopTrackingTab(${tabId}) — skipped (${timeSpentMs}ms < 2s threshold)`);
    return;
  }

  console.log(`[DevBrain] ⏹ Recording website_visit: tab=${tabId} url=${info.url} time=${timeSpentMs}ms`);

  await enqueueEvent({
    eventType: "website_visit",
    domain: info.domain,
    url: info.url,
    pageTitle: info.title,
    timeSpentMs,
  });
}

// ---------------------------------------------------------------------------
// Tab lifecycle listeners — focus time tracking
// ---------------------------------------------------------------------------

/**
 * Fired when the active tab in a window changes (user clicks a different tab).
 * Stop the timer for the tab that just lost focus; start one for the new tab.
 * NOTE: Chrome's onActivated does NOT provide previousTabId — we track it ourselves
 * via activeTabPerWindow.
 */
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await hydrateTrackingState();

  // SW may have restarted and lost focus state; recover it lazily.
  if (focusedWindowId === -1) {
    await recoverFocusedContext();
  }

  // Stop tracking the previous tab in this window (flushes its website_visit)
  const prevTabId = activeTabPerWindow[windowId];
  if (prevTabId !== undefined && prevTabId !== tabId) {
    await stopTrackingTab(prevTabId);
  }
  activeTabPerWindow[windowId] = tabId;
  await persistTrackingState();

  // Only time the new tab if this window currently has OS focus
  if (windowId !== focusedWindowId) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!shouldIgnoreUrl(tab.url)) {
      startTrackingTab(tabId, tab.url, tab.title, windowId);
    }
  } catch {
    // Tab may have been closed immediately
  }
});

/**
 * Fired when a tab finishes loading a new URL.
 * If this tab is currently being timed, flush the old URL visit and restart
 * the timer for the new URL (only if it's still the active, focused tab).
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await hydrateTrackingState();

  // URL change means user is leaving the previous page in this tab.
  // Flush FIRST so the visit is attributed to the page being left, not the new URL.
  if (changeInfo.url) {
    if (activeTabs[tabId]) {
      await stopTrackingTab(tabId);
    }

    // Start timing the new URL immediately for SPA navigation where "complete"
    // may never fire after pushState/replaceState.
    if (tab.active && tab.windowId === focusedWindowId && !shouldIgnoreUrl(changeInfo.url)) {
      startTrackingTab(tabId, changeInfo.url, tab.title, tab.windowId);
    }
    return;
  }

  if (changeInfo.status !== "complete") return;

  // If already tracking this tab, keep metadata fresh without resetting time.
  if (activeTabs[tabId]) {
    activeTabs[tabId].title = tab.title ?? activeTabs[tabId].title;
    await persistTrackingState();
    return;
  }

  if (shouldIgnoreUrl(tab.url)) return;

  // Start only if this tab is the active tab in the focused window.
  if (tab.active && tab.windowId === focusedWindowId) {
    startTrackingTab(tabId, tab.url, tab.title, tab.windowId);
  }
});

/**
 * Fired when a tab is closed. Record whatever focus time it accumulated.
 */
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await hydrateTrackingState();
  await stopTrackingTab(tabId);
  delete activeTabPerWindow[removeInfo.windowId];
  await persistTrackingState();
});

/**
 * Fired when OS focus moves between Chrome windows, or Chrome loses focus entirely.
 * Stop all timers when focus leaves; resume for the active tab when focus returns.
 */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await hydrateTrackingState();

  // Pause all running timers (do not emit while user is just unfocused)
  for (const id of Object.keys(activeTabs)) {
    pauseTrackingTab(Number(id));
  }

  focusedWindowId = windowId;
  await persistTrackingState();

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    console.log("[DevBrain] Chrome lost OS focus — all timers paused.");
    return;
  }

  // Resume timing the active tab in the newly focused window
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab && !shouldIgnoreUrl(activeTab.url)) {
      activeTabPerWindow[windowId] = activeTab.id;
      if (activeTabs[activeTab.id]) {
        resumeTrackingTab(activeTab.id);
      } else {
        startTrackingTab(activeTab.id, activeTab.url, activeTab.title, windowId);
      }
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// Idle detection — pause focus timers when user steps away
// ---------------------------------------------------------------------------

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);

chrome.idle.onStateChanged.addListener(async (state) => {
  await hydrateTrackingState();
  if (state === "idle" || state === "locked") {
    // Pause all running timers (no emit on idle)
    for (const tabId of Object.keys(activeTabs)) {
      pauseTrackingTab(Number(tabId));
    }
    console.log("[DevBrain] User idle/locked — all timers paused.");
  } else if (state === "active") {
    // Resume timing the active tab in the focused window
    if (focusedWindowId !== -1 && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: focusedWindowId });
        if (activeTab && !shouldIgnoreUrl(activeTab.url)) {
          if (activeTabs[activeTab.id]) {
            resumeTrackingTab(activeTab.id);
          } else {
            startTrackingTab(activeTab.id, activeTab.url, activeTab.title, focusedWindowId);
          }
        }
      } catch {}
    }
  }
});

// ---------------------------------------------------------------------------
// Message handler — receives events from content scripts
// ---------------------------------------------------------------------------

/**
 * Content scripts and popup use chrome.runtime.sendMessage() to
 * push events into the background for queueing and flushing.
 *
 * Messages from content scripts have sender.tab (we can enrich with tab metadata).
 * Messages from popup do NOT have sender.tab (popup already provides domain/url).
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.eventType) return;

  (async () => {
    // Only enrich from sender.tab if the fields aren't already provided
    const enriched = {
      ...message,
      tabId: message.tabId ?? sender.tab?.id,
      domain: message.domain ?? (sender.tab?.url ? extractDomain(sender.tab.url) : undefined),
    };

    console.log(`[DevBrain] Message received: type=${enriched.eventType}`, enriched);
    await enqueueEvent(enriched);
    sendResponse({ ok: true });
  })();

  // Return true to keep the message channel open for the async response
  return true;
});

// Events are flushed immediately inside enqueueEvent() — no alarm needed.

// ---------------------------------------------------------------------------
// Startup: re-hydrate queue + find the focused window and start timing
// ---------------------------------------------------------------------------
(async () => {
  await hydrateTrackingState();

  // Setup side panel behavior to open when extension icon is clicked
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("[DevBrain] Error setting side panel behavior:", error));

  await recoverFocusedContext();
  console.log(`[DevBrain] Tracking ${Object.keys(activeTabs).length} tab(s) on startup.`);
})();

// ---------------------------------------------------------------------------
// Settings — initialize and listen for changes
// ---------------------------------------------------------------------------
chrome.storage.sync.get(["trackVisits", "trackSearches"], (data) => {
  if (data.trackVisits !== undefined) trackVisits = data.trackVisits;
  if (data.trackSearches !== undefined) trackSearches = data.trackSearches;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.trackVisits !== undefined) {
      trackVisits = changes.trackVisits.newValue;
    }
    if (changes.trackSearches !== undefined) {
      trackSearches = changes.trackSearches.newValue;
    }
  }
});
