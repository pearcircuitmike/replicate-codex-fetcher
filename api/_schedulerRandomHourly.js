import cron from "node-cron";
import { spawn } from "child_process";

let isScriptRunning = false;
let nextRunTime = null;

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
          `[${scriptPath}] Script execution failed with code ${code}`
        );
        reject(new Error(`Script execution failed with code ${code}`));
      }
    });
  });
};

const scheduleNextRun = () => {
  const now = new Date();
  nextRunTime = new Date(now);

  if (nextRunTime.getMinutes() >= now.getMinutes()) {
    nextRunTime.setHours(nextRunTime.getHours() + 1);
  }

  nextRunTime.setMinutes(Math.floor(Math.random() * 60));
  nextRunTime.setSeconds(0);
  nextRunTime.setMilliseconds(0);

  const timeUntilNext = nextRunTime.getTime() - now.getTime();

  logWithTimestamp(
    `Next paper shitpost scheduled for: ${nextRunTime.toLocaleString()}`
  );

  setTimeout(async () => {
    if (isScriptRunning) {
      logWithTimestamp(
        "Shitpost script is already running. Skipping execution."
      );
      scheduleNextRun();
      return;
    }

    isScriptRunning = true;
    logWithTimestamp("Running paper shitpost script...");

    try {
      await runScript("api/twitter/publish-paper-shitpost.js");
      logWithTimestamp("Paper shitpost completed successfully.");
    } catch (error) {
      logWithTimestamp(`Error running paper shitpost: ${error}`);
    }

    isScriptRunning = false;
    scheduleNextRun();
  }, timeUntilNext);
};

logWithTimestamp("Random hourly paper shitpost scheduler started.");
scheduleNextRun();

process.on("SIGTERM", () => {
  logWithTimestamp("Received SIGTERM. Shutting down gracefully.");
  process.exit(0);
});

process.on("SIGINT", () => {
  logWithTimestamp("Received SIGINT. Shutting down gracefully.");
  process.exit(0);
});
