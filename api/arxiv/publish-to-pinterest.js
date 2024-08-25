import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

// Pinterest API credentials
const PINTEREST_SECRET_KEY = process.env.PINTEREST_SECRET_KEY;
const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
const PINTEREST_APP_ID = process.env.PINTEREST_APP_ID;

// Supabase and Claude credentials
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

// Log the keys for debugging
console.log("PINTEREST_SECRET_KEY:", PINTEREST_SECRET_KEY);
console.log("PINTEREST_ACCESS_TOKEN:", PINTEREST_ACCESS_TOKEN);
console.log("PINTEREST_APP_ID:", PINTEREST_APP_ID);
console.log("SUPABASE_URL:", supabaseUrl);
console.log("SUPABASE_SERVICE_KEY:", supabaseKey);
console.log("CLAUDE_API_KEY:", claudeApiKey);

// Constants
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PROMPT_LENGTH = 8000;
const MAX_TOKENS = 100;
const RATE_LIMIT_DELAY = 5000; // 5 seconds between API calls
const PINTEREST_SANDBOX_API_URL = "https://api-sandbox.pinterest.com/v5";

async function checkTokenValidity() {
  try {
    console.log("Checking sandbox token validity...");
    const response = await axios.get(
      `${PINTEREST_SANDBOX_API_URL}/user_account`,
      {
        headers: {
          Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
        },
      }
    );
    console.log("Sandbox token is valid. User account info:", response.data);
    return true;
  } catch (error) {
    console.error("Error checking sandbox token validity:");
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
      console.error("Headers:", error.response.headers);
    }
    console.error("Full error:", error);
    return false;
  }
}

async function verifyBoardAccess() {
  try {
    console.log(`Verifying access to sandbox board ${PINTEREST_APP_ID}...`);
    const response = await axios.get(
      `${PINTEREST_SANDBOX_API_URL}/boards/${PINTEREST_APP_ID}`,
      {
        headers: {
          Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
        },
      }
    );
    console.log("Sandbox board access verified. Board info:", response.data);
    return true;
  } catch (error) {
    console.error("Error verifying sandbox board access:");
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
      console.error("Headers:", error.response.headers);
    }
    console.error("Full error:", error);
    return false;
  }
}

async function generatePinTitle(summary, abstract, originalTitle) {
  // Implement the logic to generate a Pin title
  // You can use anthropic API here
}

async function generatePinDescription(summary, abstract) {
  // Implement the logic to generate a Pin description
  // You can use anthropic API here
}

async function publishPinToPinterest(article) {
  const { id, title, generatedSummary, thumbnail, slug, abstract } = article;

  try {
    const generatedTitle = await generatePinTitle(
      generatedSummary,
      abstract,
      title
    );
    const generatedDescription = await generatePinDescription(
      generatedSummary,
      abstract
    );

    const finalTitle = generatedTitle || title.substring(0, MAX_TITLE_LENGTH);
    const finalDescription =
      generatedDescription ||
      generatedSummary.substring(0, MAX_DESCRIPTION_LENGTH);

    const payload = {
      board_id: PINTEREST_APP_ID,
      media_source: {
        source_type: "image_url",
        url: thumbnail,
      },
      title: finalTitle,
      description: finalDescription,
      link: `https://aimodels.fyi/papers/arxiv/${slug}`,
      alt_text: finalTitle,
    };

    console.log("Sending request to Pinterest Sandbox API...");
    console.log("Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${PINTEREST_SANDBOX_API_URL}/pins`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${PINTEREST_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Pinterest Sandbox API Response:", response.data);
    console.log(`Pin "${finalTitle}" published to Pinterest Sandbox`);

    await supabase
      .from("arxivPapersData")
      .update({ pinterestPublishedDate: new Date().toISOString() })
      .eq("id", id);

    return true;
  } catch (error) {
    console.error(`Error processing article "${title}":`);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
      console.error("Headers:", error.response.headers);
    }
    console.error("Full error:", error);
    return false;
  }
}

async function publishArticlesToPinterest() {
  const isTokenValid = await checkTokenValidity();
  if (!isTokenValid) {
    console.error(
      "Sandbox token validation failed. Please check your token and try again."
    );
    console.log(
      "Make sure you've generated a new sandbox token and updated your .env file."
    );
    return;
  }

  const hasBoardAccess = await verifyBoardAccess();
  if (!hasBoardAccess) {
    console.error(
      "Sandbox board access verification failed. Please check your board ID and permissions."
    );
    console.log(
      "Ensure you're using a valid sandbox board ID in your .env file."
    );
    return;
  }

  const { data: articles, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .not("generatedSummary", "is", null)
    .is("pinterestPublishedDate", null)
    .gt("totalScore", 0.5)
    .limit(10);

  if (error) {
    console.error("Error fetching articles:", error);
    return;
  }

  for (const article of articles) {
    const success = await publishPinToPinterest(article);
    if (success) {
      console.log(`Successfully processed article: ${article.title}`);
    } else {
      console.log(`Failed to process article: ${article.title}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
  }

  console.log("Finished processing articles");
}

publishArticlesToPinterest().catch((error) => {
  console.error("An error occurred in the main process:", error);
});
