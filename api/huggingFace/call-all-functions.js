import { fetchNewModels } from "./fetch-new-models.js";
import { fetchDescription } from "./fetch-description.js";
import { generateSummary } from "./generate-summary.js";
import { createEmbeddings } from "./create-embeddings.js";
import { updateLikes } from "./update-huggingFace-score.js";
import { generateTags } from "./generate-tags.js"; // Import the generateTags function

async function main() {
  await updateLikes();
  await fetchNewModels();
  await fetchDescription();
  await generateTags();
  await createEmbeddings();
  await generateSummary();
}

main().catch(console.error);
