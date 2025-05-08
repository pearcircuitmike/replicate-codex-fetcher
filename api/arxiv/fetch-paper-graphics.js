import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios"; // Still needed for the Gemini fallback
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as cheerio from "cheerio";
// Added for local HTML handling - These are built-in Node.js modules
import zlib from "zlib";
import { Buffer } from "buffer";

dotenv.config();

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
// Log initialization
console.log("[INIT] Initializing services...");
let genAI, model;
// Use the correct model name as originally intended
const GEMINI_MODEL_NAME = "gemini-2.0-flash";
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
  console.log(`[INIT] Gemini ${GEMINI_MODEL_NAME} model initialized`);
} else {
  console.warn(
    "[INIT] GEMINI_API_KEY not found. Gemini fallback will not be available."
  );
}

// Script Configuration
const BATCH_SIZE = 40; // How many papers to process in one run

// Browser simulation headers (Potentially needed for Gemini if it follows links?)
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

// --- Helper Functions ---
// Removed delay, getHumanDelay, getReadingTime as live fetching is removed

// --- Figure Extraction Logic (No changes needed here, operates on HTML string) ---

async function extractFiguresWithCheerio(html, arxivId) {
  // Log start only if HTML is provided
  if (html && html.length > 0) {
    console.log(
      `[HTML PARSER] Starting Cheerio figure extraction for paper ${arxivId}`
    );
  } else {
    console.warn(
      `[HTML PARSER] No HTML content provided for Cheerio extraction for paper ${arxivId}.`
    );
    return []; // Return empty if no HTML
  }

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
      // Skip known non-figure images explicitly
      if (
        src.includes("favicon.ico") ||
        src.includes("apple-touch-icon") ||
        src.includes("orcid_16x16.png") ||
        src.endsWith(".svg")
      ) {
        // console.log(`[HTML PARSER] Skipping known non-figure image: ${src}`); // Less verbose
        return;
      }

      // console.log( // Less verbose
      //   `[HTML PARSER] Processing image ${i + 1}/${imgCount}: ${src}`
      // );
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
      }
      // 2. Check for caption class
      if (!caption) {
        const captionEl = container
          .find('.caption, [class*="caption"]')
          .first();
        if (captionEl.length) {
          caption = captionEl.text().trim();
        }
      }
      // 3. Check for adjacent paragraph with figure reference
      if (!caption) {
        const nextP = img.next("p");
        if (nextP.length && nextP.text().match(/^(figure|fig\.?)\s+\d+/i)) {
          caption = nextP.text().trim();
        }
      }
      // 4. Look for any nearby paragraph with figure reference
      if (!caption) {
        container.find("p").each((_idx, p) => {
          // Use _idx to avoid shadowing
          const pText = $(p).text().trim();
          if (pText.match(/^(figure|fig\.?)\s+\d+/i)) {
            caption = pText;
            return false; // break the each loop
          }
        });
      }
      // 5. Check image alt text for additional info
      const altText = img.attr("alt") || "";
      if (altText && altText.match(/figure|fig\.?\s*\d+/i)) {
        if (!caption) {
          caption = altText;
        }
      }
      // Skip if caption suggests this is a table
      if (isTableCaption(caption)) {
        // console.log( // Less verbose
        //   `[HTML PARSER] Skipping - appears to be a table caption: ${caption.substring(0,50)}...`
        // );
        return;
      }
      // Extract figure number
      let figNumber = figures.length + 1; // Default sequential if not found
      const figMatch = caption.match(/(?:figure|fig\.?)\s+(\d+)/i); // Simplified regex
      if (figMatch && figMatch[1]) {
        figNumber = parseInt(figMatch[1]);
      } else {
        const altMatch = altText.match(/(?:figure|fig\.?)\s+(\d+)/i);
        if (altMatch && altMatch[1]) {
          figNumber = parseInt(altMatch[1]);
        } else {
          const srcMatch = src.match(/(?:fig|figure)(\d+)/i); // Simpler src match
          if (srcMatch && srcMatch[1]) {
            figNumber = parseInt(srcMatch[1]);
          }
        }
      }
      // Mark image as processed
      processedImages.add(src);
      // Create caption info
      const originalCaption = caption;
      const shortCaption = createShortCaption(caption); // Use helper

      const processedUrl = processImageUrl(src, arxivId);
      if (processedUrl === "no-image-found") {
        // console.log(`[HTML PARSER] Skipping figure ${figNumber} - invalid image URL or type: ${src}`); // Less verbose
        return; // Skip if URL processing failed
      }

      // Add to figures array
      addFigure(figures, {
        type: "figure",
        index: figNumber,
        caption: shortCaption || `Figure ${figNumber}`,
        content: processedUrl,
        identifier: `Figure-${figNumber}`,
        originalCaption: originalCaption || `Figure ${figNumber}`,
      });
    });

    // Sort figures by index AFTER collecting all potential figures
    figures.sort((a, b) => a.index - b.index);

    // Renumber sequentially AFTER sorting to ensure correctness
    const finalFigures = [];
    const seenIndices = new Set();
    figures.forEach((fig) => {
      // If we already processed this index (e.g., duplicate number extracted), skip
      if (seenIndices.has(fig.index)) {
        console.warn(
          `[HTML PARSER] Duplicate figure index ${fig.index} for ${arxivId}. Skipping subsequent entry.`
        );
        return;
      }
      // Renumber sequentially based on final sorted order
      const newIndex = finalFigures.length + 1;
      fig.index = newIndex;
      fig.identifier = `Figure-${newIndex}`;
      finalFigures.push(fig);
      seenIndices.add(newIndex); // Use new index for seen check
    });

    console.log(
      `[HTML PARSER] Final count after sorting and renumbering for ${arxivId}: ${finalFigures.length} figures extracted with Cheerio`
    );

    // Fallback to Gemini ONLY if Cheerio finds absolutely nothing *and* Gemini is configured
    if (finalFigures.length === 0 && model) {
      console.log(
        `[HTML PARSER] No figures found with Cheerio for ${arxivId}, falling back to Gemini`
      );
      // IMPORTANT: Pass the ORIGINAL HTML to Gemini, not the potentially modified one
      return processHtmlWithGemini(html, arxivId);
    }
    return finalFigures; // Return the renumbered figures
  } catch (error) {
    console.error(
      `[HTML PARSER] Error extracting figures with Cheerio for ${arxivId}:`,
      error
    );
    // Fallback to Gemini if Cheerio errors *and* Gemini is configured
    if (model && html) {
      // Check if model and html are available
      console.log(
        `[HTML PARSER] Falling back to Gemini due to Cheerio error for ${arxivId}`
      );
      return processHtmlWithGemini(html, arxivId);
    }
    return []; // Return empty array if Gemini is not available or no HTML
  }
}

function isTableCaption(caption) {
  if (!caption) return false;
  const lowerCaption = caption.toLowerCase();
  return (
    lowerCaption.startsWith("table ") ||
    lowerCaption.startsWith("tab.") ||
    lowerCaption.startsWith("tab ") ||
    lowerCaption.includes("table:") ||
    lowerCaption.includes("table of ") ||
    lowerCaption.includes("tabular data") ||
    lowerCaption.includes("statistical table")
  );
}

function createShortCaption(caption) {
  if (!caption) return "";
  let shortCaption = caption
    .replace(/^(figure|fig\.?)\s*\d+\s*[:.-]?\s*/i, "")
    .trim();
  return shortCaption || caption;
}

function processImageUrl(src, arxivId) {
  if (!src) return "no-image-found";
  if (src.startsWith("data:image/") || src.includes("base64")) {
    // console.log(`Skipping base64 image`); // Less verbose
    return "no-image-found";
  }
  try {
    const baseUrl = `https://arxiv.org/html/${arxivId}/`;
    const absoluteUrl = new URL(src, baseUrl);

    if (!absoluteUrl.protocol.startsWith("http")) {
      //   console.log(`Skipping non-http(s) URL: ${absoluteUrl.href}`); // Less verbose
      return "no-image-found";
    }
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(absoluteUrl.pathname)) {
      //   console.log(`Skipping URL with non-standard image extension: ${absoluteUrl.href}`); // Less verbose
      return "no-image-found";
    }
    return absoluteUrl.href;
  } catch (e) {
    console.error(
      `Error processing image URL '${src}' for ${arxivId}: ${e.message}`
    );
    return "no-image-found";
  }
}

function addFigure(figures, figure) {
  if (!figure.content || figure.content === "no-image-found") {
    return;
  }
  const existingIndex = figures.findIndex((f) => f.content === figure.content);
  if (existingIndex >= 0) {
    const existingFigure = figures[existingIndex];
    if (
      figure.caption &&
      (!existingFigure.caption ||
        figure.caption.length > existingFigure.caption.length)
    ) {
      existingFigure.caption = figure.caption;
      existingFigure.originalCaption = figure.originalCaption;
    }
  } else {
    figures.push(figure);
  }
}

async function processHtmlWithGemini(html, arxivId) {
  if (!model) {
    console.warn(
      `[GEMINI API] Gemini client not initialized. Cannot process HTML for ${arxivId}.`
    );
    return [];
  }
  if (!html || html.length === 0) {
    console.warn(
      `[GEMINI API] No HTML content provided for Gemini processing for paper ${arxivId}.`
    );
    return [];
  }

  console.log(
    `[GEMINI API] Starting Gemini figure extraction for paper ${arxivId}`
  );
  console.log(`[GEMINI API] Using model: ${GEMINI_MODEL_NAME}`);
  try {
    const startTime = new Date();
    // console.log(`[GEMINI API] Start time: ${startTime.toISOString()}`); // Less verbose
    const prompt = `
Extract only figures (not tables) from this scientific paper HTML. For each figure (up to 10), provide:
1. Figure number (integer index, e.g., 1, 2, 3)
2. Full original caption text (exactly as it appears, including "Figure X:" if present)
3. Image source URL (must be a valid, absolute URL ending in .png, .jpg, .jpeg, .gif, .webp, or .bmp - DO NOT include base64 data URIs)

Format EXACTLY as a JSON array of objects. Each object MUST have these keys: "type", "index", "caption", "content", "identifier", "originalCaption".
Example:
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
- Only include actual figures with valid image URLs (http/https, standard image extensions). NO base64.
- "index" MUST be the numeric figure number (integer). If you cannot determine a number, use sequential numbers starting from 1.
- "originalCaption" MUST be the complete, verbatim caption text found near the image.
- "caption" MUST be the simplified caption text, with any leading "Figure X:" or "Fig. X." prefix removed. If no prefix exists, use the original caption.
- "content" MUST be the absolute image URL. Resolve relative URLs based on the likely base path (e.g., 'assets/fig1.png' likely becomes 'https://arxiv.org/html/${arxivId}/assets/fig1.png').
- "identifier" MUST follow the format "Figure-{index}".
- "type" MUST be "figure".
- Ensure the output is a valid JSON array. Do not include explanations or text outside the JSON array.
- Limit to the first 10 valid figures found.
`;
    const maxHtmlLength = 150000;
    const truncatedHtml =
      html.length > maxHtmlLength
        ? html.substring(0, maxHtmlLength) + "\n...[TRUNCATED]"
        : html;

    console.log(
      `[GEMINI API] Sending request to Gemini API for ${arxivId} (HTML size: ${truncatedHtml.length})...`
    );
    const apiCallStartTime = new Date();
    const modelPromise = model
      .generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt + "\n\nHTML:\n" + truncatedHtml }],
          },
        ],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      })
      .then((result) => {
        if (result.response.promptFeedback?.blockReason) {
          console.error(
            `[GEMINI API] Request blocked for ${arxivId}. Reason: ${result.response.promptFeedback.blockReason}`
          );
          throw new Error(
            `Gemini request blocked: ${result.response.promptFeedback.blockReason}`
          );
        }
        if (!result.response.candidates?.[0]?.content?.parts?.[0]?.text) {
          console.error(
            `[GEMINI API] No valid text response found for ${arxivId}:`,
            JSON.stringify(result.response)
          );
          throw new Error("Invalid response structure from Gemini API");
        }
        return result.response.text();
      });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(`Gemini request timed out after 60s for ${arxivId}`)
          ),
        60000
      );
    });

    const responseText = await Promise.race([modelPromise, timeoutPromise]);

    const apiCallEndTime = new Date();
    const apiCallDuration = (apiCallEndTime - apiCallStartTime) / 1000;
    console.log(
      `[GEMINI API] API call for ${arxivId} completed in ${apiCallDuration.toFixed(
        2
      )} seconds`
    );
    // console.log(`[GEMINI API] Processing response from Gemini for ${arxivId}...`); // Less verbose
    let extractedFigures = [];
    try {
      const jsonMatch = responseText.match(
        /```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*\}\s*\])/
      );
      if (jsonMatch) {
        const jsonString = jsonMatch[1] || jsonMatch[2];
        if (jsonString) {
          extractedFigures = JSON.parse(jsonString.trim());
          // console.log(`[GEMINI API] Successfully parsed JSON response for ${arxivId} (${extractedFigures.length} figures found by Gemini).`); // Less verbose
        } else {
          console.log(
            `[GEMINI API] JSON match found but capture group empty for ${arxivId}. Response: ${responseText.substring(
              0,
              300
            )}...`
          );
        }
      } else {
        console.log(
          `[GEMINI API] No valid JSON array found in Gemini response for ${arxivId}.`
        );
        // console.log( // Less verbose
        //   `[GEMINI API] Response preview: ${responseText.substring(0, 300)}...`
        // );
      }
    } catch (parseError) {
      console.error(
        `[GEMINI API] Error parsing JSON response for ${arxivId}:`,
        parseError
      );
      console.log(`[GEMINI API] Raw Response for ${arxivId}: ${responseText}`);
    }

    const validFigures = extractedFigures
      .filter(
        (fig) =>
          fig &&
          fig.type === "figure" &&
          typeof fig.index === "number" &&
          fig.caption &&
          fig.originalCaption &&
          fig.content &&
          fig.content !== "no-image-found" &&
          !fig.content.startsWith("data:image/") &&
          fig.identifier &&
          fig.identifier === `Figure-${fig.index}`
      )
      .map((fig) => ({
        type: "figure",
        index: parseInt(fig.index, 10),
        caption: String(fig.caption),
        content: String(fig.content),
        identifier: String(fig.identifier),
        originalCaption: String(fig.originalCaption),
      }));

    console.log(
      `[GEMINI API] ${validFigures.length} valid figures after filtering Gemini results for ${arxivId}.`
    );

    // const endTime = new Date(); // Less verbose
    // const duration = (endTime - startTime) / 1000;
    // console.log(`[GEMINI API] End time: ${endTime.toISOString()}`);
    // console.log(
    //   `[GEMINI API] Total Gemini processing duration: ${duration.toFixed(2)} seconds`
    // );
    return validFigures.slice(0, 10);
  } catch (error) {
    console.error(
      `[GEMINI API] Error in processHtmlWithGemini for ${arxivId}:`,
      error.message
    );
    return [];
  }
}

// REMOVED fetchPaper function as it's no longer needed for fallback

// Main processing function for a single paper's graphics
async function processAndStorePaperGraphics(paper, htmlContent) {
  // This function remains largely the same, but it now *only* receives HTML
  // if it was successfully retrieved from the database.
  console.log(
    `\n[GRAPHICS PROCESSING] ========================================`
  );
  console.log(
    `[GRAPHICS PROCESSING] Starting graphics analysis for paper ${paper.id} (${paper.arxivId}) using local HTML.`
  );
  console.log(`[GRAPHICS PROCESSING] ========================================`);
  try {
    const startTime = new Date();
    // console.log(`[GRAPHICS PROCESSING] Start time: ${startTime.toISOString()}`); // Less verbose

    // HTML content is guaranteed to be non-null if this function is called

    // Extract figures using Cheerio first, with Gemini as fallback
    // console.log(`[GRAPHICS PROCESSING] Starting figure extraction...`); // Less verbose
    const extractedFigures = await extractFiguresWithCheerio(
      htmlContent,
      paper.arxivId
    );

    console.log(
      `[GRAPHICS PROCESSING] Extracted ${extractedFigures.length} figures for paper ${paper.id}`
    );

    const limitedFigures = extractedFigures.slice(0, 10);
    const formattedGraphics = limitedFigures; // This is the array of figure objects

    // *** DEBUG LOGGING ADDED HERE ***
    console.log(`[DEBUG] Paper ID: ${paper.id}`);
    console.log(
      `[DEBUG] Number of figures extracted: ${formattedGraphics.length}`
    );
    // Log the actual data being sent to the update, truncated if too long
    try {
      const dataToStoreString = JSON.stringify(formattedGraphics);
      console.log(
        `[DEBUG] Data to store in paperGraphics (length: ${
          dataToStoreString.length
        }): ${dataToStoreString.substring(0, 500)}${
          dataToStoreString.length > 500 ? "..." : ""
        }`
      );
    } catch (stringifyError) {
      console.error(
        "[DEBUG] Error stringifying formattedGraphics:",
        stringifyError
      );
      console.log(
        "[DEBUG] formattedGraphics object structure:",
        formattedGraphics
      ); // Log structure if stringify fails
    }
    // *** END DEBUG LOGGING ***

    // Update database
    console.log(
      `[GRAPHICS PROCESSING] Updating database for paper ${paper.id} with ${formattedGraphics.length} figures...`
    );
    const dbUpdateStartTime = new Date();
    const { data: updateData, error: updateError } = await supabase
      .from("arxivPapersData")
      .update({
        paperGraphics: formattedGraphics, // Store the extracted graphics array
        lastUpdated: new Date().toISOString(),
      })
      .eq("id", paper.id)
      .select(); // Select to confirm update and see what Supabase returns

    const dbUpdateEndTime = new Date();
    const dbUpdateDuration = (dbUpdateEndTime - dbUpdateStartTime) / 1000;

    // *** DEBUG LOGGING ADDED HERE ***
    if (updateError) {
      console.error(
        `[DEBUG] Database update FAILED for paper ${paper.id}:`,
        updateError
      );
    } else {
      console.log(
        `[DEBUG] Database update SUCCEEDED for paper ${paper.id}. Result:`,
        updateData
      );
      // Explicitly check if the returned data actually shows the updated column
      if (updateData && updateData.length > 0 && updateData[0].paperGraphics) {
        console.log(
          `[DEBUG] Returned paperGraphics length: ${updateData[0].paperGraphics.length}`
        );
      } else if (updateData && updateData.length > 0) {
        console.log(
          `[DEBUG] Returned data does not contain paperGraphics, or it's null/empty.`
        );
      } else {
        console.log(`[DEBUG] Update returned no data or empty array.`);
      }
    }
    // *** END DEBUG LOGGING ***

    if (updateError) {
      console.error(
        `[GRAPHICS PROCESSING] Database update error for paper ${paper.id}:`,
        updateError
      );
    } else {
      console.log(
        `[GRAPHICS PROCESSING] Database update call completed successfully for paper ${
          paper.id
        } in ${dbUpdateDuration.toFixed(2)} seconds. Stored ${
          formattedGraphics.length
        } figures.`
      );
    }

    // const endTime = new Date(); // Less verbose
    // const duration = (endTime - startTime) / 1000;
    // console.log(`[GRAPHICS PROCESSING] End time: ${endTime.toISOString()}`);
    // console.log(
    //   `[GRAPHICS PROCESSING] Total processing duration for paper ${paper.id}: ${duration.toFixed(
    //     2
    //   )} seconds`
    // );
  } catch (error) {
    console.error(
      `[GRAPHICS PROCESSING] Top-level error analyzing paper ${paper.id}:`,
      error
    );
    // Attempt to update with empty array on error to prevent retries
    try {
      await supabase
        .from("arxivPapersData")
        .update({
          paperGraphics: [],
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);
      console.log(
        `[GRAPHICS PROCESSING] Updated paper ${paper.id} with empty graphics array due to error.`
      );
    } catch (finalError) {
      console.error(
        `[GRAPHICS PROCESSING] Critical error updating database after top-level error for paper ${paper.id}:`,
        finalError
      );
    }
  } finally {
    console.log(
      `[GRAPHICS PROCESSING] ========================================`
    );
  }
}

// --- MODIFIED: Main loop ---
async function main() {
  console.log("\n[MAIN] ================================================");
  console.log(
    "[MAIN] Starting Paper Graphics Extraction Process (Local HTML Only)"
  );
  console.log("[MAIN] ================================================");
  console.log(`[MAIN] - Batch size: ${BATCH_SIZE} papers`);
  const mainStartTime = new Date();
  console.log(`[MAIN] Process started at: ${mainStartTime.toISOString()}`);
  let totalProcessedInRun = 0;
  let totalEligibleCount = 0;

  try {
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    const fourDaysAgoISOString = fourDaysAgo.toISOString();
    console.log(
      `[MAIN] Querying for papers indexed since: ${fourDaysAgoISOString} needing graphics AND having local HTML.`
    );

    // --- MODIFIED QUERY ---
    // Select papers needing graphics processing AND having successfully fetched HTML assets
    console.log(`[MAIN] Fetching batch of papers with available local HTML...`);
    const queryStartTime = new Date();
    // Fetch the raw response to better inspect the bytea format
    const { data: papersWithAssets, error: queryError } = await supabase
      .from("arxivPapersData")
      .select(
        `
            id,
            arxivId,
            paper_assets!inner ( content_gzipped )
        `
      ) // Use inner join to ensure asset exists
      .is("paperGraphics", null) // Still needs graphics processing
      .gte("indexedDate", fourDaysAgoISOString) // Within time window
      .eq("paper_assets.asset_type", "html_content_gzipped") // Must be HTML asset type
      .is("paper_assets.fetch_error", null) // Must not have had a fetch error
      .not("paper_assets.content_gzipped", "is", null) // Must have content
      .order("totalScore", { ascending: false })
      .order("indexedDate", { ascending: false })
      .limit(BATCH_SIZE); // Apply batch size limit

    const queryEndTime = new Date();
    const queryDuration = (queryEndTime - queryStartTime) / 1000;
    console.log(
      `[MAIN] Database query completed in ${queryDuration.toFixed(2)} seconds`
    );

    if (queryError) {
      console.error(`[MAIN] Database query error fetching batch:`, queryError);
      throw queryError; // Stop if we can't get the batch
    }

    if (!papersWithAssets?.length) {
      console.log(
        "[MAIN] No papers found needing graphics with available local HTML. Process complete."
      );
      return; // Exit if the query returned no papers
    }
    // --- END MODIFIED QUERY ---

    console.log(
      `[MAIN] Retrieved ${papersWithAssets.length} papers with local HTML to process.`
    );

    // Process each paper in the batch
    for (let i = 0; i < papersWithAssets.length; i++) {
      const paperData = papersWithAssets[i];

      // Extract the nested asset data (Supabase returns related records as an array)
      // With !inner join, paper_assets should always exist and be non-empty array
      const asset = paperData.paper_assets[0];

      if (!asset || !asset.content_gzipped) {
        // This case should be less likely with the corrected query, but good to keep
        console.warn(
          `[MAIN] Paper ${paperData.id} included in batch but asset data missing or invalid. Skipping.`
        );
        continue;
      }

      console.log(
        `[MAIN] Processing paper ${i + 1}/${papersWithAssets.length} (ID: ${
          paperData.id
        }, ArXivID: ${paperData.arxivId})`
      );

      // --- Decompress HTML ---
      let htmlContent = null;
      try {
        let rawData = asset.content_gzipped;
        let bufferData;

        // console.log(`[DEBUG] Type of content_gzipped retrieved for ${paperData.arxivId}: ${typeof rawData}`); // Less verbose now

        // *** MOST LIKELY CASE: Supabase returns BYTEA as a hex string starting with \x ***
        if (typeof rawData === "string" && rawData.startsWith("\\x")) {
          // Remove the leading '\x' before converting from hex
          bufferData = Buffer.from(rawData.substring(2), "hex");
        }
        // *** Other potential formats (less likely with standard clients but possible) ***
        else if (rawData instanceof ArrayBuffer) {
          bufferData = Buffer.from(rawData);
        } else if (
          typeof rawData === "object" &&
          rawData !== null &&
          rawData.type === "Buffer" &&
          Array.isArray(rawData.data)
        ) {
          bufferData = Buffer.from(rawData.data);
        } else if (Buffer.isBuffer(rawData)) {
          bufferData = rawData;
        } else {
          // If none of the above, log an error and skip.
          console.error(
            `[MAIN] Unhandled or unexpected data type for content_gzipped for ${
              paperData.arxivId
            }: ${typeof rawData}. Skipping decompression.`
          );
          if (typeof rawData === "string") {
            console.error(
              `[MAIN] String preview: ${rawData.substring(0, 100)}...`
            );
          }
          continue; // Skip this paper
        }

        // Now attempt decompression
        htmlContent = zlib.gunzipSync(bufferData).toString("utf-8");
        console.log(`[MAIN] Decompressed local HTML for ${paperData.arxivId}.`);
      } catch (unzipError) {
        console.error(
          `[MAIN] Error decompressing local HTML for ${paperData.arxivId} (Paper ID: ${paperData.id}):`,
          unzipError
        );
        console.error(
          `[MAIN] Decompression failed. Original data type was: ${typeof asset.content_gzipped}`
        );
        if (asset.content_gzipped) {
          let preview = String(asset.content_gzipped);
          if (Buffer.isBuffer(asset.content_gzipped)) {
            preview = asset.content_gzipped.toString("hex", 0, 50); // Show first 50 bytes as hex
          } else if (typeof asset.content_gzipped === "object") {
            try {
              preview = JSON.stringify(asset.content_gzipped).substring(0, 100);
            } catch {
              preview = "Error stringifying object";
            }
          }
          console.error(`[MAIN] Raw data preview on error: ${preview}...`);
        }
        continue; // Skip this paper if decompression fails
      }
      // ---------------------

      if (htmlContent) {
        // Call the graphics processing function, passing the paper metadata and decompressed HTML
        await processAndStorePaperGraphics(
          { id: paperData.id, arxivId: paperData.arxivId }, // Pass necessary paper info
          htmlContent
        );
      } else {
        // This block should theoretically not be reached if decompression fails above, but added defensively
        console.warn(
          `[MAIN] HTML content was null after decompression attempt for paper ${paperData.id}. Skipping graphics processing.`
        );
      }

      totalProcessedInRun++;
    } // End loop for papers in batch

    console.log(
      `[MAIN] Completed processing batch. Processed ${papersWithAssets.length} papers in this run.`
    );
  } catch (error) {
    console.error("[MAIN] Error in main process:", error);
    console.error("[MAIN] Stack trace:", error.stack);
  } finally {
    // Log completion stats for this run
    const mainEndTime = new Date();
    const mainDuration = (mainEndTime - mainStartTime) / 1000;
    const mainDurationMinutes = mainDuration / 60;
    console.log(`[MAIN] ================================================`);
    console.log(
      `[MAIN] Process run completed at: ${mainEndTime.toISOString()}`
    );
    console.log(
      `[MAIN] Total execution time for this run: ${mainDuration.toFixed(
        2
      )} seconds (${mainDurationMinutes.toFixed(2)} minutes)`
    );
    console.log(
      `[MAIN] Total papers processed in this run: ${totalProcessedInRun}`
    );
    // Note: Cannot easily get total eligible count with the join query without a separate count query.
    console.log("\n[MAIN] Paper graphics extraction process run finished.");
    console.log("[MAIN] ================================================\n");
  }
}
// Start the script
main().catch(console.error);
