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
// Human-like behavior constants
const BATCH_SIZE = 20; // Smaller batch size for more natural processing
const BASE_DELAY = 5000; // Base delay between actions
const VARIANCE_FACTOR = 0.3; // 30% variance in timing
const READING_TIME_PER_WORD = 250; // ms per word for "reading"
const MIN_PAGE_VIEW_TIME = 15000; // Minimum time to view a page
const MAX_PAGE_VIEW_TIME = 90000; // Maximum time to view a page
const TYPING_SPEED = 200; // ms per character for "typing"
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
// Simulate reading time based on content length
function getReadingTime(text) {
  const words = text.split(/\s+/).length;
  const baseTime = words * READING_TIME_PER_WORD;
  return getHumanDelay(
    Math.min(Math.max(baseTime, MIN_PAGE_VIEW_TIME), MAX_PAGE_VIEW_TIME)
  );
}
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Process document with Mistral OCR
async function processWithMistralOCR(documentUrl) {
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
      // Simulate time spent analyzing this table
      await delay(getHumanDelay(4000));
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
      // Take a small break between tables
      await delay(getHumanDelay(2000));
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
    // Process with Mistral OCR
    console.log(`[PAPER PROCESSING] Initiating Mistral OCR processing`);
    const ocrResult = await processWithMistralOCR(pdfUrl);
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
    // Apply human-like delay to simulate reviewing extracted tables
    await delay(getHumanDelay(5000));
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
      // Final review before saving
      console.log(
        `[PAPER PROCESSING] Preparing to save ${processedTables.length} tables to database`
      );
      await delay(getHumanDelay(8000));
      // Update the database
      console.log(`[PAPER PROCESSING] Updating database with processed tables`);
      const { data, error } = await supabase
        .from("arxivPapersData")
        .update({
          paperTables: processedTables,
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);
      if (error) {
        console.error(`[PAPER PROCESSING] Database update error:`, error);
      } else {
        console.log(
          `[PAPER PROCESSING] Successfully stored ${processedTables.length} tables for paper ${paper.id}`
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
  console.log(`[MAIN] - Reading time per word: ${READING_TIME_PER_WORD} ms`);
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
        .select("id, arxivId, pdfUrl")
        .is("paperTables", null)
        .gte("totalScore", 0) // Only papers with score > 0.5
        .eq("id", "b32aa4a0-fb9b-41e4-9a6c-fadf43f41cbf") // FOR TESTING.. MUST REMOVE
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
      console.log(`[MAIN] Total papers processed so far: ${totalProcessed}`);
      startIndex += BATCH_SIZE;
      batchNumber++;
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
    console.log(`[MAIN] Total papers processed: ${totalProcessed}`);
    console.log(`[MAIN] Total batches processed: ${batchNumber - 1}`);
  } catch (error) {
    console.error("[MAIN] Error in main process:", error);
    console.error("[MAIN] Stack trace:", error.stack);
  }
  console.log("\n[MAIN] ================================================");
  console.log("[MAIN] Paper table extraction process complete");
  console.log("[MAIN] ================================================\n");
}
main().catch(console.error);
