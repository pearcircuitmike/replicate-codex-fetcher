import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const devToApiKey = process.env.DEVTO_API_KEY;

async function publishArticleToDev(article) {
  const { id, title, generatedSummary, thumbnail, slug } = article;

  const introMessage = `*This is a Plain English Papers summary of a research paper called [${title}](https://aimodels.fyi/papers/arxiv/${slug}). If you like these kinds of analysis, you should subscribe to the [AImodels.fyi newsletter](https://aimodels.substack.com) or follow me on [Twitter](https://twitter.com/mikeyoung44).*\n\n`;
  const outroMessage = `\n\n**If you enjoyed this summary, consider subscribing to the [AImodels.fyi newsletter](https://aimodels.substack.com) or following me on [Twitter](https://twitter.com/mikeyoung44) for more AI and machine learning content.**`;

  const modifiedSummary = introMessage + generatedSummary + outroMessage;

  const payload = {
    article: {
      title,
      body_markdown: modifiedSummary,
      published: true,
      main_image: thumbnail,
      canonical_url: `https://aimodels.fyi/papers/arxiv/${slug}`,
      description: title,
      tags: ["machinelearning, ai, beginners, datascience"],
    },
  };

  try {
    const response = await axios.post("https://dev.to/api/articles", payload, {
      headers: {
        "api-key": devToApiKey,
        "Content-Type": "application/json",
      },
    });

    console.log(`Article "${title}" published to DEV.to`);

    // Update the devToPublishedDate column in the database
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ devToPublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating devToPublishedDate for article "${title}":`,
        updateError
      );
    }
  } catch (error) {
    console.error(`Error publishing article "${title}" to DEV.to:`, error);
  }
}

async function publishArticlesToDev() {
  const { data: articles, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .not("generatedSummary", "is", null)
    .is("devToPublishedDate", null)
    .gt("totalScore", 0.5);

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
