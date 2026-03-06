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

const API_ENDPOINT = "http://localhost:8080/api/events"; // DataNexus Spring Boot backend
const IDLE_THRESHOLD_SEC = 60;    // consider user idle after 60 s of inactivity

// Hardcoded JWT for local testing — replaces popup-entered key
const HARDCODED_API_KEY = "eyJhbGciOiJIUzM4NCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJqb2huZG9lIiwiaWF0IjoxNzcyNjk4NTA2LCJleHAiOjE3NzI3ODQ5MDZ9.Zn45PYyoeRsLIRFTP8GQa0uvngIjLWtWPfym7pfWraDaw06Ngl0LXhZE2-mSgVvw";

// ---------------------------------------------------------------------------
// In-memory state (survives only while the service worker is alive)
// ---------------------------------------------------------------------------

/**
 * { [tabId]: { url, domain, title, startTime, windowId } }
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
 * Reads the API key from storage, then POSTs all queued events to the backend.
 * On success the queue is cleared; on failure events remain for retry.
 */
async function flushEvents() {
  // Use the persisted queue as the single source of truth.
  // (enqueueEvent writes to storage; the in-memory eventQueue is just a warm
  // cache — merging both would create duplicates, so we only use storage here.)
  const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");

  // Use hardcoded key for local testing; fallback to storage key if cleared
  const local = await chrome.storage.local.get("apiKey");
  const sync  = await chrome.storage.sync.get("apiKey");
  const apiKey = HARDCODED_API_KEY || local.apiKey || sync.apiKey || null;

  console.log(
    `[DevBrain] flushEvents() — queue=${pendingEvents.length} event(s), apiKey=${apiKey ? "✓ present" : "✗ missing"}`
  );

  if (pendingEvents.length === 0) {
    console.log("[DevBrain] Queue empty, nothing to flush.");
    return;
  }

  if (!apiKey) {
    console.warn("[DevBrain] No API key set — events are queued locally until you save a key in the popup.");
    return;
  }

  const payload = { events: pendingEvents };

  console.log(`[DevBrain] Sending ${pendingEvents.length} event(s) to ${API_ENDPOINT}`);
  console.log("[DevBrain] Payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

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
    windowId: windowId ?? null,
  };
  console.log(`[DevBrain] ▶ Focus started: tab=${tabId} url=${url}`);
}

/**
 * Called when a tab loses focus or navigates away.
 * Computes time spent and enqueues a `website_visit` event.
 */
async function stopTrackingTab(tabId) {
  const info = activeTabs[tabId];
  if (!info) {
    console.log(`[DevBrain] ⏹ stopTrackingTab(${tabId}) — no active info (SW may have restarted)`);
    return;
  }

  const timeSpentMs = Date.now() - info.startTime;
  delete activeTabs[tabId];

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
  // Stop tracking the previous tab in this window (flushes its website_visit)
  const prevTabId = activeTabPerWindow[windowId];
  if (prevTabId !== undefined && prevTabId !== tabId) {
    await stopTrackingTab(prevTabId);
  }
  activeTabPerWindow[windowId] = tabId;

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
  // Keep activeTabs URL current for SPA navigation (pushState fires a URL change
  // event without triggering status:"complete", so we must update here separately).
  if (changeInfo.url && activeTabs[tabId]) {
    activeTabs[tabId].url    = changeInfo.url;
    activeTabs[tabId].domain = extractDomain(changeInfo.url);
    activeTabs[tabId].title  = tab.title ?? activeTabs[tabId].title;
  }

  if (changeInfo.status !== "complete") return;
  if (shouldIgnoreUrl(tab.url)) return;

  // Flush the old URL's focus time for this tab
  if (activeTabs[tabId]) {
    await stopTrackingTab(tabId);
  }

  // Restart only if this tab is the active tab in the focused window
  if (tab.active && tab.windowId === focusedWindowId) {
    startTrackingTab(tabId, tab.url, tab.title, tab.windowId);
  }
});

/**
 * Fired when a tab is closed. Record whatever focus time it accumulated.
 */
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await stopTrackingTab(tabId);
  delete activeTabPerWindow[removeInfo.windowId];
});

/**
 * Fired when OS focus moves between Chrome windows, or Chrome loses focus entirely.
 * Stop all timers when focus leaves; resume for the active tab when focus returns.
 */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // Stop all running timers (focus left the previous window)
  for (const id of Object.keys(activeTabs)) {
    await stopTrackingTab(Number(id));
  }

  focusedWindowId = windowId;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    console.log("[DevBrain] Chrome lost OS focus — all timers paused.");
    return;
  }

  // Start timing the active tab in the newly focused window
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab && !shouldIgnoreUrl(activeTab.url)) {
      activeTabPerWindow[windowId] = activeTab.id;
      startTrackingTab(activeTab.id, activeTab.url, activeTab.title, windowId);
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// Idle detection — pause focus timers when user steps away
// ---------------------------------------------------------------------------

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    // Stop all running timers
    for (const tabId of Object.keys(activeTabs)) {
      await stopTrackingTab(Number(tabId));
    }
    console.log("[DevBrain] User idle/locked — all timers paused.");
  } else if (state === "active") {
    // Resume timing the active tab in the focused window
    if (focusedWindowId !== -1 && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: focusedWindowId });
        if (activeTab && !shouldIgnoreUrl(activeTab.url)) {
          startTrackingTab(activeTab.id, activeTab.url, activeTab.title, focusedWindowId);
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
  // Setup side panel behavior to open when extension icon is clicked
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("[DevBrain] Error setting side panel behavior:", error));

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
