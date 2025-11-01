const storageLocal = chrome.storage.local;

/**
 * Adds a key-value pair to local store
 * @param key string
 * @param value T | unknown
 */
const addToLocalStorage = async (key, value) => {
  if (!storageLocal) {
    throw new Error("Local storage unavailable...");
  }
  await storageLocal.set({
    [key]: value,
  });
};

/**
 * Get value from local store given key
 * @param key string
 * @returns Promise<T | undefined>
 */
const getFromLocalStorage = async (key) => {
  if (!storageLocal) return undefined;
  const value = await storageLocal.get(key);
  return value?.[key];
};

/**
 * Delete a key from local store
 * @param key string
 * @returns Promise<void>
 */
const deleteFromLocalStorage = async (key) => {
  if (!storageLocal) return;
  await storageLocal.remove(key);
};

const fetchApi = async (url, body = undefined, method = "GET") => {
  // Prepare the request options
  const options = {
    method: method.toUpperCase(),
    credentials: "omit",
  };

  // Prepare body
  if (body && method.toUpperCase() !== "GET") {
    options.body = JSON.stringify(body ?? {});
    options.headers = {
      "Content-Type": "application/json",
    };
  }

  // Perform the fetch call
  const response = await fetch(url, options);

  // Throw error if response not ok
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  // Parse and return the JSON response
  return await response.json();
};

const ENV = {
  BACKEND_URL: "https://aunpbdtpdp.us-west-2.awsapprunner.com",
  FETCH_IP_URL: "https://api.ipify.org/?format=json",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[Background] Received message:", msg?.type, msg);

  // Wrap async logic in IIFE to properly handle async/await with sendResponse
  (async () => {
    try {
      if (msg && msg.type === "PAGE_LOG" && msg.payload) {
        console.log("[BACKGROUND] PAGE_LOG", msg.payload);
        // Optionally store last N logs
        const res = await chrome.storage.local.get(["logs"]);
        const logs = res.logs || [];
        logs.push({ ts: Date.now(), payload: msg.payload });
        if (logs.length > 1000) logs.shift();
        await chrome.storage.local.set({ logs });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "INVOKE_CONVERSATION_API") {
        console.log("[Background] Processing INVOKE_CONVERSATION_API...");

        // Get client-ip
        const clientIp =
          (await getFromLocalStorage("clientIp")) ||
          (await Promise.race([
            fetchApi(ENV.FETCH_IP_URL),
            new Promise((_, r) =>
              setTimeout(() => r(new Error("Timeout")), 5000)
            ),
          ])
            .then(async (d) =>
              d?.ip ? (await addToLocalStorage("clientIp", d.ip), d.ip) : ""
            )
            .catch((e) => (console.error("IP fetch failed:", e), "")));

        const {
          conversation_id,
          user_prompt,
          raw_assistant_response,
          search_queries,
          recommended_products,
          news_articles,
          sources,
        } = msg.payload;

        console.log("[Background] Calling backend API:", `${ENV.BACKEND_URL}/api/ingest`);

        const response = await fetchApi(
          `${ENV.BACKEND_URL}/api/ingest`,
          {
            source: "chatgpt-extension",
            conversation_id,
            user_query_text: user_prompt,
            raw_chatgpt_text: raw_assistant_response,
            heuristics: {
              recommended_products,
              search_queries,
              news_articles,
              sources,
            },
            client_ip: clientIp,
            user_name: (await getFromLocalStorage("userName")) || "test-User",
            brand_name: (await getFromLocalStorage("brandName")) || "test-Brand",
          },
          "POST"
        );

        if (!response?.ok) {
          console.warn("Conversation ingest responded without ok=true", response);
          sendResponse({ ok: false });
        } else {
          console.info("Conversation API ingested successfully: ", response);
          sendResponse({ ok: true });
        }
        return;
      }

      if (msg && msg.type === "INVOKE_PRODUCT_API" && msg.payload) {
        console.log("[Background] Processing INVOKE_PRODUCT_API...");
        console.log("Starting call");
        const { conversationId, productData } = msg.payload;
        console.log("{msg.payload}: ", msg.payload);

        console.log("[Background] Calling backend API:", `${ENV.BACKEND_URL}/api/ingest-product`);

        const response = await fetchApi(
          `${ENV.BACKEND_URL}/api/ingest-product`,
          {
            source: "chatgpt-extension",
            conversation_id: conversationId,
            user_name: (await getFromLocalStorage("userName")) || "Test-User",
            brand_name: (await getFromLocalStorage("brandName")) || "Test-Brand",
            product_name: productData.product_name,
            product_data: productData,
          },
          "POST"
        );

        if (!response?.ok) {
          console.warn("Product ingest responded without ok=true", response);
          sendResponse({ ok: false });
        } else {
          console.info("Product API ingested successfully: ", response);
          sendResponse({ ok: true });
        }
        return;
      }

      // Fallback: Handle unrecognized/ignored message types
      // This ensures sendResponse() is ALWAYS called, preventing message channel errors
      console.log("[Background] Received unhandled message type:", msg?.type);
      sendResponse({ ok: true, ignored: true });
    } catch (err) {
      console.error("[Background] Error handling message:", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  // Return true to keep the message channel open for async sendResponse
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  console.log("Extension icon clicked on", tab.url);
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });
});
