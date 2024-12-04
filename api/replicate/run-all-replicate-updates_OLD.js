import { fetchNewModels } from "./fetch-new-models.js";
import { generateTags } from "./generate-tags.js";
import { generateSummary } from "./generate-summary.js";
import { updateRuns } from "./update-runs.js";
import { createEmbeddings } from "./create-embeddings.js";
import { updateGithubScore } from "./update-github-score.js";

// Helper function to log messages with timestamps
function logWithTimestamp(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Execute a single operation with guaranteed completion
async function executeOperation(name, operation) {
  logWithTimestamp(`Starting ${name}...`);
  try {
    const result = await Promise.resolve(operation());
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Force 1 second delay between operations
    logWithTimestamp(`Completed ${name}.`);
    return result;
  } catch (error) {
    logWithTimestamp(`Failed ${name}: ${error.message}`);
    throw error;
  }
}

// Sequential execution of all updates
async function runAllUpdates() {
  try {
    logWithTimestamp("Starting runAllUpdates...");

    // Execute each operation in strict sequence
    await executeOperation("updateRuns", updateRuns);
    await executeOperation("updateGithubScore", updateGithubScore);
    await executeOperation("fetchNewModels", fetchNewModels);
    await executeOperation("generateTags", generateTags);
    await executeOperation("createEmbeddings", createEmbeddings);
    await executeOperation("generateSummary", generateSummary);

    logWithTimestamp("All updates completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error occurred: ${error.message}`);
    console.error(error);
    process.exit(1); // Exit with error code on failure
  }
}

// Run the updates
runAllUpdates();
