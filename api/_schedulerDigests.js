import cron from "node-cron";
import { spawn } from "child_process";

// Prevent overlapping runs
let isRunning = false;

// Helper: spawn a Node script and pipe output
function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], { stdio: "pipe" });

    child.stdout.on("data", (data) => {
      process.stdout.write(`[${scriptPath}] ${data}`);
    });
    child.stderr.on("data", (data) => {
      process.stderr.write(`[${scriptPath}] ${data}`);
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[${scriptPath}] completed successfully.`);
        resolve();
      } else {
        console.error(`[${scriptPath}] exited with code ${code}`);
        reject(new Error(`Script failed with code ${code}`));
      }
    });
  });
}

// Run daily + weekly scripts in sequence
async function runAllDigests() {
  if (isRunning) {
    console.log("Digests are already running. Skipping this run.");
    return;
  }
  isRunning = true;

  console.log("Starting daily + weekly digests...");
  try {
    // 1) Daily script
    await runScript("resend/dailyDigest.js");

    // 2) Weekly script
    await runScript("resend/weeklyDigest.js");

    console.log("All digest scripts finished.");
  } catch (err) {
    console.error("Error while running digest scripts:", err);
  } finally {
    isRunning = false;
  }
}

// Schedule: run each day at 13:45 UTC (8:45 AM ET in Standard Time)
cron.schedule("45 13 * * *", () => {
  console.log("13:45 UTC reached. Starting daily + weekly digests...");
  runAllDigests();
});

// Initial log
console.log(
  "Digest scheduler started (/_schedulerDigests.js). Will run daily + weekly at 13:45 UTC."
);
