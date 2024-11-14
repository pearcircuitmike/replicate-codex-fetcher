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

const SUBREDDITS = ["machinelearning", "machinelearningnews"];
//const SUBREDDITS = ["a:t5_7d0c95"];
const POST_DELAY = 600000;
let accessToken = null;

async function getAccessToken() {
  try {
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

    return response.data.access_token;
  } catch (error) {
    console.error("Error getting access token:", error);
    return null;
  }
}

async function generateRedditTitle(title, abstract) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Create a clear, professional title for an r/machinelearning post about this paper. The title should follow these rules:
- Start with "[R]" to indicate it's research
- Be concise but descriptive
- Focus on the key technical contribution or finding
- Use proper ML terminology
- Avoid clickbait or sensationalism
- Don't exceed 300 characters

Original title: ${title}
Abstract: ${abstract}

Respond with just the title - no explanation or extra text.`,
        },
      ],
    });

    return message.content[0].text.trim();
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
3. Explain theoretical or practical implications
4. End with a TLDR and links to paper/summary

Here is an example from another paper - just for illustration

<example>
I found an interesting analysis of Vision Transformers that reveals how they handle information processing through token recycling.

The key finding is that ViTs repurpose tokens from redundant image patches as temporary computational storage, leading to unintuitive attention patterns.

Technical details:
* ~2% of tokens exhibit abnormally high vector norms
* These "outlier" tokens correspond to less salient image regions
* The high-norm tokens store global rather than local information
* Adding dedicated register tokens provides explicit computational storage

Results:
* Models with register tokens show more interpretable attention maps
* Slight improvements in downstream task performance
* Significantly better object localization capabilities
* Minimal computational overhead from architecture modification

The implications for ViT architecture design suggest that explicit computational storage mechanisms could improve both performance and interpretability. This also provides insight into how transformer architectures manage information flow in vision tasks.

**TLDR:** Vision transformers repurpose background tokens for computation. Adding dedicated register tokens improves model behavior.

[Full summary is here](url). Paper [here](url).
</example>

Remember to:
- Keep technical accuracy while being accessible
- Use appropriate ML terminology
- Focus on methodology and results
- Only report results actually reported in the paper
- Only use bullet points, bold, italics, and links for formatting
- Write in first person as someone discussing the paper
- End with "[Full summary is here](url). Paper [here](url)."
- Never give any indication you are an LLM
- Don't give the impression you are the researcher
- Don't use words like fascinating, amazing, etc. - don't provide superlatives or hype. Be extremely matter-of-fact.

Respond with just the post content - no extra text or explanations.`,
        },
      ],
    });

    return message.content[0].text.trim();
  } catch (error) {
    console.error("Error generating Reddit post:", error);
    return null;
  }
}

async function submitRedditPost(subreddit, title, content, accessToken) {
  try {
    const response = await axios.post(
      "https://oauth.reddit.com/api/submit",
      {
        sr: subreddit,
        kind: "self",
        title: title,
        text: content,
        resubmit: false,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "aimodelsfyiscript by successful-western27",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `Error posting to r/${subreddit}:`,
      error.response?.data || error
    );
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishToReddit() {
  console.log("Starting Reddit publication process...");
  // Calculate date 3 days ago
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const threeDaysAgoISO = threeDaysAgo.toISOString();

  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .is("redditPublishedDate", null)
    .not("generatedSummary", "is", null)
    .gt("totalScore", 0.5)
    .gte("publishedDate", threeDaysAgoISO)
    .order("totalScore", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  if (papers.length === 0) {
    console.log("No new papers to publish.");
    return;
  }

  accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("Failed to get Reddit access token");
    return;
  }

  for (const paper of papers) {
    const summaryUrl = `https://aimodels.fyi/papers/arxiv/${paper.slug}`;

    // Generate a new ML-focused title
    const postTitle = await generateRedditTitle(paper.title, paper.abstract);
    if (!postTitle) {
      console.log(`Skipping paper ${paper.id} - couldn't generate title`);
      continue;
    }

    console.log(`Generating Reddit post for: ${postTitle}`);

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

    for (const subreddit of SUBREDDITS) {
      console.log(`Posting to r/${subreddit}...`);

      const result = await submitRedditPost(
        subreddit,
        postTitle,
        redditContent,
        accessToken
      );

      if (result) {
        console.log(`Successfully posted to r/${subreddit}`);

        const { error: updateError } = await supabase
          .from("arxivPapersData")
          .update({
            redditPublishedDate: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          })
          .eq("id", paper.id);

        if (updateError) {
          console.error("Error updating paper status:", updateError);
        }
      }

      await delay(60000);
    }

    await delay(POST_DELAY);
  }

  console.log("Finished publishing papers to Reddit");
}

async function main() {
  try {
    await publishToReddit();
  } catch (error) {
    console.error("Main process error:", error);
  }
}

main();
