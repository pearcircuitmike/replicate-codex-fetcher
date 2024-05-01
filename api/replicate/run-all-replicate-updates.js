import { fetchNewModels } from "./fetch-new-models.js";
import { generateTags } from "./generate-tags.js";
import { generateSummary } from "./generate-summary.js";
import { updateRuns } from "./update-replicate-score.js";
import { createEmbeddings } from "./create-embeddings.js";

async function runAllUpdates() {
  await fetchNewModels();
  await generateTags();
  await createEmbeddings();
  await generateSummary();
  await updateRuns();
}

runAllUpdates();
