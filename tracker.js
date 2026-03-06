/**
 * tracker.js — Shared utility functions injected into every page
 *
 * This file is loaded BEFORE contentScript.js so its helpers are available
 * to the content script at initialisation time.
 *
 * Responsibilities:
 *  - Provide a unified `sendEvent(payload)` wrapper around chrome.runtime.sendMessage
 *  - Provide URL-parsing helpers to extract search queries
 *  - Export AI site configuration used by contentScript.js
 */

// ---------------------------------------------------------------------------
// Event sender
// ---------------------------------------------------------------------------

/**
 * Sends a structured event to the background service worker.
 *
 * @param {Object} payload  - The event object (eventType is required)
 */
function sendEvent(payload) {
  chrome.runtime.sendMessage(
    { ...payload, timestamp: new Date().toISOString() },
    (response) => {
      // Suppress "extension context invalidated" errors that occur if the
      // extension is reloaded while the page is still open.
      if (chrome.runtime.lastError) {
        // Silently ignore — the event will be lost but the page won't break
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Search query extraction
// ---------------------------------------------------------------------------

/**
 * Map of hostname patterns → the URL query-param that holds the search term.
 *
 * Patterns are tested via String.includes() against location.hostname.
 */
const SEARCH_ENGINE_PARAMS = {
  "google.com":       "q",
  "bing.com":         "q",
  "duckduckgo.com":   "q",
  "yahoo.com":        "p",
  "youtube.com":      "search_query",
  "github.com":       "q",
  "stackoverflow.com":"q",
  "reddit.com":       "q",
  "npmjs.com":        "q",
  "pypi.org":         "q",
  "crates.io":        "q",
  "docs.rs":          "q",
  "mdn.io":           "q",
  "developer.mozilla.org": "q",
};

/**
 * Tries to extract a search query from the current page URL.
 *
 * @returns {string|null} The decoded query string, or null if not a search page.
 */
function extractSearchQuery() {
  const hostname = location.hostname;
  const params = new URLSearchParams(location.search);

  for (const [domain, param] of Object.entries(SEARCH_ENGINE_PARAMS)) {
    if (hostname.includes(domain)) {
      const query = params.get(param);
      if (query && query.trim().length > 0) return query.trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI tool site configuration
// ---------------------------------------------------------------------------

/**
 * Describes how to scrape prompts and responses from each AI chat tool.
 *
 * Each entry:
 *  - hostMatch   {string}  substring to test against location.hostname
 *  - promptSel   {string}  CSS selector for the user's message container
 *  - responseSel {string}  CSS selector for the assistant's reply container
 *  - getPromptText   {Function}  receives an Element, returns its text content
 *  - getResponseText {Function}  receives an Element, returns its text content
 *
 * NOTE: These selectors are best-effort. AI chat UIs change frequently.
 * Update selectors if the sites redesign their DOM.
 */
const AI_SITE_CONFIGS = [
  // -------------------------------------------------------------------------
  // ChatGPT  (chatgpt.com — new domain; chat.openai.com — legacy)
  // -------------------------------------------------------------------------
  {
    hostMatch: "chatgpt.com",
    promptSel: '[data-message-author-role="user"]',
    responseSel: '[data-message-author-role="assistant"]',
    getPromptText: (el) => el.innerText?.trim() ?? "",
    getResponseText: (el) => el.innerText?.trim() ?? "",
  },
  {
    hostMatch: "chat.openai.com",
    promptSel: '[data-message-author-role="user"]',
    responseSel: '[data-message-author-role="assistant"]',
    getPromptText: (el) => el.innerText?.trim() ?? "",
    getResponseText: (el) => el.innerText?.trim() ?? "",
  },

  // -------------------------------------------------------------------------
  // Claude.ai  (claude.ai)
  // -------------------------------------------------------------------------
  {
    hostMatch: "claude.ai",
    promptSel: '[data-testid="human-turn"], .human-turn, [class*="human"]',
    responseSel: '[data-testid="ai-turn"], .ai-turn, [class*="assistant"]',
    getPromptText: (el) => el.innerText?.trim() ?? "",
    getResponseText: (el) => el.innerText?.trim() ?? "",
  },

  // -------------------------------------------------------------------------
  // Google Gemini  (gemini.google.com)
  // -------------------------------------------------------------------------
  {
    hostMatch: "gemini.google.com",
    promptSel: ".query-content, .user-query, [data-query-text]",
    responseSel: ".model-response-text, .response-content, .markdown-main-panel",
    getPromptText: (el) => el.innerText?.trim() ?? el.textContent?.trim() ?? "",
    getResponseText: (el) => el.innerText?.trim() ?? el.textContent?.trim() ?? "",
  },
];

/**
 * Returns the AI site config for the current page, or null if not an AI site.
 * Validates that at least one selector matches something in the DOM.
 */
function getAISiteConfig() {
  const cfg = AI_SITE_CONFIGS.find((c) => location.hostname.includes(c.hostMatch)) ?? null;
  if (!cfg) return null;

  // Verify at least one selector actually matches DOM elements
  const hasPrompts   = document.querySelectorAll(cfg.promptSel).length > 0;
  const hasResponses = document.querySelectorAll(cfg.responseSel).length > 0;

  if (hasPrompts || hasResponses) return cfg;

  console.warn(`[DevBrain] AI site detected (${cfg.hostMatch}) but no matching selectors in DOM.`);
  return cfg; // Still return it — elements may appear later via dynamic rendering
}

// Expose helpers on window so contentScript.js (loaded after) can access them
// without needing ES module imports (content scripts share the same page scope).
window.__devBrain = {
  sendEvent,
  extractSearchQuery,
  getAISiteConfig,
};
