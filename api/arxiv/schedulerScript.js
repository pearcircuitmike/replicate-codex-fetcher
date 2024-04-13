// schedulerScript.js
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

// Schedule the scripts to run Monday, Tuesday, Wednesday, Thursday, and Friday at 8am Eastern Time
cron.schedule("04 8 * * 1-5", async () => {
  if (isScriptRunning) {
    logWithTimestamp("Scripts are already running. Skipping execution.");
    return;
  }

  isScriptRunning = true;
  logWithTimestamp("Running scripts...");

  try {
    await runScript("api/arxiv/fetch-new-papers.js");
    await runScript("api/arxiv/create-embeddings.js");
    await runScript("api/arxiv/update-hn-score.js");
    await runScript("api/arxiv/update-reddit-score.js");
    await runScript("api/arxiv/generate-summary.js");
  } catch (error) {
    logWithTimestamp(`Error running scripts: ${error}`);
  }

  isScriptRunning = false;
});

logWithTimestamp(
  "Scheduler script started. Scripts will run Monday, Tuesday, Wednesday, Thursday, and Friday at 130am Eastern Time if no scripts are running."
);
