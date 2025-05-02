// File: utils/poll-and-process-batches.js (Corrected)
// Purpose: Polls Anthropic batch jobs, processes results, updates DBs.
// Runs frequently via scheduler.

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

dotenv.config();

// --- Configuration ---
const BATCH_JOBS_TABLE = "batch_jobs";
const PAPERS_TABLE = "arxivPapersData";
const POLL_LIMIT = 50;
const POLLING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// --- Initializations ---
const logWithTimestamp = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[PollProcessBatch ${timestamp}] ${message}`);
};

let supabase, anthropic, openai;
try {
  logWithTimestamp("Initializing clients...");
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_PAPERS_GENERATE_SUMMARY_API_KEY,
  });
  if (!process.env.OPENAI_SECRET_KEY)
    logWithTimestamp(
      "Warning: OpenAI Secret Key missing. Embeddings disabled."
    );
  openai = process.env.OPENAI_SECRET_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_SECRET_KEY })
    : null;
  if (!supabase || !anthropic)
    throw new Error("Supabase or Anthropic client failed to initialize.");
  logWithTimestamp("Clients Initialized.");
} catch (error) {
  logWithTimestamp(`ERROR initializing clients: ${error.message}`);
  process.exit(1);
}

let isRunning = false;

// --- Helper Functions ---
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createEmbeddingForPaper(paperId, generatedSummary) {
  // Expects paperId to be the correct type (string UUID in this case)
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
      .single(); // Use paperId directly
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
      .eq("id", paperData.id); // Use paperData.id (which is correct type)
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

async function processBatchResults(batchJob) {
  logWithTimestamp(
    `Starting result processing for Batch ID: ${batchJob.batch_id} (Type: ${batchJob.batch_type})`
  );
  let batchSuccessCount = 0;
  let batchErrorCount = 0;
  let overallProcessingStatus = "processed";
  let finalErrorMessage = null;

  try {
    for await (const result of await anthropic.messages.batches.results(
      batchJob.batch_id
    )) {
      const paperIdStr = result.custom_id; // Keep as string (UUID)
      if (!paperIdStr) {
        logWithTimestamp(
          `WARN: Result missing custom_id in batch ${batchJob.batch_id}. Skipping.`
        );
        batchErrorCount++;
        overallProcessingStatus = "processed_with_errors";
        continue;
      }
      // *** REMOVED parseInt - Use paperIdStr directly where needed for DB queries ***
      // const paperId = parseInt(paperIdStr, 10); // REMOVED

      try {
        if (result.result.type === "succeeded") {
          const textContent = result.result.message?.content?.[0]?.text?.trim();
          if (!textContent) {
            logWithTimestamp(
              `WARN: Empty content for succeeded paper ${paperIdStr} in batch ${batchJob.batch_id}. Marking as error.`
            );
            batchErrorCount++;
            overallProcessingStatus = "processed_with_errors";
            continue;
          }

          let updatePayload = {};
          let embeddingSuccess = true;

          if (batchJob.batch_type === "outline") {
            updatePayload = {
              generatedOutline: textContent,
              outlineGeneratedAt: new Date().toISOString(),
            };
            logWithTimestamp(`Processed outline for paper ${paperIdStr}.`);
          } else if (batchJob.batch_type === "summary") {
            updatePayload = {
              generatedSummary: textContent,
              enhancedSummaryCreatedAt: new Date().toISOString(),
              embedding: null,
            };
            // Call embedding function with the correct UUID string ID
            const embedding = await createEmbeddingForPaper(
              paperIdStr,
              textContent
            );
            if (!embedding) {
              logWithTimestamp(
                `WARN: Processed summary but FAILED to generate embedding for paper ${paperIdStr}.`
              );
              embeddingSuccess = false;
              overallProcessingStatus = "processed_with_errors";
            } else {
              logWithTimestamp(
                `Processed summary and generated embedding for paper ${paperIdStr}.`
              );
            }
          } else {
            logWithTimestamp(
              `WARN: Unknown batch_type '${batchJob.batch_type}' for paper ${paperIdStr} in batch ${batchJob.batch_id}.`
            );
            batchErrorCount++;
            continue;
          }

          // Update the main paper table using the string UUID
          const { error: paperUpdateError } = await supabase
            .from(PAPERS_TABLE)
            .update({ ...updatePayload, lastUpdated: new Date().toISOString() })
            .eq("id", paperIdStr); // *** Use paperIdStr (UUID) here ***

          if (paperUpdateError) {
            // Log the specific UUID causing the error if possible
            logWithTimestamp(
              `ERROR updating paper ${paperIdStr} result from batch ${batchJob.batch_id}: ${paperUpdateError.message}`
            );
            batchErrorCount++;
            overallProcessingStatus = "processed_with_errors";
          } else {
            if (embeddingSuccess) batchSuccessCount++;
            else batchErrorCount++;
          }
        } else {
          // Handle failed result for this paper
          logWithTimestamp(
            `Result failed for paper ${paperIdStr} in batch ${
              batchJob.batch_id
            }. Type: ${result.result.type}, Error: ${
              result.result.error?.type || "N/A"
            }`
          );
          batchErrorCount++;
          overallProcessingStatus = "processed_with_errors";
          // Optionally mark paper as failed
        }
      } catch (paperProcessingError) {
        logWithTimestamp(
          `ERROR processing individual result for paper ${paperIdStr} in batch ${batchJob.batch_id}: ${paperProcessingError.message}`
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
    overallProcessingStatus = "failed";
    finalErrorMessage = `Result processing error: ${error.message}`.substring(
      0,
      1000
    );
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
        status: overallProcessingStatus, // This should now work if ENUM was altered
        processed_at: new Date().toISOString(),
        succeeded_count: batchSuccessCount,
        failed_count: batchErrorCount,
        error_message: finalErrorMessage,
      })
      .eq("batch_id", batchJob.batch_id);

    if (finalUpdateError) {
      // This might still fail if the ENUM wasn't updated in the DB
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
    const twentyFiveHoursAgo = new Date(
      Date.now() - 25 * 60 * 60 * 1000
    ).toISOString();
    const { data, error } = await supabase
      .from(BATCH_JOBS_TABLE)
      .select("*")
      .in("status", ["submitted", "polling", "completed"]) // Check jobs needing status check or processing
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
    isRunning = false;
    return;
  }

  if (jobsToCheck.length === 0) {
    logWithTimestamp("No pending batch jobs found in this cycle.");
    isRunning = false;
    return;
  }

  for (const job of jobsToCheck) {
    logWithTimestamp(
      `Checking batch ${job.batch_id} (Current DB status: ${job.status})...`
    );
    let currentBatchStatus;
    let jobProcessedInThisCycle = false;
    try {
      if (job.status !== "completed") {
        await supabase
          .from(BATCH_JOBS_TABLE)
          .update({
            status: "polling",
            last_polled_at: new Date().toISOString(),
          })
          .eq("batch_id", job.batch_id);
      }
      currentBatchStatus = await anthropic.messages.batches.retrieve(
        job.batch_id
      );
      const apiStatus = currentBatchStatus.processing_status;
      logWithTimestamp(`Batch ${job.batch_id} API Status: ${apiStatus}`);
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
        results_url: currentBatchStatus.results_url || job.results_url || null,
        completed_at: currentBatchStatus.ended_at || job.completed_at || null,
        error_message: job.error_message,
      };
      let nextStatus = job.status;
      if (apiStatus === "ended" || apiStatus === "completed") {
        // Set DB status to 'completed' only if it's not already in a final processed/failed state
        if (
          ![
            "processed",
            "processed_with_errors",
            "failed",
            "expired",
            "canceled",
          ].includes(job.status)
        ) {
          nextStatus = "completed";
        }
        if (!updatePayload.completed_at)
          updatePayload.completed_at = new Date().toISOString();
      } else if (
        apiStatus === "failed" ||
        apiStatus === "expired" ||
        apiStatus === "canceled"
      ) {
        nextStatus = apiStatus;
        if (!updatePayload.completed_at)
          updatePayload.completed_at = new Date().toISOString();
        if (!updatePayload.error_message)
          updatePayload.error_message = `Anthropic reported final status: ${apiStatus}`;
      } else if (apiStatus === "canceling") {
        nextStatus = "canceling";
      } else {
        // Still in_progress
        nextStatus = "polling";
      }
      updatePayload.status = nextStatus;

      const { error: statusUpdateError } = await supabase
        .from(BATCH_JOBS_TABLE)
        .update(updatePayload)
        .eq("batch_id", job.batch_id);
      if (statusUpdateError) {
        logWithTimestamp(
          `DB ERROR updating status for batch ${job.batch_id}: ${statusUpdateError.message}`
        );
        continue;
      }

      // If job status is now 'completed', process results
      if (updatePayload.status === "completed") {
        jobProcessedInThisCycle = true;
        // Mark as 'processing_results' BEFORE starting async processing
        await supabase
          .from(BATCH_JOBS_TABLE)
          .update({ status: "processing_results" })
          .eq("batch_id", job.batch_id);
        await processBatchResults({ ...job, ...updatePayload }); // Pass latest data
      }
    } catch (error) {
      logWithTimestamp(
        `ERROR polling/processing batch ${job.batch_id}: ${error.message}`
      );
      console.error(error);
      jobProcessedInThisCycle = true;
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
    if (!jobProcessedInThisCycle) {
      await delay(500);
    } // Small delay if not processing results
  } // end for loop

  isRunning = false; // Release lock
  const cycleDuration = (Date.now() - cycleStartTime) / 1000;
  logWithTimestamp(`Polling cycle finished in ${cycleDuration.toFixed(1)}s.`);
}

// --- Script Execution & Scheduling ---
logWithTimestamp(
  `Executing Poller/Processor Script: ${
    process.argv[1] || "poll-and-process-batches.js"
  }`
);
pollAndProcessBatches().catch((error) => {
  logWithTimestamp(
    `Unhandled error during initial poller run: ${error.message}`
  );
  console.error(error);
  isRunning = false;
});
const intervalId = setInterval(() => {
  pollAndProcessBatches().catch((error) => {
    logWithTimestamp(
      `Unhandled error during scheduled poller run: ${error.message}`
    );
    console.error(error);
    isRunning = false;
  });
}, POLLING_INTERVAL_MS);
logWithTimestamp(
  `Poller started. Will run every ${POLLING_INTERVAL_MS / 1000 / 60} minutes.`
);
const shutdown = () => {
  logWithTimestamp("Received shutdown signal. Stopping poller...");
  clearInterval(intervalId);
  logWithTimestamp("Poller stopped.");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- END OF FILE ---
