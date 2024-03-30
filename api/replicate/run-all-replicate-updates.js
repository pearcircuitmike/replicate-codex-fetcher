import { fetchNewModels } from "./fetch-new-models.js";
import { generateTags } from "./generate-tags.js";
import { generateSummary } from "./generate-summary.js";
import { generateUseCase } from "./generate-use-case.js";
import { updateRuns } from "./update-runs.js";
import { createEmbeddings } from "./create-embeddings.js";

async function runAllUpdates() {
  await fetchNewModels();
  await generateTags();
  await generateSummary();
  await generateUseCase();
  await updateRuns();
  await createEmbeddings();
}

runAllUpdates();
