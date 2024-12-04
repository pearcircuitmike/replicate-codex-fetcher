import { fetchNewModels } from "./fetch-new-models.js";
import { generateTags } from "./generate-tags.js";
import { generateSummary } from "./generate-summary.js";
import { updateRuns } from "./update-replicate-score.js";
import { createEmbeddings } from "./create-embeddings.js";
import { updateGithubScore } from "./update-github-score.js";

// Helper function to log messages with timestamps
function logWithTimestamp(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Wrap each function call with logging
async function runAllUpdates() {
  try {
    logWithTimestamp("Starting runAllUpdates...");

    logWithTimestamp("Starting updateRuns...");
    await updateRuns();
    logWithTimestamp("Completed updateRuns.");

    logWithTimestamp("Starting updateGithubScore...");
    await updateGithubScore();
    logWithTimestamp("Completed updateGithubScore.");

    logWithTimestamp("Starting fetchNewModels...");
    await fetchNewModels();
    logWithTimestamp("Completed fetchNewModels.");

    logWithTimestamp("Starting generateTags...");
    await generateTags();
    logWithTimestamp("Completed generateTags.");

    logWithTimestamp("Starting createEmbeddings...");
    await createEmbeddings();
    logWithTimestamp("Completed createEmbeddings.");

    logWithTimestamp("Starting generateSummary...");
    await generateSummary();
    logWithTimestamp("Completed generateSummary.");

    logWithTimestamp("All updates completed successfully.");
  } catch (error) {
    logWithTimestamp(`Error occurred: ${error.message}`);
    console.error(error); // Log the full error stack for debugging
  }
}

runAllUpdates();
