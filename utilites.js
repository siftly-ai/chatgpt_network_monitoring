/**
 * Parse streaming API response to clean JSON format
 * @param {string} streamText - The raw streaming response text
 * @returns {object} Parsed JSON with query, response_text, products, and sources
 */
export function parseStreamToJSON(streamText) {
  const result = {
    query: "",
    response_text: "",
    products: [],
    sources: [],
  };

  // Extract user query
  const queryMatch = streamText.match(/"parts":\["([^"]+)"\]/);
  if (queryMatch) {
    result.query = queryMatch[1];
  }

  // Extract complete response text
  const responseParts = [];
  const appendMatches = streamText.matchAll(/"o":"append","v":"([^"]+)"/g);

  for (const match of appendMatches) {
    responseParts.push(match[1]);
  }

  result.response_text = responseParts
    .join("")
    .replace(/\\n/g, "\n")
    .replace(/\\u20b9/g, "₹")
    .replace(/\\u202f/g, " ")
    .replace(/\\u2011/g, "-")
    .replace(/\\"/g, '"');

  // Extract products
  result.products = extractProducts(streamText);

  // Extract sources
  result.sources = extractSources(streamText);

  return result;
}

/**
 * Extract products from streaming data
 * @param {string} streamText - The raw streaming response text
 * @returns {array} Array of product objects
 */
function extractProducts(streamText) {
  const products = [];

  // Find the products section
  const productsMatch = streamText.match(
    /"products":\[(.*?)\],"target_product_count"/s
  );

  if (!productsMatch) return products;

  const productsText = productsMatch[1];

  // Extract individual product objects
  const productRegex =
    /"title":"([^"]+)".*?"price":"([^"]+)".*?"rating":([0-9.]+).*?"num_reviews":(\d+).*?"merchants":"([^"]+)".*?"featured_tag":"([^"]*)"/gs;

  let match;
  while ((match = productRegex.exec(productsText)) !== null) {
    products.push({
      title: match[1].replace(/\\u202f/g, " ").replace(/\\u2011/g, "-"),
      price: match[2].replace(/\\u20b9/g, "₹"),
      rating: parseFloat(match[3]),
      reviews: parseInt(match[4]),
      merchants: match[5],
      tag: match[6] || null,
    });
  }

  return products;
}

/**
 * Extract sources from streaming data
 * @param {string} streamText - The raw streaming response text
 * @returns {array} Array of source objects
 */
function extractSources(streamText) {
  const sources = [];

  // Find the sources section
  const sourcesMatch = streamText.match(/"sources":\[(.*?)\],"has_images"/s);

  if (!sourcesMatch) return sources;

  const sourcesText = sourcesMatch[1];

  // Extract individual source objects
  const sourceRegex =
    /"title":"([^"]+)","url":"([^"]+)","attribution":"([^"]+)"/g;

  let match;
  while ((match = sourceRegex.exec(sourcesText)) !== null) {
    sources.push({
      title: match[1],
      url: match[2].replace(/\?utm_source=chatgpt\.com/g, ""),
      attribution: match[3],
    });
  }

  return sources;
}
