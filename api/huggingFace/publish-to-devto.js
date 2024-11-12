import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const devToApiKey = process.env.DEVTO_API_KEY;

function toTitleCase(str) {
  return str.replace(
    /\b\w+/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

async function publishArticleToDev(article) {
  const { id, modelName, creator, generatedSummary, example, platform, slug } =
    article;

  const titleModelName = toTitleCase(modelName);
  const titlePlatform = toTitleCase(platform);
  const titleCreator = toTitleCase(creator);

  const introMessage = `*This is a simplified guide to an AI model called [${titleModelName}](https://aimodels.fyi/models/${platform}/${slug}) maintained by [${titleCreator}](https://aimodels.fyi/creators/${platform}/${creator}). If you like these kinds of analysis, you should join [AImodels.fyi](https://aimodels.fyi) or follow us on [Twitter](https://x.com/aimodelsfyi).*\n\n`;

  // Find the start of the Capabilities section using case-insensitive search
  const summaryStartIndex = generatedSummary
    .toLowerCase()
    .indexOf("## capabilities");
  let truncatedSummary = generatedSummary;

  if (summaryStartIndex !== -1) {
    truncatedSummary =
      generatedSummary.substring(
        0,
        summaryStartIndex + "## Capabilities".length + 40
      ) + "...";
  }

  const articleUrl = `https://aimodels.fyi/models/${platform}/${slug}`;
  const outroMessage = `\n\n[Click here to read the full guide to ${titleModelName}](${articleUrl})`;

  const modifiedSummary = introMessage + truncatedSummary + outroMessage;

  const payload = {
    article: {
      title: `A beginner's guide to the ${titleModelName} model by ${titleCreator} on ${titlePlatform}`,
      body_markdown: modifiedSummary,
      published: true,
      main_image: example,
      canonical_url: articleUrl,
      description: modelName,
      tags: ["coding", "ai", "machinelearning", "programming"],
    },
  };

  try {
    const response = await axios.post("https://dev.to/api/articles", payload, {
      headers: {
        "api-key": devToApiKey,
        "Content-Type": "application/json",
      },
    });

    console.log(`Article "${modelName}" published to DEV.to`);

    // Update the devToPublishedDate column in the database
    const { error: updateError } = await supabase
      .from("modelsData")
      .update({ devToPublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating devToPublishedDate for article "${modelName}":`,
        updateError
      );
    }
  } catch (error) {
    console.error(`Error publishing article "${modelName}" to DEV.to:`, error);
  }
}

async function publishArticlesToDev() {
  const { data: articles, error } = await supabase
    .from("modelsData")
    .select("*")
    .not("generatedSummary", "is", null)
    .is("devToPublishedDate", null)
    .gt("totalScore", 5000);

  if (error) {
    console.error("Error fetching articles:", error);
    return;
  }

  const rateLimitDelay = 33000; // Delay of 33 seconds between each post (10% safety margin)

  for (const article of articles) {
    await publishArticleToDev(article);
    await delay(rateLimitDelay);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

publishArticlesToDev();
