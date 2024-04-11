// test-script.js

const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
};

const logMessage = () => {
  logWithTimestamp("Test script has been run.");
};

logWithTimestamp("Test script started.");
logMessage();

let count = 0;
const intervalId = setInterval(() => {
  count++;
  logWithTimestamp(`Test script running... (${count}s)`);

  if (count === 120) {
    clearInterval(intervalId);
    logWithTimestamp("Test script finished.");
    process.exit(0);
  }
}, 1000);
