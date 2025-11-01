(function () {
  const CONVERSATION_TARGET_URL =
    "https://chatgpt.com/backend-api/f/conversation";
  const PRODUCT_TARGET_URL =
    "https://chatgpt.com/backend-api/search/product_info";

  // Helper to sanitize objects for postMessage
  function sanitize(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const copy = {};
    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      const value = obj[key];
      if (value instanceof AbortSignal) continue;
      if (value instanceof Function) continue;
      try {
        copy[key] = JSON.parse(JSON.stringify(value));
      } catch {
        /* skip */
      }
    }
    return copy;
  }

  function post(type, payload) {
    console.log("[Page Hook] Posting message:", type, { direction: "from-page", type, payload });
    window.postMessage({ direction: "from-page", type, payload }, "*");
  }

  // --- Non-blocking stream processor ---
  // This function processes a stream asynchronously without blocking the response
  async function processStreamAsync(stream, url, method) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let collected = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value && value.length) {
          const textChunk = decoder.decode(value, { stream: true });
          collected += textChunk;
        }
      }

      // Process in background without blocking main thread
      setTimeout(() => {
        try {
          if (url === CONVERSATION_TARGET_URL) {
            const parsedData = parseSSEtoJSON(collected);
            const structuredData = extractConversationData(parsedData);

            // Send via postMessage - content.js will relay to background.js
            post("INVOKE_CONVERSATION_API", structuredData);

            post("request_completed", {
              url,
              method,
              json: structuredData,
            });

            // Optional: Log only in background processing
            console.log("[ChatGPT Monitor] Conversation data captured:", {
              conversation_id: structuredData.conversation_id,
              user_prompt: structuredData.user_prompt.substring(0, 100) + "...",
              response_length: structuredData.raw_assistant_response.length,
            });
          } else if (url === PRODUCT_TARGET_URL) {
            const parsedData = parseSSEtoJSON(collected);
            const structuredData = extractProductData(parsedData);
            const urlParts = url.split("/");

            // Send via postMessage - content.js will relay to background.js
            post("INVOKE_PRODUCT_API", {
              conversationId: urlParts[urlParts.length - 1],
              productData: structuredData,
            });

            post("request_completed", {
              url,
              method,
              json: structuredData,
            });

            // Optional: Log only in background processing
            console.log("[ChatGPT Monitor] Product data captured:", {
              product_name: structuredData.product_info?.product_name,
              num_reviews: structuredData.reviews?.length,
            });
          }
        } catch (err) {
          console.error("[ChatGPT Monitor] Error processing stream data:", err);
        }
      }, 0);
    } catch (err) {
      console.error("[ChatGPT Monitor] Stream reading error:", err);
    }
  }


  // --- Hook fetch ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const requestInfo = args[0];
      const requestInit = args[1] || {};
      const method = (
        requestInit.method ||
        (requestInfo && requestInfo.method) ||
        "GET"
      ).toUpperCase();
      const url =
        typeof requestInfo === "string"
          ? requestInfo
          : (requestInfo && requestInfo.url) || "";

      // Only target the specific URL
      if (url === PRODUCT_TARGET_URL || url === CONVERSATION_TARGET_URL) {
        post("request_triggered", {
          url,
          method,
          requestInit: sanitize(requestInit),
        });
      }

      const response = await originalFetch.apply(this, args);

      if (url === CONVERSATION_TARGET_URL) {
        // Use .tee() to split the stream into two identical streams
        const [stream1, stream2] = response.body.tee();

        // Process one stream asynchronously in the background (non-blocking)
        processStreamAsync(stream2, url, method);

        // Return immediately with the other stream for ChatGPT (preserves real-time streaming)
        return new Response(stream1, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      if (url === PRODUCT_TARGET_URL) {
        // Use .tee() to split the stream into two identical streams
        const [stream1, stream2] = response.body.tee();

        // Process one stream asynchronously in the background (non-blocking)
        processStreamAsync(stream2, url, method);

        // Return immediately with the other stream for ChatGPT (preserves real-time streaming)
        return new Response(stream1, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      return response;
    } catch (err) {
      if (
        args[0] &&
        (args[0] === CONVERSATION_TARGET_URL ||
          args[0] === PRODUCT_TARGET_URL ||
          (args[0].url &&
            (args[0].url === CONVERSATION_TARGET_URL ||
              args[0].url === PRODUCT_TARGET_URL)))
      ) {
        post("request_error", { error: String(err) });
      }
      throw err;
    }
  };

  // --- Hook XMLHttpRequest ---
  // NOTE: This XHR hook should be safe since it listens to 'load' after the response is complete,
  // and XHR is generally less prone to stream consumption issues than fetch().
  (function () {
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      let reqUrl = null;
      let reqMethod = null;

      const origOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        reqUrl = url;
        reqMethod =
          method && method.toUpperCase ? method.toUpperCase() : method;
        return origOpen.apply(this, [method, url, ...rest]);
      };

      const origSend = xhr.send;
      xhr.send = function (body) {
        // Only log if URL matches
        if (
          reqUrl &&
          (reqUrl === CONVERSATION_TARGET_URL || reqUrl === PRODUCT_TARGET_URL)
        ) {
          post("request_triggered", {
            url: reqUrl,
            method: reqMethod,
            bodyPreview:
              (typeof body === "string" && body.slice(0, 200)) || null,
          });
        }

        xhr.addEventListener("load", function () {
          if (
            reqUrl &&
            (reqUrl === CONVERSATION_TARGET_URL ||
              reqUrl === PRODUCT_TARGET_URL)
          ) {
            const txt = xhr.responseText;
            let parsed = null;
            try {
              parsed = JSON.parse(txt);
            } catch (e) {}
            post("request_completed", {
              url: reqUrl,
              method: reqMethod,
              status: xhr.status,
              raw: txt,
              json: parsed,
            });
          }
        });

        xhr.addEventListener("error", function () {
          if (
            reqUrl &&
            (reqUrl === CONVERSATION_TARGET_URL ||
              reqUrl === PRODUCT_TARGET_URL)
          ) {
            post("request_error", {
              url: reqUrl,
              method: reqMethod,
              status: xhr.status,
            });
          }
        });

        return origSend.apply(this, [body]);
      };

      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = HookedXHR;
  })();

  console.log("[Page Hook] Fetch and XHR hooks installed successfully");
  console.log("[Page Hook] Monitoring URLs:", CONVERSATION_TARGET_URL, PRODUCT_TARGET_URL);

  post("inject_done", {
    msg: "fetch and XHR hooked for CONVERSATION_TARGET_URL and PRODUCT_TARGET_URL only",
  });
})();

// function parseEventLine(line, state = {}) {
//   // Only handle lines with the right prefix
//   if (!line.includes("event delta data")) return state;

//   // Remove the leading prefix
//   const dataString = line.replace("event delta data ", "");
//   const segments = dataString.split(", ");
//   const event = {};
//   segments.forEach((segment) => {
//     // Handle "key value", "key", or "key value with spaces"
//     const spaceIdx = segment.indexOf(" ");
//     if (spaceIdx > 0) {
//       const key = segment.slice(0, spaceIdx).trim();
//       let value = segment.slice(spaceIdx + 1).trim();
//       // Remove quotes if present
//       if (value.startsWith('"') && value.endsWith('"')) {
//         value = value.slice(1, -1);
//       }
//       event[key] = value;
//     } else {
//       event[segment] = true; // flag param, no value
//     }
//   });

//   // Apply logic only for add/replace
//   if (event.o === "add" || event.o === "append") {
//     state[event.p] = (state[event.p] || "") + (event.v || "");
//   } else if (event.o === "replace") {
//     state[event.p] = event.v || "";
//   }

//   return state;
// }

/**
 * Parse Server-Sent Events (SSE) format into JSON objects
 * @param {string} sseText - Raw SSE text data
 * @returns {Array} Array of parsed event objects
 */
function parseSSEtoJSON(sseText) {
  // Split by double newlines to separate events
  const events = sseText.trim().split(/\n\n+/);

  const parsedEvents = [];

  events.forEach((eventBlock) => {
    const lines = eventBlock.trim().split("\n");
    const eventObj = {};

    lines.forEach((line) => {
      // Match "event: value" or "data: value" format
      const match = line.match(/^(event|data):\s*(.*)$/);

      if (match) {
        const [, key, value] = match;

        if (key === "event") {
          eventObj.event = value;
        } else if (key === "data") {
          // Try to parse data as JSON
          try {
            eventObj.data = JSON.parse(value);
          } catch (e) {
            // If not valid JSON, store as string
            eventObj.data = value;
          }
        }
      }
    });

    // Only add if we have at least an event or data field
    if (Object.keys(eventObj).length > 0) {
      parsedEvents.push(eventObj);
    }
  });

  return parsedEvents;
}

// function applyDeltaEvents(events) {
//   // Initialize your state object
//   const state = {};

//   // Utility to resolve paths like "/matched_text"
//   function setValue(path, op, value) {
//     // Remove leading slash
//     const key = path.replace(/^\//, "");
//     if (op === "append") {
//       state[key] = (state[key] || "") + value;
//     } else if (op === "replace") {
//       state[key] = value;
//     }
//   }

//   for (const eventObj of events) {
//     if (!eventObj.data || !eventObj.data.v) continue;
//     if (eventObj?.data?.v?.length > 0) {
//       for (const delta of eventObj.data.v) {
//         setValue(delta.p, delta.o, delta.v);
//       }
//     }
//   }

//   return state;
// }

function extractConversationData(eventStreamData) {
  const result = {
    conversation_id: "",
    user_prompt: "",
    raw_assistant_response: "",
    search_queries: [],
    sources: [],
    recommended_products: [],
    news_articles: [],
    metadata: {
      model: "",
      request_id: "",
      turn_exchange_id: "",
      title: "",
    },
  };

  // Extract conversation ID
  const convIdEvent = eventStreamData.find(
    (item) => item.data?.conversation_id
  );
  if (convIdEvent) {
    result.conversation_id = convIdEvent.data.conversation_id;
  }

  // Extract user prompt
  for (const item of eventStreamData) {
    if (
      item.event === "delta" &&
      item.data?.v?.message?.author?.role === "user" &&
      item.data?.v?.message?.content?.parts?.[0]
    ) {
      result.user_prompt = item.data.v.message.content.parts[0];
      break;
    }
  }

  // Extract search queries
  for (const item of eventStreamData) {
    if (item.data?.v?.message?.metadata?.search_model_queries?.queries) {
      result.search_queries.push(
        ...item.data.v.message.metadata.search_model_queries.queries
      );
    }
  }

  // Extract title
  for (const item of eventStreamData) {
    if (item.data?.type === "title_generation" && item.data?.title) {
      result.metadata.title = item.data.title;
    }
  }

  // Extract metadata
  for (const item of eventStreamData) {
    if (item.data?.v?.message?.metadata) {
      const meta = item.data.v.message.metadata;
      if (meta.model_slug) result.metadata.model = meta.model_slug;
      if (meta.request_id) result.metadata.request_id = meta.request_id;
      if (meta.turn_exchange_id)
        result.metadata.turn_exchange_id = meta.turn_exchange_id;
    }
  }

  // Extract sources from content_references (sources_footnote only)
  for (const item of eventStreamData) {
    if (item.event === "delta" && item.data?.v) {
      const patches = Array.isArray(item.data.v) ? item.data.v : [item.data.v];

      for (const patch of patches) {
        if (patch.p && patch.p.includes("content_references") && patch.v) {
          const refs = Array.isArray(patch.v) ? patch.v : [patch.v];

          for (const ref of refs) {
            // Extract sources footnote only
            if (ref.type === "sources_footnote" && ref.sources) {
              for (const source of ref.sources) {
                result.sources.push({
                  title: source.title,
                  url: source.url,
                  attribution: source.attribution,
                });
              }
            }
          }
        }
      }
    }

    // Extract product data when `data.v` is an array containing product info
    for (const item of eventStreamData) {
      if (
        item.data?.v &&
        Array.isArray(item.data.v) &&
        item.data.v.length > 0
      ) {
        for (const dataItem of item.data.v) {
          // check for nested product object
          if (dataItem.v?.product) {
            const p = dataItem.v.product;
            result.recommended_products.push({
              product_name: p.title || "",
              price: p.price || "",
              recommended_by: p.merchants || "",
              rating: p.rating || "",
              num_reviews: p.num_reviews || "",
              image_url: Array.isArray(p.image_urls) ? p.image_urls[0] : "",
              url: p.url || "",
            });
          }
        }
      }

      // also handle direct product objects (not in array)
      if (item.data?.v?.product) {
        const p = item.data.v.product;
        result.recommended_products.push({
          product_name: p.title || "",
          price: p.price || "",
          recommended_by: p.merchants || "",
          rating: p.rating || "",
          num_reviews: p.num_reviews || "",
          image_url: Array.isArray(p.image_urls) ? p.image_urls[0] : "",
          url: p.url || "",
        });
      }
    }
  }

  // Extract search result groups (news articles, etc.)
  for (const item of eventStreamData) {
    if (item.event === "delta") {
      // Check for search_result_groups in metadata
      if (item.data?.v?.message?.metadata?.search_result_groups) {
        const groups = item.data.v.message.metadata.search_result_groups;
        for (const group of groups) {
          for (const entry of group.entries) {
            result.news_articles.push({
              title: entry.title,
              url: entry.url,
              snippet: entry.snippet || "",
              domain: group.domain,
              attribution: entry.attribution,
              pub_date: entry.pub_date || null,
            });
          }
        }
      }

      // Check for search_result_groups append operations
      if (
        item.data?.p === "/message/metadata/search_result_groups" &&
        item.data?.o === "append" &&
        Array.isArray(item.data?.v)
      ) {
        for (const group of item.data.v) {
          for (const entry of group.entries) {
            result.news_articles.push({
              title: entry.title,
              url: entry.url,
              snippet: entry.snippet || "",
              domain: group.domain,
              attribution: entry.attribution,
              pub_date: entry.pub_date || null,
            });
          }
        }
      }

      // Check for additional search_result_groups
      if (item.data?.v && Array.isArray(item.data.v)) {
        for (const group of item.data.v) {
          if (group.type === "search_result_group" && group.entries) {
            for (const entry of group.entries) {
              result.news_articles.push({
                title: entry.title,
                url: entry.url,
                snippet: entry.snippet || "",
                domain: group.domain,
                attribution: entry.attribution,
                pub_date: entry.pub_date || null,
              });
            }
          }
        }
      }

      // Check in patch operations for search_result_groups
      if (
        item.data?.p === "/message/metadata/search_result_groups" &&
        item.data?.o === "add" &&
        Array.isArray(item.data?.v)
      ) {
        for (const group of item.data.v) {
          if (group.entries) {
            for (const entry of group.entries) {
              result.news_articles.push({
                title: entry.title,
                url: entry.url,
                snippet: entry.snippet || "",
                domain: group.domain,
                attribution: entry.attribution,
                pub_date: entry.pub_date || null,
              });
            }
          }
        }
      }
    }
  }

  // Extract raw assistant response by collecting all text parts
  const textParts = [];
  for (const item of eventStreamData) {
    if (item.event === "delta" && item.data?.o) {
      // Check for text append operations
      if (
        item.data.p === "/message/content/parts/0" &&
        item.data.o === "append" &&
        typeof item.data.v === "string"
      ) {
        textParts.push(item.data.v);
      }
      // Also check for patch operations with text
      if (item.data.o === "patch" && Array.isArray(item.data.v)) {
        for (const patch of item.data.v) {
          if (
            patch.p === "/message/content/parts/0" &&
            patch.o === "append" &&
            typeof patch.v === "string"
          ) {
            textParts.push(patch.v);
          }
        }
      }
    }
  }
  result.raw_assistant_response = textParts.join("");

  // Remove duplicate products based on product_name
  result.recommended_products = result.recommended_products.filter(
    (product, index, self) =>
      index === self.findIndex((p) => p.product_name === product.product_name)
  );

  // Remove duplicate news articles based on URL
  result.news_articles = result.news_articles.filter(
    (article, index, self) =>
      index === self.findIndex((a) => a.url === article.url)
  );

  // Remove duplicate sources based on URL
  result.sources = result.sources.filter(
    (source, index, self) =>
      index === self.findIndex((s) => s.url === source.url)
  );

  return result;
}

function extractProductData(eventsArray) {
  const result = {
    product_info: {},
    rationales: [],
    reviews: [],
    reviewSummary: "",
  }; //declaring veriables

  let currentRationale = null;
  let currentReview = null;

  for (const entry of eventsArray) {
    if (entry.event !== "delta") continue;

    const data = entry.data;
    const v = data?.v;
    if (!v) continue;

    if (Array.isArray(v)) {
      for (const patch of v) {
        const path = patch.p || "";
        const val = patch.v;
        const op = patch.o;

        if (
          currentRationale &&
          path.startsWith("/rationale") &&
          op === "append"
        ) {
          currentRationale.rationale += val;
        }

        if (currentReview && path.startsWith("/summary") && op === "append") {
          currentReview.summary += val;
        }

        if (path === "/reviews" && op === "append" && Array.isArray(val)) {
          for (const review of val) {
            result.reviews.push({
              source: review.source || null,
              theme: review.theme || null,
              summary: review.summary || null,
              rating: review.rating || null,
              num_reviews: review.num_reviews || null,
              sentiment: review.sentiment || null,
              cite: review.cite || null,
              cite_url: review.cite_url || null,
            });
          }
        }

        if (currentRationale && path.startsWith("/grouped_citation")) {
          currentRationale.grouped_citation =
            currentRationale.grouped_citation || {};
          const key = path.replace("/grouped_citation/", "");
          if (key && typeof val !== "undefined") {
            currentRationale.grouped_citation[key] = val;
          }
        }
      }
      continue;
    }

    // --- Product Info (unchanged)
    if (v.type === "product_entity") {
      const p = v.product || {};
      let merchants = [];

      if (Array.isArray(p.merchants)) merchants = p.merchants;
      else if (typeof p.merchants === "string") merchants = [p.merchants];

      result.product_info = {
        product_name: p.title || null,
        merchants,
        price: p.price || null,
        rating: p.rating || null,
        num_reviews: p.num_reviews || null,
        url: p.url || null,
        description: p.description || null,
        offers: p.offers || [],
      };
    }

    // --- Rationale start
    else if (v.type === "product_rationale") {
      currentRationale = {
        rationale: v.rationale || "",
        citations: v.citations || [],
        grouped_citation: v.grouped_citation || null,
      };

      // Extract review-like info from grouped_citation.refs and supporting_websites
      const refs = v.grouped_citation?.refs || [];
      for (const ref of refs) {
        const reviewItem = {
          title: ref.title || null,
          url: ref.url || null,
          snippet: ref.snippet || null,
          supporting_websites: [],
        };

        if (Array.isArray(ref.supporting_websites)) {
          for (const site of ref.supporting_websites) {
            reviewItem.supporting_websites.push({
              title: site.title || null,
              url: site.url || null,
              snippet: site.snippet || null,
              pub_date: site.pub_date || null,
            });
          }
        }

        result.reviews.push(reviewItem);
      }

      // Sometimes grouped_citation itself has supporting_websites
      if (Array.isArray(v.grouped_citation?.supporting_websites)) {
        for (const site of v.grouped_citation.supporting_websites) {
          result.reviews.push({
            title: site.title || null,
            url: site.url || null,
            snippet: site.snippet || null,
            pub_date: site.pub_date || null,
          });
        }
      }

      result.rationales.push(currentRationale);
    }

    // --- Reviews block (summary etc.)
    else if (v.type === "product_reviews") {
      currentReview = {
        summary: v.summary || "",
        reviews: v.reviews || [],
        cite_map: v.cite_map || {},
      };
      result.reviewSummary = currentReview.summary;
    }
  }

  if (result.rationales.length) {
    result.summary_text = result.rationales
      .map((r) => r.rationale.trim())
      .join(" ");
  }

  return result;
}
