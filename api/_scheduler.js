import cron from "node-cron";
import { spawn } from "child_process";

let isScriptRunning = false;

const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] ${message}`);
};

const runScript = (scriptPath) => {
  return new Promise((resolve, reject) => {
    const script = spawn("node", [scriptPath]);

    script.stdout.on("data", (data) => {
      console.log(`[${scriptPath}] ${data.toString().trim()}`);
    });

    script.stderr.on("data", (data) => {
      console.error(`[${scriptPath}] ${data.toString().trim()}`);
    });

    script.on("close", (code) => {
      if (code === 0) {
        console.log(`[${scriptPath}] Script execution completed successfully.`);
        resolve();
      } else {
        console.error(
          `[${scriptPath}] Script execution failed with code ${code}.`
        );
        reject(new Error(`Script execution failed with code ${code}`));
      }
    });
  });
};

// Schedule the scripts to run every day at 6:05 AM
cron.schedule("05 06 * * *", async () => {
  if (isScriptRunning) {
    logWithTimestamp("Scripts are already running. Skipping execution.");
    return;
  }

  isScriptRunning = true;
  logWithTimestamp("Running scheduled scripts...");

  try {
    // -------------------------
    // Replicate update scripts
    // -------------------------
    await runScript("api/replicate/update-runs.js");
    await runScript("api/replicate/update-github-score.js");
    await runScript("api/replicate/fetch-new-models.js");
    await runScript("api/replicate/generate-tags.js");
    await runScript("api/replicate/create-embeddings.js");
    await runScript("api/replicate/generate-summary.js");

    // -------------------------
    // Arxiv scripts
    // -------------------------
    await runScript("api/arxiv/fetch-new-papers.js");
    await runScript("api/arxiv/clean-authors.js");
    await runScript("api/arxiv/create-embeddings.js");
    await runScript("api/arxiv/update-hn-score.js");
    await runScript("api/arxiv/update-reddit-score.js");
    await runScript("api/arxiv/update-twitter-score.js");
    // New: update Hugging Face score script
    await runScript("api/arxiv/update-huggingFace-score.js");
    await runScript("api/arxiv/generate-simple-summary.js");
    await runScript("api/arxiv/revalidate-papers.js"); // First revalidation for general summaries

    // -----------------------------------------------
    // Insert the three new calls right after generate-summary.js
    // -----------------------------------------------
    await runScript("api/arxiv/fetch-paper-graphics.js");
    await runScript("api/arxiv/fetch-paper-tables.js");
    await runScript("api/arxiv/publish-to-devto.js");
    // await runScript("api/arxiv/publish-to-hashnode.js"); -- Not doing this for now, keep reference tho
    // await runScript("api/arxiv/publish-to-reddit.js"); -- Not doing this for now, keep reference tho
    await runScript("api/arxiv/choose-paper-tasks.js");

    // -------------------------
    // Additional new scripts
    // -------------------------
    await runScript("api/twitter/publish-paper-greentext.js");
    await runScript("api/huggingFace/call-all-functions.js");
    await runScript("api/huggingFace/publish-to-devto.js");
    await runScript("api/loops/update-loops-contacts.js");
    await runScript("api/site/topic-modeling.js");
    await runScript("api/site/papers-of-the-week.js");
    await runScript("api/site/models-of-the-week.js");
    await runScript("api/twitter/publish-paper-tweet.js");
    await runScript("api/twitter/publish-model-tweet.js");
    await runScript("api/twitter/publish-reply-tweet.js");

    // ----------------------------------------
    // Clean and regenerate summaries (new step)
    // ----------------------------------------
    await runScript("api/replicate/clean-and-regenerate-summaries.js");
    await runScript("api/huggingFace/clean-and-regenerate-summaries.js");

    // --------------------------------------------------------
    // Finally, call the revalidation scripts for papers/models
    // --------------------------------------------------------
    await runScript("api/arxiv/revalidate-papers.js"); // Second revalidation catches big summaries
    await runScript("api/replicate/revalidate-models.js");

    logWithTimestamp("All scheduled scripts completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error running scheduled scripts: ${error}`);
  }

  isScriptRunning = false;
});

logWithTimestamp(
  "Scheduler script started. Scripts will run every day at 6:05 AM UTC if no scripts are running."
);
