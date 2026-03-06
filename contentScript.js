/**
 * contentScript.js — Injected into every page by manifest.json
 *
 * Responsibilities:
 *  1. Detect & report search queries from popular search/developer sites
 *  2. Respond to popup requests:
 *     - "getPageText"       → return page transcript
 *     - "getAIConversation" → return AI prompt/response pairs
 *     - "isAISite"          → tell the popup whether this is an AI chat site
 */

// ---------------------------------------------------------------------------
// Guard: skip non-http pages (chrome://, etc.)
// ---------------------------------------------------------------------------
if (!location.protocol.startsWith("http")) {
  // Graceful exit — do NOT throw, that kills the entire script
  console.log("[DevBrain] Skipping non-HTTP page.");
} else {
  // ---------------------------------------------------------------------------
  // 1. SEARCH TRACKING
  // ---------------------------------------------------------------------------

  function checkForSearch() {
    const query = extractSearchQuery();
    if (!query) return;

    sendEvent({
      eventType: "website_search",
      query,
      domain: location.hostname,
      url: location.href,
      pageTitle: document.title,
    });
  }

  checkForSearch();

  // SPA navigation — re-check on URL changes
  (function patchHistoryAPI() {
    function wrapHistoryMethod(method) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(checkForSearch, 300);
        return result;
      };
    }
    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
  })();

  window.addEventListener("popstate", () => setTimeout(checkForSearch, 300));

  // ---------------------------------------------------------------------------
  // 2. MESSAGE LISTENER — responds to popup / background requests
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) return;

    // --- Ping: lets popup know content scripts are loaded ---
    if (message.type === "ping") {
      sendResponse({ pong: true });
      return;
    }

    // --- Page transcript ---
    if (message.type === "getPageText") {
      const MAX_CHARS = 8000;
      const text = document.body?.innerText?.trim() ?? "";
      if (!text || text.length < 100) {
        sendResponse({ pageText: null });
      } else {
        sendResponse({
          pageText: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "…" : text,
        });
      }
      return;
    }

    // --- Check if current page is an AI site ---
    if (message.type === "isAISite") {
      const aiConfig = getAISiteConfig();
      sendResponse({ isAISite: !!aiConfig, siteName: aiConfig?.hostMatch ?? null });
      return;
    }

    // --- Grab entire AI conversation ---
    if (message.type === "getAIConversation") {
      try {
        const aiConfig = getAISiteConfig();
        if (!aiConfig) {
          sendResponse({ conversation: null });
          return;
        }

        const prompts = [];
        const responses = [];
        const seenPrompts = new Set();
        const seenResponses = new Set();

        for (const el of document.querySelectorAll(aiConfig.promptSel)) {
          const text = aiConfig.getPromptText(el);
          const normalized = text?.trim();
          if (!normalized || seenPrompts.has(normalized)) continue;
          seenPrompts.add(normalized);
          prompts.push(normalized);
        }

        for (const el of document.querySelectorAll(aiConfig.responseSel)) {
          const text = aiConfig.getResponseText(el);
          const normalized = text?.trim();
          if (!normalized || seenResponses.has(normalized)) continue;
          seenResponses.add(normalized);
          responses.push(normalized);
        }

        // Pair prompts and responses into {request, response} objects
        const conversation = [];
        const maxLen = Math.max(prompts.length, responses.length);
        for (let i = 0; i < maxLen; i++) {
          conversation.push({
            request:  i < prompts.length   ? prompts[i]   : null,
            response: i < responses.length ? responses[i] : null,
          });
        }

        sendResponse({
          conversation,
          aiService: aiConfig.hostMatch,
          url: location.href,
          pageTitle: document.title,
        });
      } catch (err) {
        console.error("[DevBrain] getAIConversation failed:", err);
        sendResponse({ conversation: null, error: err?.message ?? "unknown_error" });
      }
      return;
    }
  });
}
