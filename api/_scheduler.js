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
cron.schedule("35 1 * * *", async () => {
  if (isScriptRunning) {
    logWithTimestamp("Scripts are already running. Skipping execution.");
    return;
  }

  isScriptRunning = true;
  logWithTimestamp("Running scheduled scripts...");

  try {
    // Replicate update scripts
    await runScript("api/replicate/update-runs.js");
    await runScript("api/replicate/update-github-score.js");
    await runScript("api/replicate/fetch-new-models.js");
    await runScript("api/replicate/generate-tags.js");
    await runScript("api/replicate/create-embeddings.js");
    await runScript("api/replicate/generate-summary.js");

    // Original scripts
    await runScript("api/arxiv/fetch-new-papers.js");
    await runScript("api/arxiv/create-embeddings.js");
    await runScript("api/arxiv/update-hn-score.js");
    await runScript("api/arxiv/update-reddit-score.js");
    await runScript("api/arxiv/update-twitter-score.js");
    await runScript("api/arxiv/generate-summary.js");
    await runScript("api/arxiv/publish-to-devto.js");
    await runScript("api/arxiv/publish-to-hashnode.js");
    await runScript("api/arxiv/choose-paper-tasks.js");

    // New scripts
    await runScript("api/twitter/publish-paper-greentext.js");

    await runScript("api/huggingFace/call-all-functions.js");
    await runScript("api/huggingFace/publish-to-devto.js");
    await runScript("api/loops/update-loops-contacts.js");
    await runScript("api/site/topic-modeling.js");
    await runScript("api/site/papers-of-the-week.js");
    await runScript("api/site/models-of-the-week.js");
    await runScript("api/twitter/publish-paper-tweet.js");
    await runScript("api/twitter/publish-model-tweet.js");

    logWithTimestamp("All scheduled scripts completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error running scheduled scripts: ${error}`);
  }

  isScriptRunning = false;
});

logWithTimestamp(
  "Scheduler script started. Scripts will run every day at 6:05 AM UTC if no scripts are running."
);
