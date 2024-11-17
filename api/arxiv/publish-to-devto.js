import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const devToApiKey = process.env.DEVTO_API_KEY;
const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const MAX_TITLE_LENGTH = 128;
const MAX_PROMPT_LENGTH = 8000;
const MAX_TOKENS = 100;

async function generateTitle(summary, abstract, paper_title) {
  const inputText = summary || abstract;
  let truncatedText =
    inputText.length > MAX_PROMPT_LENGTH
      ? inputText.substring(0, MAX_PROMPT_LENGTH)
      : inputText;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: `Generate a concise, click-driving factual title for the following research paper summary. The title must be no longer than ${MAX_TITLE_LENGTH} characters and should not be enclosed in quotes. Never admit you are an AI or restate the prompt or make any mention of my instructions, just reply exactly with the title and nothing else:
         paper title: ${paper_title}
         paper: ${truncatedText}`,
        },
      ],
    });

    let generatedTitle = message.content[0].text.trim();
    return generatedTitle.length > MAX_TITLE_LENGTH
      ? generatedTitle.substring(0, MAX_TITLE_LENGTH)
      : generatedTitle;
  } catch (error) {
    console.error("Error generating title with Claude:", error);
    return null;
  }
}

async function publishArticleToDev(article) {
  const { id, title, generatedSummary, thumbnail, slug, abstract } = article;

  try {
    // Generate a new title using Claude
    const generatedTitle = await generateTitle(
      generatedSummary,
      abstract,
      title
    );
    const finalTitle = generatedTitle || title.substring(0, MAX_TITLE_LENGTH);

    const introMessage = `*This is a Plain English Papers summary of a research paper called [${finalTitle}](https://aimodels.fyi/papers/arxiv/${slug}). If you like these kinds of analysis, you should join [AImodels.fyi](https://aimodels.fyi) or follow us on [Twitter](https://x.com/aimodelsfyi).*\n\n`;

    // Find the start of the Plain English Explanation section using case-insensitive search
    const summaryStartIndex = generatedSummary
      .toLowerCase()
      .indexOf("## plain english explanation");
    let truncatedSummary = generatedSummary;

    if (summaryStartIndex !== -1) {
      const contentStartIndex =
        summaryStartIndex + "## Plain English Explanation".length;
      truncatedSummary =
        generatedSummary.substring(0, contentStartIndex + 280) + "...";
    }

    const articleUrl = `https://aimodels.fyi/papers/arxiv/${slug}`;
    const outroMessage = `\n\n[Click here to read the full summary of this paper](${articleUrl})`;

    const modifiedSummary = introMessage + truncatedSummary + outroMessage;

    const payload = {
      article: {
        title: finalTitle,
        body_markdown: modifiedSummary,
        published: true,
        main_image: thumbnail,
        canonical_url: articleUrl,
        description: finalTitle,
        tags: ["machinelearning", "ai", "programming", "datascience"],
      },
    };

    const response = await axios.post("https://dev.to/api/articles", payload, {
      headers: {
        "api-key": devToApiKey,
        "Content-Type": "application/json",
      },
    });

    console.log(`Article "${finalTitle}" published to DEV.to`);

    // Update the devToPublishedDate column in the database
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ devToPublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating devToPublishedDate for article "${finalTitle}":`,
        updateError
      );
    }

    return true; // Indicate success
  } catch (error) {
    console.error(`Error processing article "${title}":`, error);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    return false; // Indicate failure
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
    const success = await publishArticleToDev(article);
    if (success) {
      console.log(`Successfully processed article: ${article.title}`);
    } else {
      console.log(`Failed to process article: ${article.title}`);
    }
    await delay(rateLimitDelay);
  }

  console.log("Finished processing all articles");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

publishArticlesToDev().catch((error) => {
  console.error("An error occurred in the main process:", error);
});
