console.log("[Content Script] Loaded on:", window.location.href);

(function () {
  // Inject page-hook.js as an external script (CSP-safe)
  function injectScriptFile(fileName) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(fileName); // Load from extension
    s.onload = () => {
      console.log("[Content Script] Successfully injected:", fileName);
      s.remove(); // clean up after load
    };
    s.onerror = () => {
      console.error("[Content Script] Failed to inject:", fileName);
    };
    (document.head || document.documentElement).appendChild(s);
  }

  injectScriptFile("page-hook.js");

  // Listen for messages from page-hook.js and relay to background
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.direction !== "from-page") return;

    console.log("[Content Script] Received message from page:", data.type, data);

    // Pass through the message type and payload from page-hook.js
    console.log("[Content Script] Sending to background:", { type: data.type });
    chrome.runtime.sendMessage(
      {
        type: data.type,
        payload: data.payload,
      },
      (resp) => {
        // Check for errors in message sending
        if (chrome.runtime.lastError) {
          console.error(
            "[Content Script] Error sending message to background:",
            chrome.runtime.lastError
          );
        } else {
          console.log("[Content Script] Background response:", resp);
        }
      }
    );
  });
})();
