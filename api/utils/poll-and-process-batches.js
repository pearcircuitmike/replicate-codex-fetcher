// File: utils/poll-and-process-batches.js
// Purpose: Polls Anthropic for status of pending batch jobs recorded in the 'batch_jobs' table.
//          Retrieves results for completed jobs, updates 'arxivPapersData', creates embeddings,
//          and updates the 'batch_jobs' table status.
// To be run frequently (e.g., every 10-15 minutes) via cron/pm2/systemd timer.

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai"; // Needed for embeddings

dotenv.config();

// --- Configuration ---
const BATCH_JOBS_TABLE = "batch_jobs";
const PAPERS_TABLE = "arxivPapersData";
const POLL_LIMIT = 50; // Max batches to check per run
const POLLING_INTERVAL_MS = 15 * 60 * 1000; // How often this script *should* be run (e.g., 15 minutes)
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // Prevent overlap if a run takes > 10 mins

// --- Initializations ---
const logWithTimestamp = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[PollProcessBatch ${timestamp}] ${message}`);
};

// Initialize Clients (Add error handling as before)
let supabase, anthropic, openai;
try {
  logWithTimestamp("Initializing clients...");
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey)
    throw new Error("Supabase URL or Key missing.");
  supabase = createClient(supabaseUrl, supabaseKey);

  const claudeApiKey = process.env.ANTHROPIC_PAPERS_GENERATE_SUMMARY_API_KEY;
  if (!claudeApiKey) throw new Error("Anthropic API Key missing.");
  anthropic = new Anthropic({ apiKey: claudeApiKey });

  const openaiApiKey = process.env.OPENAI_SECRET_KEY;
  if (!openaiApiKey)
    logWithTimestamp(
      "Warning: OpenAI Secret Key missing. Embeddings disabled."
    );
  openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

  logWithTimestamp("Clients Initialized.");
} catch (error) {
  logWithTimestamp(`ERROR initializing clients: ${error.message}`);
  process.exit(1);
}

// Simple in-memory lock to prevent overlap if run too frequently
let isRunning = false;

// --- Helper Functions ---
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to create embeddings - Copied/adapted from original script
async function createEmbeddingForPaper(paperId, generatedSummary) {
  if (!openai) {
    logWithTimestamp(`Skipping embedding ${paperId}: OpenAI client missing.`);
    return null;
  }
  logWithTimestamp(`Creating embedding for paper ${paperId}`);
  try {
    const { data: paperData, error: fetchError } = await supabase
      .from(PAPERS_TABLE)
      .select(
        "id, title, arxivCategories, abstract, authors, lastUpdated, arxivId"
      )
      .eq("id", paperId)
      .single();
    if (fetchError)
      throw new Error(
        `DB error fetching paper data for embedding (ID: ${paperId}): ${fetchError.message}`
      );
    if (!paperData)
      throw new Error(`Paper ${paperId} not found for embedding.`);
    const inputText = [
      `Title: ${paperData.title || ""}`,
      `Abstract: ${paperData.abstract || ""}`,
      `Summary: ${generatedSummary || ""}`,
      `Categories: ${paperData.arxivCategories?.join(", ") || ""}`,
      `Authors: ${paperData.authors?.join(", ") || ""}`,
      `ArXiv ID: ${paperData.arxivId || ""}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .substring(0, 8190);
    if (!inputText.trim())
      throw new Error(`Input text empty for embedding (Paper ID: ${paperId}).`);
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: inputText,
    });
    const embedding = embeddingResponse?.data?.[0]?.embedding;
    if (!embedding)
      throw new Error(
        `OpenAI response invalid for embedding (Paper ID: ${paperId}).`
      );
    const { error: updateError } = await supabase
      .from(PAPERS_TABLE)
      .update({ embedding: embedding, lastUpdated: new Date().toISOString() })
      .eq("id", paperData.id);
    if (updateError)
      throw new Error(
        `DB error updating embedding for ${paperId}: ${updateError.message}`
      );
    logWithTimestamp(`Embedding created/stored for paper ${paperData.id}`);
    return embedding;
  } catch (error) {
    logWithTimestamp(
      `ERROR creating embedding for paper ${paperId}: ${error.message}`
    );
    console.error(error);
    return null;
  }
}

// Function to process results for a completed batch
async function processBatchResults(batchJob) {
  logWithTimestamp(
    `Starting result processing for Batch ID: ${batchJob.batch_id} (Type: ${batchJob.batch_type})`
  );
  let batchSuccessCount = 0;
  let batchErrorCount = 0;
  let overallProcessingStatus = "processed"; // Assume success initially
  let finalErrorMessage = null;

  try {
    for await (const result of await anthropic.messages.batches.results(
      batchJob.batch_id
    )) {
      const paperIdStr = result.custom_id;
      if (!paperIdStr) {
        logWithTimestamp(
          `WARN: Result missing custom_id in batch ${batchJob.batch_id}. Skipping.`
        );
        batchErrorCount++;
        overallProcessingStatus = "processed_with_errors";
        continue;
      }
      const paperId = parseInt(paperIdStr, 10); // Assuming paper ID is integer

      try {
        // Add try/catch around individual result processing
        if (result.result.type === "succeeded") {
          const textContent = result.result.message?.content?.[0]?.text?.trim();
          if (!textContent) {
            logWithTimestamp(
              `WARN: Empty content for succeeded paper ${paperId} in batch ${batchJob.batch_id}. Marking as error.`
            );
            batchErrorCount++;
            // Optionally mark paper as failed
            continue;
          }

          let updatePayload = {};
          let embeddingSuccess = true;

          if (batchJob.batch_type === "outline") {
            updatePayload = {
              generatedOutline: textContent,
              outlineGeneratedAt: new Date().toISOString(),
            };
            logWithTimestamp(`Processed outline for paper ${paperId}.`);
          } else if (batchJob.batch_type === "summary") {
            updatePayload = {
              generatedSummary: textContent,
              enhancedSummaryCreatedAt: new Date().toISOString(),
              embedding: null,
            };
            const embedding = await createEmbeddingForPaper(
              paperId,
              textContent
            );
            if (!embedding) {
              logWithTimestamp(
                `WARN: Processed summary but FAILED to generate embedding for paper ${paperId}.`
              );
              embeddingSuccess = false;
              overallProcessingStatus = "processed_with_errors"; // Mark batch if any embedding fails
            } else {
              logWithTimestamp(
                `Processed summary and generated embedding for paper ${paperId}.`
              );
            }
          } else {
            logWithTimestamp(
              `WARN: Unknown batch_type '${batchJob.batch_type}' for paper ${paperId} in batch ${batchJob.batch_id}.`
            );
            batchErrorCount++;
            continue;
          }

          // Update the main paper table
          const { error: paperUpdateError } = await supabase
            .from(PAPERS_TABLE)
            .update({ ...updatePayload, lastUpdated: new Date().toISOString() })
            .eq("id", paperId);

          if (paperUpdateError) {
            logWithTimestamp(
              `ERROR updating paper ${paperId} result from batch ${batchJob.batch_id}: ${paperUpdateError.message}`
            );
            batchErrorCount++;
            overallProcessingStatus = "processed_with_errors"; // Don't fail entire batch for one paper update usually
          } else {
            if (embeddingSuccess) batchSuccessCount++;
            else batchErrorCount++;
          }
        } else {
          // Handle failed result for this paper
          logWithTimestamp(
            `Result failed for paper ${paperId} in batch ${
              batchJob.batch_id
            }. Type: ${result.result.type}, Error: ${
              result.result.error?.type || "N/A"
            }`
          );
          batchErrorCount++;
          overallProcessingStatus = "processed_with_errors";
          // Optionally mark paper as failed in arxivPapersData table
        }
      } catch (paperProcessingError) {
        logWithTimestamp(
          `ERROR processing individual result for paper ${paperId} in batch ${batchJob.batch_id}: ${paperProcessingError.message}`
        );
        console.error(paperProcessingError);
        batchErrorCount++;
        overallProcessingStatus = "processed_with_errors";
      }
      await delay(100); // Small delay between processing results
    } // end for await results loop
  } catch (error) {
    logWithTimestamp(
      `CRITICAL ERROR processing results stream for batch ${batchJob.batch_id}: ${error.message}`
    );
    console.error(error);
    overallProcessingStatus = "failed"; // Mark batch as failed if result processing loop fails critically
    finalErrorMessage = `Result processing error: ${error.message}`.substring(
      0,
      1000
    );
    // Estimate counts if loop failed
    batchErrorCount = batchJob.total_requests || 1;
    batchSuccessCount = 0;
  }

  // Final update to the batch_jobs table
  logWithTimestamp(
    `Finished processing results for Batch ${batchJob.batch_id}. Success: ${batchSuccessCount}, Errors: ${batchErrorCount}. Final Status: ${overallProcessingStatus}`
  );
  try {
    const { error: finalUpdateError } = await supabase
      .from(BATCH_JOBS_TABLE)
      .update({
        status: overallProcessingStatus,
        processed_at: new Date().toISOString(),
        succeeded_count: batchSuccessCount,
        failed_count: batchErrorCount,
        error_message: finalErrorMessage, // Store error message if processing failed
      })
      .eq("batch_id", batchJob.batch_id);

    if (finalUpdateError) {
      logWithTimestamp(
        `CRITICAL DB ERROR: Failed to update final status for batch ${batchJob.batch_id}: ${finalUpdateError.message}`
      );
    }
  } catch (dbUpdateError) {
    logWithTimestamp(
      `CRITICAL DB EXCEPTION: Failed to update final status for batch ${batchJob.batch_id}: ${dbUpdateError.message}`
    );
  }
}

// --- Main Polling Function ---
async function pollAndProcessBatches() {
  if (isRunning) {
    logWithTimestamp("Polling cycle already running. Skipping.");
    return;
  }
  isRunning = true;
  logWithTimestamp("Starting polling cycle...");
  const cycleStartTime = Date.now();

  let jobsToCheck = [];
  try {
    // Find jobs that need attention
    const twentyFiveHoursAgo = new Date(
      Date.now() - 25 * 60 * 60 * 1000
    ).toISOString();
    const { data, error } = await supabase
      .from(BATCH_JOBS_TABLE)
      .select("*")
      .in("status", ["submitted", "polling", "completed"]) // Check submitted, polling, or completed (ready to process)
      .gte("submitted_at", twentyFiveHoursAgo)
      .order("submitted_at", { ascending: true })
      .limit(POLL_LIMIT);

    if (error)
      throw new Error(`DB ERROR fetching pending jobs: ${error.message}`);
    jobsToCheck = data || [];
    logWithTimestamp(`Found ${jobsToCheck.length} batch jobs to check.`);
  } catch (dbError) {
    logWithTimestamp(`DB Exception fetching pending jobs: ${dbError.message}`);
    console.error(dbError);
    isRunning = false; // Release lock on error
    return;
  }

  if (jobsToCheck.length === 0) {
    logWithTimestamp("No pending batch jobs found in this cycle.");
    isRunning = false; // Release lock
    return;
  }

  // Process jobs sequentially for simplicity
  for (const job of jobsToCheck) {
    logWithTimestamp(
      `Checking batch ${job.batch_id} (Current DB status: ${job.status})...`
    );
    let currentBatchStatus;
    let jobProcessedInThisCycle = false;

    try {
      // Mark as polling (if not already completed)
      if (job.status !== "completed") {
        await supabase
          .from(BATCH_JOBS_TABLE)
          .update({
            status: "polling",
            last_polled_at: new Date().toISOString(),
          })
          .eq("batch_id", job.batch_id);
      }

      // Check Anthropic status
      currentBatchStatus = await anthropic.messages.batches.retrieve(
        job.batch_id
      );
      const apiStatus = currentBatchStatus.processing_status;
      logWithTimestamp(`Batch ${job.batch_id} API Status: ${apiStatus}`);

      // Prepare payload for DB update
      const updatePayload = {
        last_polled_at: new Date().toISOString(),
        succeeded_count:
          currentBatchStatus.request_counts?.succeeded ??
          job.succeeded_count ??
          0,
        failed_count:
          (currentBatchStatus.request_counts?.errored ?? 0) +
          (currentBatchStatus.request_counts?.expired ?? 0) +
          (currentBatchStatus.request_counts?.canceled ?? 0),
        results_url: currentBatchStatus.results_url || job.results_url || null, // Ensure null if not present
        completed_at: currentBatchStatus.ended_at || job.completed_at || null, // Store when Anthropic finished
        error_message: job.error_message, // Preserve existing error unless overwritten
      };

      let nextStatus = job.status; // Keep current status unless changed

      if (apiStatus === "ended" || apiStatus === "completed") {
        // Only transition to 'completed' if not already processed or failed
        if (
          job.status !== "processed" &&
          job.status !== "processed_with_errors" &&
          job.status !== "failed" &&
          job.status !== "expired" &&
          job.status !== "canceled"
        ) {
          nextStatus = "completed";
        }
        if (!updatePayload.completed_at)
          updatePayload.completed_at = new Date().toISOString(); // Set completion time if missing
      } else if (
        apiStatus === "failed" ||
        apiStatus === "expired" ||
        apiStatus === "canceled"
      ) {
        nextStatus = apiStatus; // Use Anthropic's terminal failure state
        if (!updatePayload.completed_at)
          updatePayload.completed_at = new Date().toISOString();
        if (!updatePayload.error_message)
          updatePayload.error_message = `Anthropic reported final status: ${apiStatus}`;
      } else if (apiStatus === "canceling") {
        nextStatus = "canceling";
      } else {
        // Still in_progress
        nextStatus = "polling"; // Explicitly set back to polling
      }

      updatePayload.status = nextStatus;

      // Update batch_jobs table with latest status from Anthropic
      const { error: statusUpdateError } = await supabase
        .from(BATCH_JOBS_TABLE)
        .update(updatePayload)
        .eq("batch_id", job.batch_id);

      if (statusUpdateError) {
        logWithTimestamp(
          `DB ERROR updating status for batch ${job.batch_id}: ${statusUpdateError.message}`
        );
        continue; // Skip processing results if status update failed
      }

      // If job is now marked as completed, process results
      if (updatePayload.status === "completed") {
        jobProcessedInThisCycle = true;
        // Mark as 'processing_results' BEFORE starting async processing
        await supabase
          .from(BATCH_JOBS_TABLE)
          .update({ status: "processing_results" })
          .eq("batch_id", job.batch_id);
        // Call the results processing function (can run long)
        // Pass the latest known data for the job
        await processBatchResults({ ...job, ...updatePayload });
      }
    } catch (error) {
      logWithTimestamp(
        `ERROR polling/processing batch ${job.batch_id}: ${error.message}`
      );
      console.error(error);
      jobProcessedInThisCycle = true; // Attempted processing, even if failed
      // Mark batch as failed in DB if a critical error occurred
      try {
        await supabase
          .from(BATCH_JOBS_TABLE)
          .update({
            status: "failed",
            error_message:
              `Polling/Processing Exception: ${error.message}`.substring(
                0,
                1000
              ),
          })
          .eq("batch_id", job.batch_id);
      } catch (dbUpdateError) {
        logWithTimestamp(
          `CRITICAL DB ERROR: Failed to mark batch ${job.batch_id} as failed after error: ${dbUpdateError.message}`
        );
      }
    }

    // Avoid hammering API if processing happens quickly or many jobs checked
    if (!jobProcessedInThisCycle) {
      await delay(500); // Delay only if job wasn't processed (still polling)
    }
  } // end for loop

  isRunning = false; // Release lock
  const cycleDuration = (Date.now() - cycleStartTime) / 1000;
  logWithTimestamp(`Polling cycle finished in ${cycleDuration.toFixed(1)}s.`);
}

// --- Script Execution ---

// Run immediately on start, and then set an interval.
// This makes it suitable for running under PM2 which keeps the process alive.
logWithTimestamp(
  `Executing Poller/Processor Script: ${
    process.argv[1] || "poll-and-process-batches.js"
  }`
);

// Initial run
pollAndProcessBatches();

// Schedule subsequent runs
// Note: Consider potential drift with setInterval over long periods.
// A cron job triggering this script (without the interval) might be more precise.
// However, setInterval is simpler to manage with PM2 alone.
setInterval(() => {
  pollAndProcessBatches();
}, POLLING_INTERVAL_MS);

// Optional: Handle graceful shutdown
process.on("SIGINT", () => {
  logWithTimestamp("Received SIGINT. Shutting down poller...");
  // Add any cleanup logic here if needed
  process.exit(0);
});
process.on("SIGTERM", () => {
  logWithTimestamp("Received SIGTERM. Shutting down poller...");
  process.exit(0);
});

// Keep the process running for setInterval
logWithTimestamp(
  `Poller started. Will run every ${POLLING_INTERVAL_MS / 1000 / 60} minutes.`
);
// process.stdin.resume(); // Keep process alive for interval (might not be needed with pm2)

// --- END OF FILE ---
