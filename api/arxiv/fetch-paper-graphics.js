import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as cheerio from "cheerio";
dotenv.config();
// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
// Log initialization
console.log("[INIT] Initializing services...");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
console.log("[INIT] Gemini 2.0 Flash model initialized");
// Human-like behavior constants for arxiv.org only
const BATCH_SIZE = 200;
const BASE_DELAY = 5000; // Base delay between actions
const VARIANCE_FACTOR = 0.3; // 30% variance in timing
const MIN_PAGE_VIEW_TIME = 5000; // Minimum time to view a page
const MAX_PAGE_VIEW_TIME = 15000; // Maximum time to view a page
// Browser simulation headers
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};
// Simulate human-like delay (for arxiv.org only)
function getHumanDelay(baseTime) {
  const variance = baseTime * VARIANCE_FACTOR;
  const randomVariance = (Math.random() - 0.5) * 2 * variance;
  return Math.max(baseTime + randomVariance, 1000);
}
function getReadingTime(text) {
  // Simplified reading time calculation
  return Math.min(
    Math.max(3000, (text.length / 1000) * 500),
    MAX_PAGE_VIEW_TIME
  );
}
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// New function to extract figures from HTML using Cheerio
async function extractFiguresWithCheerio(html, arxivId) {
  console.log(
    `[HTML PARSER] Starting Cheerio figure extraction for paper ${arxivId}`
  );
  try {
    const $ = cheerio.load(html);
    const figures = [];
    const processedImages = new Set(); // Track processed images to avoid duplicates
    console.log(`[HTML PARSER] Looking for image tags in HTML...`);
    // Find all img tags and process them
    const imgCount = $("img").length;
    console.log(`[HTML PARSER] Found ${imgCount} total images in the document`);
    $("img").each((i, el) => {
      const img = $(el);
      const src = img.attr("src");
      // Skip if no source or already processed
      if (!src || processedImages.has(src)) {
        return;
      }
      console.log(
        `[HTML PARSER] Processing image ${i + 1}/${imgCount}: ${src}`
      );
      // Find the container element
      let container = img.closest(
        'figure, div.figure, [class*="figure"], [class*="image"]'
      );
      if (!container.length) {
        container = img.parent();
      }
      // Find caption from multiple sources
      let caption = "";
      // 1. Check for figcaption
      const figcaption = container.find("figcaption").first();
      if (figcaption.length) {
        caption = figcaption.text().trim();
        console.log(
          `[HTML PARSER] Found figcaption: ${caption.substring(0, 50)}...`
        );
      }
      // 2. Check for caption class
      if (!caption) {
        const captionEl = container
          .find('.caption, [class*="caption"]')
          .first();
        if (captionEl.length) {
          caption = captionEl.text().trim();
          console.log(
            `[HTML PARSER] Found caption via class: ${caption.substring(
              0,
              50
            )}...`
          );
        }
      }
      // 3. Check for adjacent paragraph with figure reference
      if (!caption) {
        const nextP = img.next("p");
        if (nextP.length && nextP.text().match(/^(figure|fig\.?)\s+\d+/i)) {
          caption = nextP.text().trim();
          console.log(
            `[HTML PARSER] Found adjacent paragraph caption: ${caption.substring(
              0,
              50
            )}...`
          );
        }
      }
      // 4. Look for any nearby paragraph with figure reference
      if (!caption) {
        container.find("p").each((i, p) => {
          const pText = $(p).text().trim();
          if (pText.match(/^(figure|fig\.?)\s+\d+/i)) {
            caption = pText;
            console.log(
              `[HTML PARSER] Found nearby paragraph caption: ${caption.substring(
                0,
                50
              )}...`
            );
            return false; // break the each loop
          }
        });
      }
      // 5. Check image alt text for additional info
      const altText = img.attr("alt") || "";
      if (altText && altText.match(/figure|fig\.?\s*\d+/i)) {
        console.log(`[HTML PARSER] Found useful alt text: ${altText}`);
        if (!caption) {
          caption = altText;
        }
      }
      // Skip if caption suggests this is a table
      if (isTableCaption(caption)) {
        console.log(
          `[HTML PARSER] Skipping - appears to be a table caption: ${caption.substring(
            0,
            50
          )}...`
        );
        return;
      }
      // Extract figure number
      let figNumber = figures.length + 1;
      // Try to get figure number from caption, alt text, or image source
      const figMatch = caption.match(/figure\s+(\d+)|fig\.?\s*(\d+)/i);
      if (figMatch) {
        figNumber = parseInt(figMatch[1] || figMatch[2]);
        console.log(
          `[HTML PARSER] Extracted figure number from caption: ${figNumber}`
        );
      } else {
        const altMatch = altText.match(/figure\s+(\d+)|fig\.?\s*(\d+)/i);
        if (altMatch) {
          figNumber = parseInt(altMatch[1] || altMatch[2]);
          console.log(
            `[HTML PARSER] Extracted figure number from alt text: ${figNumber}`
          );
        } else {
          const srcMatch = src.match(/fig(\d+)|figure(\d+)/i);
          if (srcMatch) {
            figNumber = parseInt(srcMatch[1] || srcMatch[2]);
            console.log(
              `[HTML PARSER] Extracted figure number from src: ${figNumber}`
            );
          } else {
            console.log(
              `[HTML PARSER] Using default figure number: ${figNumber}`
            );
          }
        }
      }
      // Mark image as processed
      processedImages.add(src);
      // Create caption info
      const originalCaption = caption;
      const shortCaption = createShortCaption(caption);
      console.log(`[HTML PARSER] Original caption: ${originalCaption}`);
      console.log(`[HTML PARSER] Simplified caption: ${shortCaption}`);
      // Add to figures array
      addFigure(figures, {
        type: "figure",
        index: figNumber,
        caption: shortCaption || `Figure ${figNumber}`,
        content: processImageUrl(src, arxivId),
        identifier: `Figure-${figNumber}`,
        originalCaption: originalCaption || `Figure ${figNumber}`,
      });
      console.log(`[HTML PARSER] Added figure ${figNumber} to collection`);
    });
    console.log(
      `[HTML PARSER] Initial extraction found ${figures.length} figures`
    );
    // Sort figures by index
    figures.sort((a, b) => a.index - b.index);
    // Ensure sequential numbering with no gaps
    for (let i = 0; i < figures.length; i++) {
      if (i === 0 || figures[i].index > figures[i - 1].index + 1) {
        // Potentially missing numbers, so reassign sequentially
        const oldIndex = figures[i].index;
        figures[i].index = i + 1;
        figures[i].identifier = `Figure-${i + 1}`;
        console.log(
          `[HTML PARSER] Renumbered figure ${oldIndex} to ${
            i + 1
          } for sequential ordering`
        );
      }
    }
    console.log(
      `[HTML PARSER] Final count: ${figures.length} figures extracted with Cheerio`
    );
    // If we found no figures with Cheerio, fall back to Gemini
    if (figures.length === 0) {
      console.log(
        `[HTML PARSER] No figures found with Cheerio, falling back to Gemini`
      );
      return processHtmlWithGemini(html, arxivId);
    }
    return figures;
  } catch (error) {
    console.error(`[HTML PARSER] Error extracting figures:`, error);
    console.log(`[HTML PARSER] Falling back to Gemini due to error`);
    return processHtmlWithGemini(html, arxivId);
  }
}
// Helper to check if a caption belongs to a table
function isTableCaption(caption) {
  if (!caption) return false;
  const lowerCaption = caption.toLowerCase();
  return (
    /^table\s+\d+|^tab(\.|le)?\s*\d+/i.test(caption) ||
    /table\s+\d+:/i.test(caption) ||
    lowerCaption.includes("table of ") ||
    lowerCaption.includes("tabular") ||
    lowerCaption.includes("statistical table")
  );
}
// Helper to create a short caption from the full caption
function createShortCaption(caption) {
  if (!caption) return "";
  // Try to identify and remove figure prefix patterns
  const prefixMatch = caption.match(/^(?:figure|fig\.?)\s+\d+[:.]\s*(.*)/i);
  if (prefixMatch) {
    return prefixMatch[1].trim();
  }
  // Try alternate approaches
  // Remove figure references at the beginning
  let shortCaption = caption
    .replace(/^(figure|fig\.?)(\s|\.|:)+\d+(\s|\.|:)+/i, "")
    .trim();
  // Remove any leading non-alphanumeric characters after cleaning
  shortCaption = shortCaption.replace(/^[^a-z0-9]+/i, "").trim();
  return shortCaption || caption;
}
// Helper to process image URLs
function processImageUrl(src, arxivId) {
  if (!src) return "no-image-found";
  // Skip base64 encoded images
  if (src.includes("data:image/") || src.includes("base64")) {
    return "no-image-found"; // Return no-image-found for base64 images
  }
  if (src.startsWith("http")) {
    return src;
  } else if (src.startsWith("/")) {
    return `https://arxiv.org${src}`;
  } else {
    return `https://arxiv.org/html/${arxivId}/${src.replace(/^\.\//, "")}`;
  }
}
// Helper to add a figure to the array, avoiding duplicates
function addFigure(figures, figure) {
  // Skip figures with no valid image
  if (figure.content === "no-image-found") {
    console.log(
      `[HTML PARSER] Skipping figure ${figure.index} - no valid image found`
    );
    return;
  }
  // Check if we already have this figure number
  const existingIndex = figures.findIndex((f) => f.index === figure.index);
  if (existingIndex >= 0) {
    // If current figure has no valid image, don't update
    if (figure.content === "no-image-found") {
      return;
    }
    // If caption is better (longer or has more info), update it
    if (
      figure.caption &&
      (!figures[existingIndex].caption ||
        figure.caption.length > figures[existingIndex].caption.length)
    ) {
      figures[existingIndex].caption = figure.caption;
      figures[existingIndex].originalCaption = figure.originalCaption;
    }
  } else {
    // Add new figure
    figures.push(figure);
  }
}
// Process HTML with Gemini API - no artificial delays
async function processHtmlWithGemini(html, arxivId) {
  console.log(`[GEMINI API] Starting figure extraction for paper ${arxivId}`);
  console.log(`[GEMINI API] Using model: gemini-2.0-flash`);
  try {
    const startTime = new Date();
    console.log(`[GEMINI API] Start time: ${startTime.toISOString()}`);
    const prompt = `
Extract only figures (not tables) from this scientific paper HTML. For each figure (up to 10), provide:
1. Figure number
2. Full caption text
3. Image source URLs
Format EXACTLY as a JSON array with this structure (follow this EXACTLY):
[
  {
    "type": "figure",
    "index": 1,
    "caption": "This is the simplified caption text (without 'Figure X:')",
    "content": "https://arxiv.org/html/2304.01852/assets/fig1.png",
    "identifier": "Figure-1",
    "originalCaption": "Figure 1: This is the full original caption text"
  }
]
IMPORTANT INSTRUCTIONS:
- Only include actual figures with images, NOT tables
- Only include figures where you can find a valid URL (not base64 encoded images)
- "index" must be the numeric figure number (integer)
- "caption" should be the caption WITHOUT the "Figure X:" prefix
- "content" must be the full image URL
- "identifier" should follow format "Figure-{index}"
- "originalCaption" must include the complete original caption text
- Make sure your JSON is valid and can be directly parsed
`;
    console.log(`[GEMINI API] Sending request to Gemini API...`);
    const apiCallStartTime = new Date();
    const modelPromise = model
      .generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt + "\n\nHTML:\n" + html.substring(0, 100000) },
            ],
          },
        ],
        generationConfig: { temperature: 0.2 },
      })
      .then((result) => {
        return result.response.text();
      });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Gemini request timed out")), 60000);
    });
    const response = await Promise.race([modelPromise, timeoutPromise]);
    const apiCallEndTime = new Date();
    const apiCallDuration = (apiCallEndTime - apiCallStartTime) / 1000;
    console.log(
      `[GEMINI API] API call completed in ${apiCallDuration.toFixed(2)} seconds`
    );
    // Process the response
    console.log(`[GEMINI API] Processing response from Gemini...`);
    let extractedFigures = [];
    try {
      // Find and extract JSON array from response
      const jsonMatch = response.match(/\[\s*\{.*\}\s*\]/s);
      if (jsonMatch) {
        extractedFigures = JSON.parse(jsonMatch[0]);
        console.log(`[GEMINI API] Successfully parsed JSON response`);
      } else {
        console.log(`[GEMINI API] No valid JSON found in response`);
        console.log(
          `[GEMINI API] Response preview: ${response.substring(0, 300)}...`
        );
      }
    } catch (parseError) {
      console.error(`[GEMINI API] Error parsing JSON response:`, parseError);
      console.log(
        `[GEMINI API] Response preview: ${response.substring(0, 300)}...`
      );
    }
    console.log(
      `[GEMINI API] Extracted ${extractedFigures.length} figures from JSON response`
    );
    // Filter out any figures with base64 images or no-image-found
    const validFigures = extractedFigures.filter((fig) => {
      const content = fig.content || "";
      return (
        content !== "no-image-found" &&
        !content.includes("data:image/") &&
        !content.includes("base64")
      );
    });
    console.log(
      `[GEMINI API] ${validFigures.length} valid figures after filtering`
    );
    // Log end time and duration
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`[GEMINI API] End time: ${endTime.toISOString()}`);
    console.log(
      `[GEMINI API] Total processing duration: ${duration.toFixed(2)} seconds`
    );
    return validFigures;
  } catch (error) {
    console.error(`[GEMINI API] Error in processHtmlWithGemini:`, error);
    console.error(
      `[GEMINI API] Error details:`,
      JSON.stringify(error, null, 2)
    );
    if (error.response) {
      console.error(`[GEMINI API] API response status:`, error.response.status);
      console.error(`[GEMINI API] API response data:`, error.response.data);
    }
    return [];
  }
}
// Process captions without delays - only used if needed for back-compatibility
async function summarizeCaptions(figures) {
  console.log(
    `[CAPTION PROCESSING] Starting caption processing for ${figures.length} figures`
  );
  if (figures.length === 0) {
    console.log(`[CAPTION PROCESSING] No figures to process`);
    return [];
  }
  const processedFigures = figures.map((figure) => {
    // Clean caption of HTML tags
    const caption = figure.caption || "";
    const cleanCaption = caption
      .replace(/<[^>]*>/g, "") // Remove HTML tags
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();
    return {
      type: "figure",
      index: parseInt(figure.figureNumber) || 0,
      caption: cleanCaption || `Figure ${figure.figureNumber}`,
      content: figure.contentUrl || "",
      identifier: `Figure-${figure.figureNumber}`,
      originalCaption: caption || `Figure ${figure.figureNumber}`,
    };
  });
  console.log(
    `[CAPTION PROCESSING] Completed caption processing for ${processedFigures.length} figures`
  );
  return processedFigures;
}
// Fetch paper HTML with realistic browsing behavior
async function fetchPaper(arxivId, retryCount = 0) {
  console.log(`[NETWORK] Fetching paper HTML for ${arxivId}...`);
  // More realistic referrers
  const referrers = [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/search/cs?query=" + encodeURIComponent(arxivId),
    "https://scholar.google.com/scholar?q=" + encodeURIComponent(arxivId),
    "https://www.google.com/search?q=" + encodeURIComponent("arxiv " + arxivId),
  ];
  // Select a random referrer
  const selectedReferrer =
    referrers[Math.floor(Math.random() * referrers.length)];
  console.log(`[NETWORK] Using referrer: ${selectedReferrer}`);
  // Generate realistic cookies
  const cookieId = Math.floor(Math.random() * 1000000000);
  const sessionId = Math.random().toString(36).substring(2, 15);
  const cookies = `_ga=GA1.${cookieId}; _gid=GA1.${
    cookieId + 1
  }; arxiv_session=${sessionId}`;
  console.log(`[NETWORK] Using cookies: ${cookies}`);
  // Simulate human thinking before making the request
  const thinkingTime = getHumanDelay(2000);
  console.log(
    `[NETWORK] Preparing request (${Math.round(
      thinkingTime / 1000
    )} seconds)...`
  );
  await delay(thinkingTime);
  try {
    console.log(`[NETWORK] Sending HTTP request to arxiv.org...`);
    const requestStartTime = new Date();
    const response = await axios.get(`https://arxiv.org/html/${arxivId}`, {
      headers: {
        ...browserHeaders,
        Referer: selectedReferrer,
        Cookie: cookies,
      },
      timeout: 30000,
      maxRedirects: 5,
    });
    const requestEndTime = new Date();
    const requestDuration = (requestEndTime - requestStartTime) / 1000;
    console.log(
      `[NETWORK] Request completed in ${requestDuration.toFixed(2)} seconds`
    );
    console.log(`[NETWORK] HTTP status: ${response.status}`);
    console.log(`[NETWORK] Content length: ${response.data.length} bytes`);
    // Simulate time to load the page
    const loadingTime = getHumanDelay(3000);
    console.log(
      `[NETWORK] Loading page content (${Math.round(
        loadingTime / 1000
      )} seconds)...`
    );
    await delay(loadingTime);
    return response.data;
  } catch (error) {
    console.error(`[NETWORK] Error fetching paper ${arxivId}:`, error.message);
    if (error.response) {
      console.error(`[NETWORK] HTTP status: ${error.response.status}`);
      console.error(`[NETWORK] Response headers:`, error.response.headers);
    }
    // More realistic retry behavior
    if (retryCount < 2) {
      const backoffTime = getHumanDelay(5000 * (retryCount + 1));
      console.log(
        `[NETWORK] Retrying (attempt ${retryCount + 1}) in ${Math.round(
          backoffTime / 1000
        )} seconds)...`
      );
      await delay(backoffTime);
      return fetchPaper(arxivId, retryCount + 1);
    }
    console.error(
      `[NETWORK] Maximum retry attempts reached for paper ${arxivId}`
    );
    return null;
  }
}
// Main process function with human-like behaviors only for arxiv
async function processAndStorePaper(paper) {
  console.log(`\n[PAPER PROCESSING] ========================================`);
  console.log(
    `[PAPER PROCESSING] Starting analysis for paper ${paper.id} (${paper.arxivId})`
  );
  console.log(`[PAPER PROCESSING] ========================================`);
  try {
    // Log start time
    const startTime = new Date();
    console.log(`[PAPER PROCESSING] Start time: ${startTime.toISOString()}`);
    // Fetch HTML
    console.log(`[PAPER PROCESSING] Fetching HTML for paper ${paper.arxivId}`);
    const html = await fetchPaper(paper.arxivId);
    if (!html) {
      console.log(
        `[PAPER PROCESSING] Paper ${paper.id} is not accessible or HTML couldn't be fetched`
      );
      console.log(
        `[PAPER PROCESSING] Updating database with empty figures array`
      );
      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({
          paperGraphics: [],
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);
      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(`[PAPER PROCESSING] Database updated successfully`);
      }
      return;
    }
    console.log(
      `[PAPER PROCESSING] HTML fetched successfully (${html.length} bytes)`
    );
    // Simulate time spent analyzing the HTML structure before processing
    const analysisTime = getReadingTime(html.substring(0, 10000));
    console.log(
      `[PAPER PROCESSING] Analyzing HTML structure (${Math.round(
        analysisTime / 1000
      )} seconds)...`
    );
    await delay(analysisTime);
    // Extract figures with Cheerio
    console.log(`[PAPER PROCESSING] Starting figure extraction with Cheerio`);
    const extractedFigures = await extractFiguresWithCheerio(
      html,
      paper.arxivId
    );
    console.log(
      `[PAPER PROCESSING] Extracted ${extractedFigures.length} figures from paper`
    );
    // Log details about extracted figures
    extractedFigures.forEach((figure, index) => {
      console.log(`[PAPER PROCESSING] Figure ${index + 1} details:`);
      console.log(
        `[PAPER PROCESSING]   - Number: ${figure.index || "unknown"}`
      );
      console.log(
        `[PAPER PROCESSING]   - Caption length: ${
          figure.caption ? figure.caption.length : 0
        } characters`
      );
      console.log(`[PAPER PROCESSING]   - URL: ${figure.content || "none"}`);
      console.log(
        `[PAPER PROCESSING]   - Original caption: ${
          figure.originalCaption
            ? figure.originalCaption.substring(0, 50)
            : "none"
        }...`
      );
    });
    // Limit to first 10 figures with explanation
    let limitedFigures = extractedFigures;
    if (extractedFigures.length > 10) {
      console.log(
        `[PAPER PROCESSING] Limiting to first 10 figures from the ${extractedFigures.length} total found`
      );
      limitedFigures = extractedFigures.slice(0, 10);
    }
    // Format for database
    console.log(`[PAPER PROCESSING] Formatting figures for database storage`);
    // Since the figures are already in the correct format, just ensure all fields are present
    const formattedGraphics = limitedFigures.map((fig, index) => ({
      type: "figure",
      index: fig.index || index + 1,
      caption: fig.caption || `Figure ${fig.index || index + 1}`,
      content: fig.content || "",
      identifier: fig.identifier || `Figure-${fig.index || index + 1}`,
      originalCaption:
        fig.originalCaption ||
        fig.caption ||
        `Figure ${fig.index || index + 1}`,
    }));
    // Simulate final review before saving (human-like delay)
    const reviewTime = getHumanDelay(5000);
    console.log(
      `[PAPER PROCESSING] Reviewing figures before database update (${Math.round(
        reviewTime / 1000
      )} seconds)...`
    );
    await delay(reviewTime);
    // Update database
    console.log(
      `[PAPER PROCESSING] Updating database with ${formattedGraphics.length} figures`
    );
    const dbUpdateStartTime = new Date();
    const { data, error } = await supabase
      .from("arxivPapersData")
      .update({
        paperGraphics: formattedGraphics,
        lastUpdated: new Date().toISOString(),
      })
      .eq("id", paper.id);
    const dbUpdateEndTime = new Date();
    const dbUpdateDuration = (dbUpdateEndTime - dbUpdateStartTime) / 1000;
    if (error) {
      console.error(`[PAPER PROCESSING] Database update error:`, error);
    } else {
      console.log(
        `[PAPER PROCESSING] Database updated successfully in ${dbUpdateDuration.toFixed(
          2
        )} seconds`
      );
      console.log(
        `[PAPER PROCESSING] Stored ${formattedGraphics.length} figures for paper ${paper.id}`
      );
    }
    // Log end time and duration
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`[PAPER PROCESSING] End time: ${endTime.toISOString()}`);
    console.log(
      `[PAPER PROCESSING] Total processing duration: ${duration.toFixed(
        2
      )} seconds`
    );
  } catch (error) {
    console.error(
      `[PAPER PROCESSING] Error analyzing paper ${paper.id}:`,
      error
    );
    console.error(`[PAPER PROCESSING] Stack trace:`, error.stack);
    console.log(
      `[PAPER PROCESSING] Updating database with empty figures array due to error`
    );
    try {
      const { data, error: dbError } = await supabase
        .from("arxivPapersData")
        .update({
          paperGraphics: [],
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);
      if (dbError) {
        console.error(`[PAPER PROCESSING] Database update error:`, dbError);
      } else {
        console.log(
          `[PAPER PROCESSING] Database updated successfully with empty array`
        );
      }
    } catch (finalError) {
      console.error(
        `[PAPER PROCESSING] Critical error updating database:`,
        finalError
      );
    }
  }
  console.log(`[PAPER PROCESSING] ========================================`);
}
async function main() {
  console.log("\n[MAIN] ================================================");
  console.log("[MAIN] Starting paper figure extraction with Cheerio");
  console.log("[MAIN] ================================================");
  // Log configuration settings
  console.log("[MAIN] Configuration settings:");
  console.log(`[MAIN] - Batch size: ${BATCH_SIZE} papers`);
  console.log(`[MAIN] - Base delay: ${BASE_DELAY / 1000} seconds`);
  console.log(`[MAIN] - Variance factor: ${VARIANCE_FACTOR * 100}%`);
  console.log(
    `[MAIN] - Minimum page view time: ${MIN_PAGE_VIEW_TIME / 1000} seconds`
  );
  console.log(
    `[MAIN] - Maximum page view time: ${MAX_PAGE_VIEW_TIME / 1000} seconds`
  );
  // Log start time
  const mainStartTime = new Date();
  console.log(`[MAIN] Process started at: ${mainStartTime.toISOString()}`);
  try {
    // Calculate date 4 days ago for filtering recently indexed papers
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    console.log(
      `[MAIN] Filtering papers indexed since: ${fourDaysAgo.toISOString()}`
    );
    // First, count total papers that meet our criteria
    console.log(`[MAIN] Counting eligible papers in database...`);
    const { count, error: countError } = await supabase
      .from("arxivPapersData")
      .select("id", { count: "exact" })
      .is("paperGraphics", null)
      .gte("indexedDate", fourDaysAgo.toISOString());
    if (countError) {
      console.error(`[MAIN] Database count query error:`, countError);
      throw countError;
    }
    console.log(`[MAIN] Found ${count || 0} papers matching criteria`);
    if (!count || count === 0) {
      console.log("[MAIN] No papers to analyze. Process complete.");
      return;
    }
    console.log(`[MAIN] Starting batch processing of ${count} papers`);
    let startIndex = 0;
    let hasMore = true;
    let batchNumber = 1;
    let totalProcessed = 0;
    while (hasMore) {
      // Take breaks between sessions
      if (startIndex > 0) {
        const sessionBreak = getHumanDelay(30000); // Changed from 300000 (5-minute) to 30000 (30-second) to match paper-tables
        console.log(
          `[MAIN] Taking a break between batches (${Math.round(
            sessionBreak / 1000
          )} seconds)...`
        );
        await delay(sessionBreak);
      }
      console.log(`[MAIN] Starting batch #${batchNumber}`);
      console.log(
        `[MAIN] Fetching papers from index ${startIndex} to ${
          startIndex + BATCH_SIZE - 1
        }`
      );
      // Query database for papers
      const queryStartTime = new Date();
      console.log(
        `[MAIN] Database query started at: ${queryStartTime.toISOString()}`
      );
      const { data: papers, error } = await supabase
        .from("arxivPapersData")
        .select("id, arxivId, pdfUrl")
        .is("paperGraphics", null)
        .gte("totalScore", 0)
        .gte("indexedDate", fourDaysAgo.toISOString())
        .order("totalScore", { ascending: false })
        .range(startIndex, startIndex + BATCH_SIZE - 1);
      const queryEndTime = new Date();
      const queryDuration = (queryEndTime - queryStartTime) / 1000;
      console.log(
        `[MAIN] Database query completed in ${queryDuration.toFixed(2)} seconds`
      );
      if (error) {
        console.error(`[MAIN] Database query error:`, error);
        throw error;
      }
      if (!papers?.length) {
        console.log("[MAIN] No more papers to analyze. Process complete.");
        hasMore = false;
        break;
      }
      console.log(
        `[MAIN] Batch #${batchNumber}: Retrieved ${papers.length} papers to process`
      );
      console.log(
        `[MAIN] Progress: ${totalProcessed}/${count} (${(
          (totalProcessed / count) *
          100
        ).toFixed(2)}%)`
      );
      // Log papers to be processed
      papers.forEach((paper, index) => {
        console.log(`[MAIN] Paper ${index + 1}/${papers.length} in batch:`);
        console.log(`[MAIN]   - ID: ${paper.id}`);
        console.log(`[MAIN]   - ArXiv ID: ${paper.arxivId}`);
        console.log(
          `[MAIN]   - PDF URL: ${paper.pdfUrl || "Using default ArXiv URL"}`
        );
      });
      // Process each paper in the batch
      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        console.log(
          `[MAIN] Processing paper ${i + 1}/${
            papers.length
          } in batch #${batchNumber}`
        );
        console.log(
          `[MAIN] Overall progress: ${totalProcessed + 1}/${count} (${(
            ((totalProcessed + 1) / count) *
            100
          ).toFixed(2)}%)`
        );
        const paperStartTime = new Date();
        await processAndStorePaper(paper);
        const paperEndTime = new Date();
        const paperDuration = (paperEndTime - paperStartTime) / 1000;
        console.log(
          `[MAIN] Paper ${
            paper.arxivId
          } processing completed in ${paperDuration.toFixed(2)} seconds`
        );
        totalProcessed++;
        // Take a natural break between papers
        if (i < papers.length - 1) {
          const breakTime = getHumanDelay(BASE_DELAY * 3);
          console.log(
            `[MAIN] Taking a break between papers (${Math.round(
              breakTime / 1000
            )} seconds)...`
          );
          await delay(breakTime);
        }
      }
      console.log(`[MAIN] Completed batch #${batchNumber}`);
      console.log(`[MAIN] Processed ${papers.length} papers in this batch`);
      console.log(
        `[MAIN] Total papers processed so far: ${totalProcessed}/${count} (${(
          (totalProcessed / count) *
          100
        ).toFixed(2)}%)`
      );
      startIndex += BATCH_SIZE;
      batchNumber++;
      // Break if we've processed all papers
      if (totalProcessed >= count) {
        console.log(`[MAIN] All eligible papers have been processed`);
        hasMore = false;
      }
    }
    // Log completion stats
    const mainEndTime = new Date();
    const mainDuration = (mainEndTime - mainStartTime) / 1000;
    const mainDurationMinutes = mainDuration / 60;
    console.log(`[MAIN] ================================================`);
    console.log(`[MAIN] Process completed at: ${mainEndTime.toISOString()}`);
    console.log(
      `[MAIN] Total execution time: ${mainDuration.toFixed(
        2
      )} seconds (${mainDurationMinutes.toFixed(2)} minutes)`
    );
    console.log(
      `[MAIN] Total papers processed: ${totalProcessed}/${count} (${(
        (totalProcessed / count) *
        100
      ).toFixed(2)}%)`
    );
  } catch (error) {
    console.error("[MAIN] Error in main process:", error);
    console.error("[MAIN] Stack trace:", error.stack);
  }
  console.log("\n[MAIN] ================================================");
  console.log("[MAIN] Paper figure extraction process complete");
  console.log("[MAIN] ================================================\n");
}
// Start the script
main().catch(console.error);
