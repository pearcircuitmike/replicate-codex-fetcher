import { fetchNewModels } from "./fetch-new-models.js";
import { fetchTags } from "./fetch-tags.js";
import { fetchDescription } from "./fetch-description.js";
import { fetchDemoSources } from "./fetch-demo-sources.js";
import { generateSummary } from "./generate-summary.js";
import { createEmbeddings } from "../replicate/create-embeddings.js";

async function main() {
  await fetchNewModels();
  await fetchDescription();
  await createEmbeddings();
  await generateTags();
  await generateSummary();
  (await update) - huggingFace - score.js;
}

main().catch(console.error);
