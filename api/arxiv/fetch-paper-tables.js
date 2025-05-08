import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { Mistral } from "@mistralai/mistralai";
dotenv.config();

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Log initialization
console.log("[INIT] Initializing services...");

// Initialize Mistral client
let mistralClient;
if (process.env.MISTRAL_API_KEY) {
  mistralClient = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY,
  });
  console.log("[INIT] Mistral OCR model initialized");
} else {
  console.error("[INIT] MISTRAL_API_KEY not found. Cannot proceed.");
  process.exit(1); // Exit if Mistral key is missing
}

// --- Configuration ---
const BATCH_SIZE = 40; // How many papers to query from DB at once
// Rate Limiting Delays
const DELAY_AFTER_PDF_CHECK_MS = 300; // Delay after arXiv HEAD request
const DELAY_AFTER_MISTRAL_CALL_MS = 1100; // Delay after Mistral API call

const PDF_CHECK_TIMEOUT = 15000; // Timeout for checking PDF existence (ms)
const MISTRAL_API_TIMEOUT = 90000; // Timeout for the Mistral API call (ms) - OCR can take time

// Browser simulation headers
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", // Kept for PDF check
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

// --- Helper Functions ---

// Simple delay function
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch PDF (Modified to use export.arxiv.org)
async function fetchPdf(pdfUrl, arxivId, retryCount = 0) {
  // Use export subdomain for the HEAD check
  const exportPdfUrl = pdfUrl.replace("://arxiv.org/", "://export.arxiv.org/");
  console.log(`[NETWORK] Checking PDF for ${arxivId} at ${exportPdfUrl}...`);

  const maxRetries = 1; // Keep minimal retries

  try {
    const requestStartTime = new Date();
    // Use HEAD request for efficiency
    const response = await axios.head(exportPdfUrl, {
      headers: {
        "User-Agent": browserHeaders["User-Agent"],
        Referer: `https://arxiv.org/abs/${arxivId}`, // Polite referer
      },
      timeout: 30000, // Keep timeout
      maxRedirects: 5,
    });

    const requestEndTime = new Date();
    const requestDuration = (requestEndTime - requestStartTime) / 1000;
    console.log(
      `[NETWORK] PDF Check OK for ${arxivId} (Status: ${
        response.status
      }) in ${requestDuration.toFixed(2)}s`
    );

    return true; // PDF exists and is accessible
  } catch (error) {
    console.error(
      `[NETWORK] Error checking PDF for ${arxivId} at ${exportPdfUrl}:`,
      error.message
    );
    if (axios.isAxiosError(error) && error.response) {
      console.error(`[NETWORK] HTTP status: ${error.response.status}`);
      if (error.response.status === 404 || error.response.status === 403) {
        return false; // Definitely not accessible
      }
    }

    // Retry logic (kept minimal)
    if (retryCount < maxRetries) {
      const backoffTime = 1500 * (retryCount + 1); // Slightly longer backoff
      console.log(
        `[NETWORK] Retrying PDF check (attempt ${
          retryCount + 1
        }) in ${Math.round(backoffTime / 1000)} seconds...`
      );
      await delay(backoffTime);
      // Pass original URL to retry
      return fetchPdf(pdfUrl, arxivId, retryCount + 1);
    }

    console.error(
      `[NETWORK] Maximum retry attempts reached for PDF check ${arxivId}`
    );
    return false;
  }
}

// Process document with Mistral OCR (Modified to use export.arxiv.org)
async function processWithMistralOCR(documentUrl, arxivId) {
  // Use export subdomain
  const exportDocumentUrl = documentUrl.replace(
    "://arxiv.org/",
    "://export.arxiv.org/"
  );
  console.log(
    `[MISTRAL OCR] Starting OCR processing for: ${exportDocumentUrl} (arXiv: ${arxivId})`
  );
  console.log(`[MISTRAL OCR] Using model: mistral-ocr-latest`);

  const startTime = new Date();
  let ocrResponse = null;

  try {
    console.log(
      `[MISTRAL OCR] Sending request to Mistral API for ${arxivId}...`
    );
    const apiCallStartTime = new Date();

    // Use timeout for the API call itself
    const ocrPromise = mistralClient.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: exportDocumentUrl, // Use export URL
      },
      includeImageBase64: false,
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `Mistral API call timed out after ${MISTRAL_API_TIMEOUT / 1000}s`
            )
          ),
        MISTRAL_API_TIMEOUT
      );
    });

    ocrResponse = await Promise.race([ocrPromise, timeoutPromise]);

    const apiCallEndTime = new Date();
    const apiCallDuration = (apiCallEndTime - apiCallStartTime) / 1000;
    console.log(
      `[MISTRAL OCR] API call for ${arxivId} completed in ${apiCallDuration.toFixed(
        2
      )} seconds.`
    );

    const pageCount = ocrResponse?.pages?.length || 0;
    console.log(
      `[MISTRAL OCR] Processing complete for ${arxivId} with ${pageCount} pages.`
    );

    let totalTablesDetected = 0;
    if (ocrResponse?.pages) {
      ocrResponse.pages.forEach((page) => {
        totalTablesDetected += page.tables?.length || 0;
      });
    }
    console.log(
      `[MISTRAL OCR] Found ${totalTablesDetected} tables via API for ${arxivId}.`
    );

    // Enhance with manual table detection if needed (kept from original logic)
    if (totalTablesDetected === 0 && ocrResponse) {
      console.log(
        `[MISTRAL OCR] No tables detected by OCR API for ${arxivId}, performing manual table detection...`
      );
      ocrResponse._manualTables = detectTablesFromMarkdown(ocrResponse);
      console.log(
        `[MISTRAL OCR] Manual detection found ${ocrResponse._manualTables.length} potential tables for ${arxivId}.`
      );
    }

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000; // Duration without artificial delays
    console.log(
      `[MISTRAL OCR] Total function duration for ${arxivId}: ${duration.toFixed(
        2
      )} seconds`
    );

    return ocrResponse;
  } catch (error) {
    console.error(
      `[MISTRAL OCR] Error processing document for ${arxivId} (${exportDocumentUrl}):`,
      error.message
    );
    if (error.response) {
      console.error(
        `[MISTRAL OCR] API response status:`,
        error.response.status
      );
    } else if (error.name === "MistralAIError") {
      console.error(
        `[MISTRAL OCR] Mistral Error Type: ${error.type}, Code: ${error.code}`
      );
    } else if (error.message.includes("timed out")) {
      console.error(`[MISTRAL OCR] Operation timed out for ${arxivId}.`);
    }
    return null;
  }
}

// Manual table detection from page markdown (Unchanged)
function detectTablesFromMarkdown(ocrResult) {
  console.log(
    `[TABLE DETECTION] Starting manual table detection from markdown content`
  );
  const detectedTables = [];
  if (!ocrResult || !ocrResult.pages || ocrResult.pages.length === 0) {
    console.log(
      `[TABLE DETECTION] No valid OCR result for manual table detection`
    );
    return detectedTables;
  }
  ocrResult.pages.forEach((page) => {
    if (!page.markdown) return;
    const lines = page.markdown.split("\n");
    let tableStartLine = -1,
      inTable = false,
      consecutiveTableLines = 0,
      tableCaption = "";
    const captionPattern = /Table\s+\d+\s*[:.]/i;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (captionPattern.test(line) && !inTable) {
        tableCaption = line;
      }
      const pipeCount = (line.match(/\|/g) || []).length;
      const isTableLine = pipeCount >= 3 && line.includes("|");
      const dashCount = (line.match(/-/g) || []).length;
      const plusCount = (line.match(/\+/g) || []).length;
      const isAsciiTableLine =
        (dashCount > 10 && plusCount >= 2) ||
        (line.includes("+--") && line.includes("--+"));
      if (isTableLine || isAsciiTableLine) {
        if (!inTable) {
          tableStartLine = i;
          inTable = true;
        }
        consecutiveTableLines++;
      } else if (inTable) {
        if (consecutiveTableLines >= 3) {
          const tableContent = lines.slice(tableStartLine, i).join("\n");
          const caption = tableCaption || `Table on page ${page.index}`;
          detectedTables.push({
            pageNumber: page.index,
            index: detectedTables.length,
            tableMarkdown: tableContent,
            caption: caption,
            originalCaption: caption,
            identifier: `Table-${page.index}-${detectedTables.length}`,
            markdown: tableContent,
          });
        }
        inTable = false;
        consecutiveTableLines = 0;
        tableCaption = "";
      }
    }
    if (inTable && consecutiveTableLines >= 3) {
      const tableContent = lines.slice(tableStartLine).join("\n");
      const caption = tableCaption || `Table on page ${page.index}`;
      detectedTables.push({
        pageNumber: page.index,
        index: detectedTables.length,
        tableMarkdown: tableContent,
        caption: caption,
        originalCaption: caption,
        identifier: `Table-${page.index}-${detectedTables.length}`,
        markdown: tableContent,
      });
    }
  });
  console.log(
    `[TABLE DETECTION] Manual detection complete. Found ${detectedTables.length} tables`
  );
  return detectedTables;
}

// Extract tables from OCR result (Unchanged from original logic)
function extractTablesFromOCR(ocrResult, arxivId) {
  if (!ocrResult || !ocrResult.pages) {
    console.log(`[OCR EXTRACTION] No valid OCR result for ${arxivId}`);
    return [];
  }
  const tables = [];
  ocrResult.pages.forEach((page) => {
    if (page.tables && Array.isArray(page.tables) && page.tables.length > 0) {
      page.tables.forEach((table, index) => {
        if (!table || !table.markdown) {
          console.warn(
            `[OCR EXTRACTION] Skipping table on page ${page.index} for ${arxivId} due to missing markdown.`
          );
          return;
        }
        tables.push({
          index: tables.length,
          caption: table.caption || `Table ${tables.length + 1}`,
          originalCaption: table.caption || `Table ${tables.length + 1}`,
          tableMarkdown: table.markdown,
          identifier: `Table-${page.index}-${index}`,
          pageNumber: page.index,
        });
      });
    }
  });

  // Use manually detected tables if API found none (kept from original)
  if (
    tables.length === 0 &&
    ocrResult._manualTables &&
    ocrResult._manualTables.length > 0
  ) {
    console.log(
      `[OCR EXTRACTION] Using ${ocrResult._manualTables.length} manually detected tables for ${arxivId}`
    );
    ocrResult._manualTables.forEach((table) => {
      tables.push({
        index: tables.length,
        caption: table.caption || `Table ${tables.length + 1}`,
        originalCaption:
          table.originalCaption ||
          table.caption ||
          `Table ${tables.length + 1}`,
        tableMarkdown: table.markdown || table.tableMarkdown || "",
        identifier:
          table.identifier || `Table-${table.pageNumber}-${tables.length}`,
        pageNumber: table.pageNumber,
      });
    });
  }

  console.log(
    `[OCR EXTRACTION] Extracted ${tables.length} valid tables for ${arxivId}.`
  );
  return tables;
}

// Process and clean tables (Unchanged from original logic)
async function processAndCleanTables(tables, arxivId) {
  if (!tables || tables.length === 0) return [];
  const processedTables = tables.map((table) => ({ ...table }));
  return processedTables;
}

// Main Processing Function for a Single Paper (Modified to add arXiv delay)
async function processAndStorePaper(paper) {
  // Name kept from original
  console.log(`\n[PAPER PROCESSING] ========================================`);
  console.log(
    `[PAPER PROCESSING] Starting analysis for paper ${paper.id} (${paper.arxivId})`
  );
  const processingStartTime = new Date();
  let status = "pending";

  try {
    const pdfUrl = paper.pdfUrl || `https://arxiv.org/pdf/${paper.arxivId}.pdf`;

    // 1. Verify PDF exists (using export.arxiv.org)
    const pdfAccessible = await fetchPdf(pdfUrl, paper.arxivId); // Uses export internally

    // Add delay AFTER the check to respect arXiv rate limits
    console.log(
      `[Rate Limit] Delaying ${DELAY_AFTER_PDF_CHECK_MS}ms after PDF check for ${paper.arxivId}...`
    );
    await delay(DELAY_AFTER_PDF_CHECK_MS);

    if (!pdfAccessible) {
      console.log(
        `[PAPER PROCESSING] PDF for paper ${paper.id} is not accessible (checked export.arxiv.org).`
      );
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [], lastUpdated: new Date().toISOString() })
        .eq("id", paper.id);
      console.log(
        `[PAPER PROCESSING] Updated paper ${paper.id} with empty tables array.`
      );
      status = "skipped";
    } else {
      // 2. Process with Mistral OCR (using export.arxiv.org)
      const ocrResult = await processWithMistralOCR(pdfUrl, paper.arxivId); // Pass original URL

      if (!ocrResult) {
        console.log(
          `[PAPER PROCESSING] Paper ${paper.id} could not be processed with OCR.`
        );
        await supabase
          .from("arxivPapersData")
          .update({ paperTables: [], lastUpdated: new Date().toISOString() })
          .eq("id", paper.id);
        console.log(
          `[PAPER PROCESSING] Updated paper ${paper.id} with empty tables array after OCR failure.`
        );
        status = "failed_ocr";
      } else {
        // 3. Extract tables from OCR result
        const extractedTables = extractTablesFromOCR(ocrResult, paper.arxivId);

        // 4. Process tables
        const processedTables = await processAndCleanTables(
          extractedTables,
          paper.arxivId
        );

        // 5. Limit and Update Database
        const limitedTables = processedTables.slice(0, 10);
        if (processedTables.length > 10) {
          console.log(
            `[PAPER PROCESSING] Limiting to first 10 tables from ${processedTables.length} found for ${paper.id}.`
          );
        }

        console.log(
          `[PAPER PROCESSING] Updating database for ${paper.id} with ${limitedTables.length} tables...`
        );
        const { data, error } = await supabase
          .from("arxivPapersData")
          .update({
            paperTables: limitedTables,
            lastUpdated: new Date().toISOString(),
          })
          .eq("id", paper.id);

        if (error) {
          console.error(
            `[PAPER PROCESSING] Database update error for ${paper.id}:`,
            error
          );
          status = "failed_db_update";
        } else {
          console.log(
            `[PAPER PROCESSING] Successfully stored ${limitedTables.length} tables for paper ${paper.id}.`
          );
          status = "success";
        }
      }
    }
  } catch (error) {
    console.error(
      `[PAPER PROCESSING] Top-level error analyzing paper ${paper.id}:`,
      error
    );
    status = "failed_error";
    try {
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [], lastUpdated: new Date().toISOString() })
        .eq("id", paper.id);
      console.log(
        `[PAPER PROCESSING] Updated paper ${paper.id} with empty tables array due to top-level error.`
      );
    } catch (dbError) {
      console.error(
        `[PAPER PROCESSING] Failed to update paper ${paper.id} after error:`,
        dbError
      );
    }
  } finally {
    const processingEndTime = new Date();
    const duration = (processingEndTime - processingStartTime) / 1000;
    console.log(
      `[PAPER PROCESSING] Finished table analysis for paper ${
        paper.id
      }. Status: ${status}. Duration: ${duration.toFixed(2)}s`
    );
    console.log(`[PAPER PROCESSING] ========================================`);
    return { status: status, paperId: paper.id };
  }
}

// Main Function (Linear processing with Mistral delay)
async function main() {
  console.log("\n[MAIN] ================================================");
  console.log(
    "[MAIN] Starting Paper Table Extraction (Original Logic + Fixes - No Human Delays)"
  );
  console.log("[MAIN] ================================================");
  console.log(`[MAIN] - DB Batch Size: ${BATCH_SIZE}`);
  console.log(
    `[MAIN] - Delay After arXiv PDF Check: ${DELAY_AFTER_PDF_CHECK_MS}ms`
  );
  console.log(
    `[MAIN] - Delay After Mistral Call: ${DELAY_AFTER_MISTRAL_CALL_MS}ms`
  );

  const mainStartTime = new Date();
  console.log(`[MAIN] Process started at: ${mainStartTime.toISOString()}`);
  let totalProcessedInRun = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  try {
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    const fourDaysAgoISOString = fourDaysAgo.toISOString();
    console.log(
      `[MAIN] Querying for papers indexed since: ${fourDaysAgoISOString} needing tables.`
    );

    console.log(`[MAIN] Fetching batch of papers needing tables...`);
    const queryStartTime = new Date();
    const { data: papers, error: queryError } = await supabase
      .from("arxivPapersData")
      .select("id, arxivId, pdfUrl")
      .is("paperTables", null)
      .gte("indexedDate", fourDaysAgoISOString)
      .order("totalScore", { ascending: false })
      .order("indexedDate", { ascending: false })
      .limit(BATCH_SIZE);

    const queryEndTime = new Date();
    const queryDuration = (queryEndTime - queryStartTime) / 1000;
    console.log(
      `[MAIN] Database query completed in ${queryDuration.toFixed(2)} seconds`
    );

    if (queryError) {
      console.error(`[MAIN] Database query error fetching batch:`, queryError);
      throw queryError;
    }

    if (!papers?.length) {
      console.log(
        "[MAIN] No papers found needing table extraction. Process complete."
      );
      return;
    }

    console.log(`[MAIN] Retrieved ${papers.length} papers for processing.`);

    // --- Linear Processing Loop ---
    console.log(
      `[MAIN] Starting linear processing of ${papers.length} papers...`
    );
    for (const paper of papers) {
      // Process one paper
      const result = await processAndStorePaper(paper); // Use original function name
      totalProcessedInRun++;

      // Tally results
      switch (result.status) {
        case "success":
          totalSucceeded++;
          break;
        case "skipped":
          totalSkipped++;
          break;
        default:
          totalFailed++;
          break;
      }

      // Add delay AFTER processing each paper for Mistral rate limit
      if (totalProcessedInRun < papers.length) {
        console.log(
          `[Rate Limit] Delaying ${DELAY_AFTER_MISTRAL_CALL_MS}ms before next paper (Mistral limit)...`
        );
        await delay(DELAY_AFTER_MISTRAL_CALL_MS);
      }
    }
    console.log(`[MAIN] Linear processing finished.`);
    // --- End Linear Processing Loop ---
  } catch (error) {
    console.error("[MAIN] Error in main process:", error);
  } finally {
    const mainEndTime = new Date();
    const mainDuration = (mainEndTime - mainStartTime) / 1000;
    console.log(`[MAIN] ================================================`);
    console.log(
      `[MAIN] Process run completed at: ${mainEndTime.toISOString()}`
    );
    console.log(
      `[MAIN] Total execution time: ${mainDuration.toFixed(2)} seconds`
    );
    console.log(`[MAIN] Papers processed in this run: ${totalProcessedInRun}`);
    console.log(
      `[MAIN]   - Succeeded (incl. 0 tables found): ${totalSucceeded}`
    );
    console.log(`[MAIN]   - Skipped (PDF inaccessible): ${totalSkipped}`);
    console.log(`[MAIN]   - Failed (OCR/DB/Other error): ${totalFailed}`);
    console.log("\n[MAIN] Paper table extraction process run finished.");
    console.log("[MAIN] ================================================\n");
  }
}

// Start the script
main().catch(console.error);
