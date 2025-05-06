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
const mistralClient = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});
console.log("[INIT] Mistral OCR model initialized");

// Human-like behavior constants for arxiv.org and PDF fetching
const BATCH_SIZE = 40; // adjust as need - match batch scheduler
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

// Simulate human-like delay
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

// Fetch PDF with realistic browsing behavior
async function fetchPdf(pdfUrl, arxivId, retryCount = 0) {
  console.log(`[NETWORK] Fetching PDF for ${arxivId}...`);

  // More realistic referrers
  const referrers = [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/abs/" + arxivId,
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
    console.log(`[NETWORK] Sending HTTP request to fetch PDF...`);
    const requestStartTime = new Date();

    // For PDFs, we don't actually download the file, just verify it exists
    const response = await axios.head(pdfUrl, {
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

    // Simulate time to load the page
    const loadingTime = getHumanDelay(3000);
    console.log(
      `[NETWORK] Verifying PDF accessibility (${Math.round(
        loadingTime / 1000
      )} seconds)...`
    );
    await delay(loadingTime);

    return true; // PDF exists and is accessible
  } catch (error) {
    console.error(
      `[NETWORK] Error fetching PDF for ${arxivId}:`,
      error.message
    );
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
      return fetchPdf(pdfUrl, arxivId, retryCount + 1);
    }

    console.error(
      `[NETWORK] Maximum retry attempts reached for PDF ${arxivId}`
    );
    return false;
  }
}

// Process document with Mistral OCR
async function processWithMistralOCR(documentUrl, arxivId) {
  try {
    console.log(`[MISTRAL OCR] Starting OCR processing for: ${documentUrl}`);
    console.log(`[MISTRAL OCR] Using model: mistral-ocr-latest`);
    console.log(`[MISTRAL OCR] Document type: document_url`);

    // Log start time
    const startTime = new Date();
    console.log(`[MISTRAL OCR] Start time: ${startTime.toISOString()}`);

    // Simulate human thinking about processing the document
    await delay(getHumanDelay(3000));

    // Make API call with timing
    console.log(`[MISTRAL OCR] Sending request to Mistral API...`);
    const apiCallStartTime = new Date();

    const ocrResponse = await mistralClient.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: documentUrl,
      },
      includeImageBase64: false, // Set to false to reduce payload size
    });

    const apiCallEndTime = new Date();
    const apiCallDuration = (apiCallEndTime - apiCallStartTime) / 1000;
    console.log(
      `[MISTRAL OCR] API call completed in ${apiCallDuration.toFixed(
        2
      )} seconds`
    );

    // Log OCR processing results
    console.log(
      `[MISTRAL OCR] Processing complete with ${
        ocrResponse.pages?.length || 0
      } pages`
    );

    // Detailed logging for table detection
    let totalTablesDetected = 0;
    let pagesWithTables = 0;

    if (ocrResponse.pages) {
      console.log(
        `[MISTRAL OCR] Analyzing table structure in ${ocrResponse.pages.length} pages...`
      );

      ocrResponse.pages.forEach((page) => {
        const hasTablesField = !!page.tables;
        const tableCount = hasTablesField ? page.tables.length : 0;

        console.log(
          `[MISTRAL OCR] Page ${page.index}: Has tables field: ${hasTablesField}, Table count: ${tableCount}`
        );

        if (tableCount > 0) {
          pagesWithTables++;
          totalTablesDetected += tableCount;

          // Log first table details for debugging
          const firstTable = page.tables[0];
          console.log(`[MISTRAL OCR] Sample table from page ${page.index}:`);
          console.log(`[MISTRAL OCR] - Has caption: ${!!firstTable.caption}`);
          console.log(`[MISTRAL OCR] - Has markdown: ${!!firstTable.markdown}`);

          if (firstTable.markdown) {
            console.log(
              `[MISTRAL OCR] - Markdown preview: ${firstTable.markdown.substring(
                0,
                100
              )}...`
            );
          }
        }

        // Search for potential table structures in page markdown
        if (page.markdown && page.markdown.includes("|")) {
          console.log(
            `[MISTRAL OCR] Page ${page.index} contains pipe characters, checking for table structures...`
          );
        }
      });
    }

    console.log(
      `[MISTRAL OCR] OCR found ${totalTablesDetected} tables across ${pagesWithTables} pages`
    );

    // Enhance with manual table detection if needed
    if (totalTablesDetected === 0) {
      console.log(
        `[MISTRAL OCR] No tables detected by OCR API, performing manual table detection...`
      );
      ocrResponse._manualTables = detectTablesFromMarkdown(ocrResponse);
      console.log(
        `[MISTRAL OCR] Manual detection found ${ocrResponse._manualTables.length} potential tables`
      );
    }

    // Simulate reviewing the OCR results
    await delay(getHumanDelay(5000));

    // Log end time and duration
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;
    console.log(`[MISTRAL OCR] End time: ${endTime.toISOString()}`);
    console.log(
      `[MISTRAL OCR] Total processing duration: ${duration.toFixed(2)} seconds`
    );

    return ocrResponse;
  } catch (error) {
    console.error(`[MISTRAL OCR] Error processing document:`, error);
    console.error(
      `[MISTRAL OCR] Error details:`,
      JSON.stringify(error, null, 2)
    );

    // Log more specific error information if available
    if (error.response) {
      console.error(
        `[MISTRAL OCR] API response status:`,
        error.response.status
      );
      console.error(`[MISTRAL OCR] API response data:`, error.response.data);
    }

    return null;
  }
}

// Manual table detection from page markdown
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

  ocrResult.pages.forEach((page, pageIndex) => {
    if (!page.markdown) return;

    console.log(
      `[TABLE DETECTION] Analyzing page ${page.index} for table patterns`
    );

    const lines = page.markdown.split("\n");
    let tableStartLine = -1;
    let inTable = false;
    let consecutiveTableLines = 0;
    let tableCaptionLine = -1;
    let tableCaption = "";

    // Look for table caption patterns
    const captionPattern = /Table\s+\d+\s*[:.]/i;

    // Process lines to find tables
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Check for table captions
      if (captionPattern.test(line) && !inTable) {
        tableCaptionLine = i;
        tableCaption = line;
        console.log(
          `[TABLE DETECTION] Potential table caption found: "${line}"`
        );
      }

      // Count vertical bars (|) to detect table rows
      const pipeCount = (line.match(/\|/g) || []).length;
      const isTableLine = pipeCount >= 3 && line.includes("|");

      // Also check for lines with lots of dashes and plus signs (ASCII tables)
      const dashCount = (line.match(/-/g) || []).length;
      const plusCount = (line.match(/\+/g) || []).length;
      const isAsciiTableLine =
        (dashCount > 10 && plusCount >= 2) ||
        (line.includes("+--") && line.includes("--+"));

      if (isTableLine || isAsciiTableLine) {
        if (!inTable) {
          tableStartLine = i;
          inTable = true;
          console.log(
            `[TABLE DETECTION] Potential table start detected at line ${i + 1}`
          );
        }
        consecutiveTableLines++;
      } else if (inTable) {
        // If there's a blank line or non-table content, check if we found a valid table
        if (consecutiveTableLines >= 3) {
          // Extract the table content
          const tableContent = lines.slice(tableStartLine, i).join("\n");
          const caption = tableCaption || `Table on page ${page.index}`;

          console.log(
            `[TABLE DETECTION] Table detected with ${consecutiveTableLines} rows`
          );

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

    // Handle table that continues to the end of the page
    if (inTable && consecutiveTableLines >= 3) {
      const tableContent = lines.slice(tableStartLine).join("\n");
      const caption = tableCaption || `Table on page ${page.index}`;

      console.log(
        `[TABLE DETECTION] Table at end of page detected with ${consecutiveTableLines} rows`
      );

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

// Extract tables from OCR result
function extractTablesFromOCR(ocrResult, arxivId) {
  if (!ocrResult || !ocrResult.pages) {
    console.log(`[OCR EXTRACTION] No valid OCR result for ${arxivId}`);
    return [];
  }

  console.log(
    `[OCR EXTRACTION] Starting table extraction from OCR result for ${arxivId}`
  );
  console.log(`[OCR EXTRACTION] Document has ${ocrResult.pages.length} pages`);

  const tables = [];
  let pagesWithTables = 0;
  let totalTablesDetected = 0;

  // First try to extract tables from the OCR API's tables field
  ocrResult.pages.forEach((page) => {
    if (page.tables && page.tables.length > 0) {
      pagesWithTables++;
      totalTablesDetected += page.tables.length;

      console.log(
        `[OCR EXTRACTION] Page ${page.index}: Found ${page.tables.length} tables`
      );

      page.tables.forEach((table, index) => {
        // Log table details
        console.log(
          `[OCR EXTRACTION] Processing table ${index + 1} from page ${
            page.index
          }`
        );
        console.log(`[OCR EXTRACTION] Caption present: ${!!table.caption}`);
        console.log(
          `[OCR EXTRACTION] Markdown content length: ${
            table.markdown ? table.markdown.length : 0
          } characters`
        );

        // Create table object
        const tableObj = {
          index: tables.length,
          caption: table.caption || `Table ${tables.length + 1}`,
          originalCaption: table.caption || `Table ${tables.length + 1}`,
          tableMarkdown: table.markdown || "",
          identifier: `Table-${page.index}-${index}`,
          pageNumber: page.index,
        };

        tables.push(tableObj);
      });
    } else {
      console.log(
        `[OCR EXTRACTION] Page ${page.index}: No tables found in OCR API result`
      );
    }
  });

  // If no tables were found, use manually detected tables
  if (
    tables.length === 0 &&
    ocrResult._manualTables &&
    ocrResult._manualTables.length > 0
  ) {
    console.log(
      `[OCR EXTRACTION] Using ${ocrResult._manualTables.length} manually detected tables`
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

    totalTablesDetected = ocrResult._manualTables.length;
    pagesWithTables = new Set(ocrResult._manualTables.map((t) => t.pageNumber))
      .size;
  }

  console.log(`[OCR EXTRACTION] Summary for ${arxivId}:`);
  console.log(`[OCR EXTRACTION] - Total pages: ${ocrResult.pages.length}`);
  console.log(`[OCR EXTRACTION] - Pages with tables: ${pagesWithTables}`);
  console.log(
    `[OCR EXTRACTION] - Total tables detected: ${totalTablesDetected}`
  );
  console.log(
    `[OCR EXTRACTION] - Total valid tables extracted: ${tables.length}`
  );

  return tables;
}

async function processAndCleanTables(tables, arxivId) {
  console.log(
    `[TABLE PROCESSING] Starting processing of ${tables.length} tables for paper ${arxivId}`
  );

  const processedTables = [];

  for (const [index, table] of tables.entries()) {
    try {
      console.log(
        `[TABLE PROCESSING] Processing table ${index + 1}/${
          tables.length
        } from page ${table.pageNumber || "unknown"}`
      );

      // Add the table to processed tables without modifying the caption
      console.log(
        `[TABLE PROCESSING] Adding table with identifier: ${table.identifier}`
      );
      console.log(
        `[TABLE PROCESSING] Caption length: ${
          table.caption ? table.caption.length : 0
        } characters`
      );
      console.log(
        `[TABLE PROCESSING] Table content length: ${
          table.tableMarkdown ? table.tableMarkdown.length : 0
        } characters`
      );

      processedTables.push(table);
    } catch (error) {
      console.error(
        `[TABLE PROCESSING] Error processing table ${index}:`,
        error
      );
    }
  }

  console.log(
    `[TABLE PROCESSING] Completed processing all ${processedTables.length} tables for ${arxivId}`
  );
  return processedTables;
}

async function processAndStorePaper(paper) {
  console.log(`\n[PAPER PROCESSING] ========================================`);
  console.log(
    `[PAPER PROCESSING] Starting analysis for paper ${paper.id} (${paper.arxivId})`
  );
  console.log(`[PAPER PROCESSING] ========================================`);

  try {
    // Get PDF URL
    const pdfUrl = paper.pdfUrl || `https://arxiv.org/pdf/${paper.arxivId}.pdf`;
    console.log(`[PAPER PROCESSING] Using PDF URL: ${pdfUrl}`);

    // Log start time
    const startTime = new Date();
    console.log(`[PAPER PROCESSING] Start time: ${startTime.toISOString()}`);

    // First verify PDF exists with human-like behavior
    console.log(
      `[PAPER PROCESSING] Verifying PDF accessibility before OCR processing`
    );
    const pdfAccessible = await fetchPdf(pdfUrl, paper.arxivId);

    if (!pdfAccessible) {
      console.log(
        `[PAPER PROCESSING] PDF for paper ${paper.id} is not accessible`
      );
      console.log(
        `[PAPER PROCESSING] Updating database with empty tables array`
      );

      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({ paperTables: [], lastUpdated: new Date().toISOString() })
        .eq("id", paper.id);

      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(`[PAPER PROCESSING] Database updated successfully`);
      }

      return;
    }

    console.log(
      `[PAPER PROCESSING] PDF is accessible, proceeding with OCR processing`
    );

    // Simulate time spent examining the PDF
    const pdfExamineTime = getHumanDelay(10000);
    console.log(
      `[PAPER PROCESSING] Examining PDF structure (${Math.round(
        pdfExamineTime / 1000
      )} seconds)...`
    );
    await delay(pdfExamineTime);

    // Process with Mistral OCR
    console.log(`[PAPER PROCESSING] Initiating Mistral OCR processing`);
    const ocrResult = await processWithMistralOCR(pdfUrl, paper.arxivId);

    if (!ocrResult) {
      console.log(
        `[PAPER PROCESSING] Paper ${paper.id} could not be processed with OCR`
      );
      console.log(
        `[PAPER PROCESSING] Updating database with empty tables array`
      );

      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({ paperTables: [], lastUpdated: new Date().toISOString() })
        .eq("id", paper.id);

      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(`[PAPER PROCESSING] Database updated successfully`);
      }

      return;
    }

    // Extract tables from OCR result
    console.log(`[PAPER PROCESSING] Extracting tables from OCR result`);
    const extractedTables = extractTablesFromOCR(ocrResult, paper.arxivId);

    // Log extraction results
    console.log(
      `[PAPER PROCESSING] Table extraction complete. Found ${extractedTables.length} tables`
    );

    if (extractedTables.length > 0) {
      // Process and clean the tables
      console.log(`[PAPER PROCESSING] Starting table processing`);
      const processedTables = await processAndCleanTables(
        extractedTables,
        paper.arxivId
      );

      // Sort tables by index
      console.log(`[PAPER PROCESSING] Sorting tables by index`);
      processedTables.sort((a, b) => a.index - b.index);

      // Log table details
      processedTables.forEach((table, index) => {
        console.log(`[PAPER PROCESSING] Table ${index + 1} details:`);
        console.log(`[PAPER PROCESSING]   - ID: ${table.identifier}`);
        console.log(`[PAPER PROCESSING]   - Page: ${table.pageNumber}`);
        console.log(
          `[PAPER PROCESSING]   - Caption length: ${
            table.caption ? table.caption.length : 0
          } chars`
        );
        console.log(
          `[PAPER PROCESSING]   - Content length: ${
            table.tableMarkdown ? table.tableMarkdown.length : 0
          } chars`
        );
      });

      // Limit to first 10 tables with explanation
      let limitedTables = processedTables;
      if (processedTables.length > 10) {
        console.log(
          `[PAPER PROCESSING] Limiting to first 10 tables from the ${processedTables.length} total found`
        );
        limitedTables = processedTables.slice(0, 10);
      }

      // Update the database
      console.log(`[PAPER PROCESSING] Updating database with processed tables`);
      const dbUpdateStartTime = new Date();

      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({
          paperTables: limitedTables,
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);

      const dbUpdateEndTime = new Date();
      const dbUpdateDuration = (dbUpdateEndTime - dbUpdateStartTime) / 1000;

      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(
          `[PAPER PROCESSING] Successfully stored ${
            limitedTables.length
          } tables for paper ${paper.id} in ${dbUpdateDuration.toFixed(
            2
          )} seconds`
        );
      }
    } else {
      console.log(`[PAPER PROCESSING] No tables found for paper ${paper.id}`);
      console.log(
        `[PAPER PROCESSING] Updating database with empty tables array`
      );

      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({ paperTables: [], lastUpdated: new Date().toISOString() })
        .eq("id", paper.id);

      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(`[PAPER PROCESSING] Database updated successfully`);
      }
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
    console.log(`[PAPER PROCESSING] ========================================`);
  } catch (error) {
    console.error(
      `[PAPER PROCESSING] Error analyzing paper ${paper.id}:`,
      error
    );
    console.error(`[PAPER PROCESSING] Stack trace:`, error.stack);
    console.log(
      `[PAPER PROCESSING] Updating database with empty tables array due to error`
    );

    const { data, error: dbError } = await supabase
      .from("arxivPapersData")
      .update({ paperTables: [], lastUpdated: new Date().toISOString() })
      .eq("id", paper.id);

    if (dbError) {
      console.error(`[PAPER PROCESSING] Database update error:`, dbError);
    }

    console.log(`[PAPER PROCESSING] ========================================`);
  }
}

async function main() {
  console.log("\n[MAIN] ================================================");
  console.log("[MAIN] Starting paper table extraction with Mistral OCR");
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
      .is("paperTables", null)
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
        const sessionBreak = getHumanDelay(30000); // 30-s average break
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
        .is("paperTables", null)
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
  console.log("[MAIN] Paper table extraction process complete");
  console.log("[MAIN] ================================================\n");
}

// Start the script
main().catch(console.error);
