import { fetchNewModels } from "./fetch-new-models.js";
import { fetchTags } from "./fetch-tags.js";
import { fetchDescription } from "./fetch-description.js";
import { fetchDemoSources } from "./fetch-demo-sources.js";
import { generateSummary } from "./generate-summary.js";

async function main() {
  await fetchNewModels();
  await fetchTags();
  await fetchDescription();
  await fetchDemoSources();
  await generateSummary();
}

main().catch(console.error);
