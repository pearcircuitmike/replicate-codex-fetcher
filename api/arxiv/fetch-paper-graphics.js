import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
const BATCH_SIZE = 20;
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
// Process HTML with Gemini API - no artificial delays
async function processHtmlWithGemini(html, arxivId) {
  console.log(`[GEMINI API] Starting figure extraction for paper ${arxivId}`);
  console.log(`[GEMINI API] Using model: gemini-2.0-flash`);
  try {
    const startTime = new Date();
    console.log(`[GEMINI API] Start time: ${startTime.toISOString()}`);
    const prompt = `
Extract figures from this scientific paper HTML. For each figure (up to 10), provide:
1. Figure number
2. Caption text (plain text only)
3. Image source URLs
Format EXACTLY as a JSON array like this:
[
  {
    "figureNumber": "1",
    "caption": "This is the full caption text for figure 1",
    "imageUrl": "https://arxiv.org/html/2304.01852/assets/fig1.png"
  },
  {
    "figureNumber": "2",
    "caption": "This is the caption for figure 2", 
    "imageUrl": "https://arxiv.org/html/2304.01852/assets/fig2.png"
  }
]
IMPORTANT INSTRUCTIONS:
- Always include the figure number
- Always include at least one image URL for each figure
- If you can't find an image URL, use "not-found" as the imageUrl
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
    // Process figures to the expected format
    console.log(`[GEMINI API] Processing extracted figures...`);
    const processedFigures = extractedFigures
      .map((fig, index) => {
        console.log(
          `[GEMINI API] Processing figure ${index + 1}: ${
            fig.figureNumber || "unknown"
          }`
        );
        let contentUrl = "no-image-found";
        if (fig.imageUrl && fig.imageUrl !== "not-found") {
          let src = fig.imageUrl;
          // Simple path handling
          if (src.startsWith("http")) {
            contentUrl = src;
          } else if (src.startsWith("/")) {
            contentUrl = `https://arxiv.org${src}`;
          } else {
            // For any relative path
            contentUrl = `https://arxiv.org/html/${arxivId}/${src.replace(
              /^\.\//,
              ""
            )}`;
          }
        }
        console.log(
          `[GEMINI API] Figure ${
            fig.figureNumber || "unknown"
          } URL: ${contentUrl}`
        );
        console.log(
          `[GEMINI API] Caption length: ${
            fig.caption ? fig.caption.length : 0
          } characters`
        );
        return {
          figureNumber: fig.figureNumber,
          caption: fig.caption,
          contentUrl: contentUrl,
        };
      })
      .filter((fig) => fig.figureNumber && fig.caption);
    console.log(
      `[GEMINI API] Successfully processed ${processedFigures.length} figures`
    );
    // Log end time and duration
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`[GEMINI API] End time: ${endTime.toISOString()}`);
    console.log(
      `[GEMINI API] Total processing duration: ${duration.toFixed(2)} seconds`
    );
    return processedFigures;
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
// Process captions without delays
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
        )} seconds...`
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
    // Extract figures with Gemini - no delays
    console.log(
      `[PAPER PROCESSING] Starting figure extraction with Gemini API`
    );
    const extractedFigures = await processHtmlWithGemini(html, paper.arxivId);
    console.log(
      `[PAPER PROCESSING] Extracted ${extractedFigures.length} figures from paper`
    );
    // Log details about extracted figures
    extractedFigures.forEach((figure, index) => {
      console.log(`[PAPER PROCESSING] Figure ${index + 1} details:`);
      console.log(
        `[PAPER PROCESSING]   - Number: ${figure.figureNumber || "unknown"}`
      );
      console.log(
        `[PAPER PROCESSING]   - Caption length: ${
          figure.caption ? figure.caption.length : 0
        } characters`
      );
      console.log(`[PAPER PROCESSING]   - URL: ${figure.contentUrl || "none"}`);
    });
    // Limit to first 10 figures with explanation
    let limitedFigures = extractedFigures;
    if (extractedFigures.length > 10) {
      console.log(
        `[PAPER PROCESSING] Limiting to first 10 figures from the ${extractedFigures.length} total found`
      );
      limitedFigures = extractedFigures.slice(0, 10);
    }
    // Process captions - no delays
    console.log(
      `[PAPER PROCESSING] Processing captions for ${limitedFigures.length} figures`
    );
    let graphics = await summarizeCaptions(limitedFigures);
    // Format for database
    console.log(`[PAPER PROCESSING] Formatting figures for database storage`);
    const formattedGraphics = graphics.map((fig, index) => ({
      type: "figure",
      index: index + 1,
      caption: fig.caption,
      content: fig.content,
      identifier: `Figure-${fig.index}`,
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
  console.log("[MAIN] Starting paper figure extraction with Gemini");
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
      .gt("totalScore", 0.5)
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
        const sessionBreak = getHumanDelay(300000); // 5-minute average break
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
        .select("id, arxivId")
        .is("paperGraphics", null)
        .gt("totalScore", 0.5)
        .gte("indexedDate", fourDaysAgo.toISOString())
        .order("totalScore", { ascending: false })
        .limit(BATCH_SIZE);
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
      startIndex += BATCH_SIZE; // This line is no longer needed but kept for counting batches
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
