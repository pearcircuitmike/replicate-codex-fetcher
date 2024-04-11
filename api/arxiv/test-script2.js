// test-script2.js

const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
};

const logMessage = () => {
  logWithTimestamp("Test script 2 has been run.");
};

logWithTimestamp("Test script 2 started.");
logMessage();

let count = 0;
const intervalId = setInterval(() => {
  count++;
  logWithTimestamp(`Test script 2 running... (${count}s)`);

  if (count === 30) {
    clearInterval(intervalId);
    logWithTimestamp("Test script 2 finished.");
    process.exit(0);
  }
}, 1000);
