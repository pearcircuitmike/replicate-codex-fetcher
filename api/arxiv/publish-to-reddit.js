import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const clientId = process.env.REDDIT_CLIENT_ID;
const clientSecret = process.env.REDDIT_CLIENT_SECRET;
const username = process.env.REDDIT_USERNAME;
const password = process.env.REDDIT_PASSWORD;

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

// Subreddit-specific configurations
const SUBREDDIT_CONFIG = {
  machinelearning: {
    prependTag: true,
    requiresFlair: false,
    flairText: null,
  },
  ArtificialInteligence: {
    prependTag: false,
    requiresFlair: true,
    flairText: "Technical",
  },
  artificial: {
    prependTag: false,
    requiresFlair: true,
    flairText: "Computing",
  },
  neuralnetworks: {
    prependTag: false,
    requiresFlair: false,
    flairText: null,
  },
  ResearchML: {
    prependTag: false,
    requiresFlair: false,
    flairText: null,
  },
};

const SUBREDDITS = Object.keys(SUBREDDIT_CONFIG);
const POST_DELAY = 600000;
let accessToken = null;
let subredditFlairs = {};

async function getAccessToken() {
  try {
    console.log("Attempting to get Reddit access token...");
    const response = await axios.post(
      "https://www.reddit.com/api/v1/access_token",
      `grant_type=password&username=${username}&password=${password}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${clientId}:${clientSecret}`
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("Successfully obtained access token");
    return response.data.access_token;
  } catch (error) {
    console.error("Error getting access token:");
    if (error.response) {
      console.error("Error Status:", error.response.status);
      console.error("Error Data:", error.response.data);
    } else {
      console.error(error);
    }
    return null;
  }
}

async function getSubredditFlairs(subreddit, accessToken) {
  try {
    if (!SUBREDDIT_CONFIG[subreddit].requiresFlair) {
      return null;
    }

    console.log(`Fetching flairs for r/${subreddit}...`);

    const response = await axios.get(
      `https://oauth.reddit.com/r/${subreddit}/api/link_flair_v2`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "aimodelsfyiscript by successful-western27",
        },
      }
    );

    console.log(`Available flairs for r/${subreddit}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Error fetching flairs for r/${subreddit}:`, error);
    return null;
  }
}

async function initializeFlairs(accessToken) {
  for (const subreddit of SUBREDDITS) {
    if (SUBREDDIT_CONFIG[subreddit].requiresFlair) {
      const flairs = await getSubredditFlairs(subreddit, accessToken);
      if (flairs) {
        const requiredFlair = flairs.find(
          (flair) => flair.text === SUBREDDIT_CONFIG[subreddit].flairText
        );
        if (requiredFlair) {
          subredditFlairs[subreddit] = requiredFlair.id;
          console.log(`Found flair ID for r/${subreddit}: ${requiredFlair.id}`);
        } else {
          console.error(
            `Could not find "${SUBREDDIT_CONFIG[subreddit].flairText}" flair for r/${subreddit}`
          );
        }
      }
    }
  }
}

async function generateRedditTitle(title, abstract) {
  try {
    console.log("Generating Reddit title...");
    console.log("Original title:", title);

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Create a clear, professional title for an ML research post about this paper. The title should follow these rules:
- Be concise but descriptive
- Focus on the key technical contribution or finding
- Use proper ML terminology
- Avoid clickbait or sensationalism
- Don't exceed 300 characters
- DO NOT include [R] tag - this will be added later if needed

Original title: ${title}
Abstract: ${abstract}

Respond with just the title - no explanation or extra text.`,
        },
      ],
    });

    const generatedTitle = message.content[0].text.trim();
    console.log("Generated title:", generatedTitle);
    return generatedTitle;
  } catch (error) {
    console.error("Error generating Reddit title:", error);
    return null;
  }
}

async function generateRedditPost(
  summary,
  abstract,
  title,
  paperUrl,
  summaryUrl
) {
  try {
    console.log("Generating Reddit post content...");

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `Now summarize the article for r/machinelearning in this format (note that I write in first person, 
          technical but accessible, like a high-quality ML paper discussion). 
          Use only basic markdown: bullet points, bold (**), italics (*), and links.

Title: ${title}

Summary/Abstract: ${summary || abstract}

Paper URL: ${paperUrl}
Summary URL: ${summaryUrl}

Write a post that follows this structure:
1. Start with the key technical contribution/methodology
2. Break down the main technical points and results using bullet points
3. Explain what the impact could be using "I think..." language. Don't say 'the implications are significant, substantial'
4. End with a TLDR and links to paper/summary

Remember to:
- Keep technical accuracy while being accessible
- Use appropriate ML terminology
- Focus on methodology and results
- Only report results actually reported in the paper
- Only use bullet points, bold, italics, and links for formatting
- Write in first person as someone discussing the paper
- End with "[Full summary is here](summaryURL). Paper [here](paperUrl)."
- Never give any indication you are an LLM
- Don't give the impression you are the researcher
- Don't write the paper title title
- Don't use words like fascinating, amazing, etc. - don't provide superlatives or hype. Be extremely matter-of-fact.

Respond with just the post content - no extra text or explanations.`,
        },
      ],
    });

    const generatedContent = message.content[0].text.trim();
    console.log("Generated content length:", generatedContent.length);
    return generatedContent;
  } catch (error) {
    console.error("Error generating Reddit post:", error);
    return null;
  }
}

async function submitRedditPost(subreddit, baseTitle, content, accessToken) {
  try {
    console.log(`\nAttempting to post to r/${subreddit}`);

    // Apply subreddit-specific title formatting
    const config = SUBREDDIT_CONFIG[subreddit];
    const title = config.prependTag ? `[R] ${baseTitle}` : baseTitle;

    console.log("Final title:", title);
    console.log("Content length:", content.length);

    // Prepare the post data
    const postData = {
      sr: subreddit,
      kind: "self",
      title: title,
      text: content,
      resubmit: false,
    };

    // Add flair if required
    if (config.requiresFlair && subredditFlairs[subreddit]) {
      postData.flair_id = subredditFlairs[subreddit];
      console.log(`Adding flair ID: ${subredditFlairs[subreddit]}`);
    }

    const response = await axios.post(
      "https://oauth.reddit.com/api/submit",
      postData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "aimodelsfyiscript by successful-western27",
        },
      }
    );

    // Log the full response
    console.log("\nReddit API Response:", {
      status: response.status,
      statusText: response.statusText,
      data: JSON.stringify(response.data, null, 2),
      headers: response.headers,
    });

    // Check for errors in response
    if (
      response.data.json &&
      response.data.json.errors &&
      response.data.json.errors.length > 0
    ) {
      console.error("Reddit API returned errors:", response.data.json.errors);
      return null;
    }

    // Log the post URL if available
    if (response.data.json && response.data.json.data) {
      const postUrl = `https://reddit.com${response.data.json.data.url}`;
      console.log("Post successful! URL:", postUrl);
    }

    return response.data;
  } catch (error) {
    console.error(`Error posting to r/${subreddit}:`);
    if (error.response) {
      console.error("Error Status:", error.response.status);
      console.error("Error Headers:", error.response.headers);
      console.error("Error Data:", error.response.data);
    } else if (error.request) {
      console.error("Request Error:", error.request);
    } else {
      console.error("Error:", error.message);
    }
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishToReddit() {
  console.log("Starting Reddit publication process...");
  console.log("Current time:", new Date().toISOString());

  // Get access token first
  accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("Failed to get Reddit access token");
    return;
  }
  console.log("Successfully obtained Reddit access token");

  // Initialize flairs for all subreddits
  await initializeFlairs(accessToken);

  // Calculate date 3 days ago
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const threeDaysAgoISO = threeDaysAgo.toISOString();

  // Get papers for each subreddit
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .is("redditPublishedDate", null)
    .not("generatedSummary", "is", null)
    .gt("totalScore", 0.5)
    .gte("indexedDate", threeDaysAgoISO)
    .order("totalScore", { ascending: false })
    .limit(SUBREDDITS.length); // Get exactly enough papers for our subreddits

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  if (papers.length === 0) {
    console.log("No new papers to publish.");
    return;
  }

  // Post one paper to each subreddit
  for (let i = 0; i < SUBREDDITS.length; i++) {
    const subreddit = SUBREDDITS[i];
    const paper = papers[i];

    if (!paper) {
      console.log(`No paper available for r/${subreddit}, skipping...`);
      continue;
    }

    console.log(`\nProcessing paper for r/${subreddit}`);
    console.log("Paper ID:", paper.id);
    console.log("Original title:", paper.title);
    console.log("Score:", paper.totalScore);

    const summaryUrl = `https://aimodels.fyi/papers/arxiv/${paper.slug}`;

    const baseTitle = await generateRedditTitle(paper.title, paper.abstract);
    if (!baseTitle) {
      console.log(`Skipping paper ${paper.id} - couldn't generate title`);
      continue;
    }

    const redditContent = await generateRedditPost(
      paper.generatedSummary,
      paper.abstract,
      paper.title,
      paper.paperUrl,
      summaryUrl
    );

    if (!redditContent) {
      console.log(`Skipping paper ${paper.id} - couldn't generate content`);
      continue;
    }

    if (
      SUBREDDIT_CONFIG[subreddit].requiresFlair &&
      !subredditFlairs[subreddit]
    ) {
      console.log(`Skipping r/${subreddit} - required flair not found`);
      continue;
    }

    const result = await submitRedditPost(
      subreddit,
      baseTitle,
      redditContent,
      accessToken
    );

    if (result) {
      console.log(`Successfully posted to r/${subreddit}`);
      console.log("Updating database...");

      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({
          redditPublishedDate: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        })
        .eq("id", paper.id);

      if (updateError) {
        console.error("Error updating paper status:", updateError);
      } else {
        console.log("Database updated successfully");
      }
    } else {
      console.log(`Failed to post to r/${subreddit}`);
    }

    // Wait between posts if this isn't the last subreddit
    if (i < SUBREDDITS.length - 1) {
      console.log("Waiting 180 seconds before next post...");
      await delay(180000);
    }
  }

  console.log("\nFinished publishing papers to Reddit");
}

async function main() {
  try {
    await publishToReddit();
  } catch (error) {
    console.error("Main process error:", error);
    console.error("Stack trace:", error.stack);
  }
}

main();
