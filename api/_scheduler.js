import cron from "node-cron";
import { spawn } from "child_process";
import path from "path";
// *** START FIX for __dirname in ESM ***
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// *** END FIX ***

let isScriptRunning = false;

const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  console.log(`[MainScheduler ${timestamp}] ${message}`);
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

// Schedule the scripts to run every day at 1:30 AM UTC
cron.schedule("30 01 * * *", async () => {
  if (isScriptRunning) {
    logWithTimestamp(
      "Main task scripts are already running. Skipping execution."
    );
    return;
  }

  isScriptRunning = true;
  logWithTimestamp("Running scheduled MAIN tasks...");

  try {
    // -------------------------
    // Replicate update scripts - *** CORRECTED PATHS ***
    // -------------------------
    await runScript("replicate/update-runs.js");
    await runScript("replicate/update-github-score.js");
    await runScript("replicate/fetch-new-models.js");
    await runScript("replicate/generate-tags.js");
    await runScript("replicate/create-embeddings.js");
    await runScript("replicate/generate-summary.js");
    await runScript("replicate/clean-and-regenerate-summaries.js");
    await runScript("replicate/revalidate-models.js");

    // -------------------------
    // Additional NON-ARXIV scripts - *** CORRECTED PATHS ***
    // -------------------------
    await runScript("twitter/publish-paper-greentext.js");
    await runScript("huggingFace/call-all-functions.js");
    await runScript("huggingFace/publish-to-devto.js");
    await runScript("huggingFace/clean-and-regenerate-summaries.js");
    await runScript("loops/update-loops-contacts.js");
    await runScript("site/topic-modeling.js");
    await runScript("site/papers-of-the-week.js");
    await runScript("site/models-of-the-week.js");
    await runScript("twitter/publish-paper-tweet.js");
    await runScript("twitter/publish-model-tweet.js");
    await runScript("twitter/publish-reply-tweet.js");

    logWithTimestamp("All scheduled MAIN tasks completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error running scheduled MAIN tasks: ${error}`);
    // console.error(error);
  } finally {
    isScriptRunning = false;
    logWithTimestamp("Main scheduler sequence finished, lock released.");
  }
});

logWithTimestamp(
  "Main Scheduler script started. Main tasks will run every day at 1:30 AM UTC."
);
