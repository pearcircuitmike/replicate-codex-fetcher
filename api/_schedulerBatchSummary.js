import cron from "node-cron";
import { spawn } from "child_process";
import path from "path";
// *** START FIX for __dirname in ESM ***
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// *** END FIX ***

let isArxivScriptRunning = false; // Separate lock for this scheduler

const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  console.log(`[ArxivScheduler ${timestamp}] ${message}`);
};

// runScript function using corrected __dirname for path resolution
const runScript = (scriptPath) => {
  return new Promise((resolve, reject) => {
    // Resolve path relative to the current script directory (__dirname is the 'api' directory)
    const absoluteScriptPath = path.resolve(__dirname, scriptPath);
    logWithTimestamp(`Executing script: ${absoluteScriptPath}`);

    const script = spawn("node", [absoluteScriptPath], { stdio: "pipe" });

    let stdoutData = "";
    script.stdout.on("data", (data) => {
      stdoutData += data.toString();
      data
        .toString()
        .trim()
        .split("\n")
        .forEach((line) => {
          console.log(`[${path.basename(scriptPath)}] ${line}`);
        });
    });

    let stderrData = "";
    script.stderr.on("data", (data) => {
      stderrData += data.toString();
      data
        .toString()
        .trim()
        .split("\n")
        .forEach((line) => {
          console.error(`[${path.basename(scriptPath)}] ERROR: ${line}`);
        });
    });

    script.on("close", (code) => {
      if (code === 0) {
        logWithTimestamp(
          `[${path.basename(
            scriptPath
          )}] Script execution completed successfully.`
        );
        resolve();
      } else {
        logWithTimestamp(
          `[${path.basename(
            scriptPath
          )}] Script execution failed with code ${code}.`
        );
        reject(
          new Error(
            `[${path.basename(
              scriptPath
            )}] Script execution failed with code ${code}\nStderr: ${stderrData.trim()}`
          )
        );
      }
    });

    script.on("error", (err) => {
      logWithTimestamp(
        `[${path.basename(scriptPath)}] Failed to start script: ${err.message}`
      );
      reject(new Error(`Failed to start script ${scriptPath}: ${err.message}`));
    });
  });
};

// Helper function for delays
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Schedule the ArXiv scripts to run every day at 6:05 AM UTC
cron.schedule("05 06 * * *", async () => {
  if (isArxivScriptRunning) {
    logWithTimestamp(
      "ArXiv task scripts are already running. Skipping execution."
    );
    return;
  }

  isArxivScriptRunning = true;
  logWithTimestamp("Running scheduled ARXIV tasks...");

  try {
    // -------------------------
    // Arxiv scripts (Phase 1) - *** CORRECTED PATHS ***
    // -------------------------
    await runScript("arxiv/fetch-new-papers.js");
    await runScript("arxiv/clean-authors.js");
    await runScript("arxiv/create-embeddings.js");
    await runScript("arxiv/update-hn-score.js");
    await runScript("arxiv/update-reddit-score.js");
    await runScript("arxiv/update-twitter-score.js");
    await runScript("arxiv/update-huggingFace-score.js");
    await runScript("arxiv/generate-simple-summary.js");
    await runScript("arxiv/revalidate-papers.js");

    // -------------------------
    // Submit Outline Batch Job - *** CORRECTED PATH ***
    // -------------------------
    logWithTimestamp("Running outline submission script...");
    await runScript("arxiv/submit-outlines.js");
    logWithTimestamp("Outline submission script finished.");
    await runScript("arxiv/choose-paper-tasks.js");

    // -------------------------
    // Arxiv scripts (Phase 2) - *** CORRECTED PATHS ***
    // -------------------------
    await runScript("arxiv/fetch-paper-graphics.js");
    await runScript("arxiv/fetch-paper-tables.js");
    // await runScript("arxiv/publish-to-devto.js"); - comment this for now, it's not driving much traffic.

    // -------------------------
    // Wait for Outline Batch to Process - Delay 30 mins, totals almost 1 hour since prior script are very slow.
    // -------------------------
    const delayMinutes = 30;
    const delayMs = delayMinutes * 30 * 1000;
    logWithTimestamp(
      `Waiting for ${delayMinutes} minutes before submitting summaries...`
    );
    await delay(delayMs);
    logWithTimestamp("Delay finished. Running summary submission script...");

    // -------------------------
    // Submit Summary Batch Job - *** CORRECTED PATH ***
    // -------------------------
    await runScript("arxiv/submit-summaries.js");
    logWithTimestamp("Summary submission script finished.");

    logWithTimestamp("All scheduled ARXIV tasks completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error running scheduled ARXIV tasks: ${error}`);
    // console.error(error);
  } finally {
    isArxivScriptRunning = false;
    logWithTimestamp("ArXiv scheduler sequence finished, lock released.");
  }
});

logWithTimestamp(
  "ArXiv Scheduler script started. ArXiv tasks will run every day at 6:05 AM UTC."
);
