import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function generateShitpost(summary, abstract, title, slug) {
  const maxTokens = 1000;
  const promptPercentage = 0.8;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);

  // Twitter counts all URLs (regardless of length) as 23 characters
  // Plus we have two newlines (2 chars) before the URL
  const urlLength = 25;
  const suffix = `\n\nhttps://aimodels.fyi/papers/arxiv/${slug}`;
  const maxContentLength = 280 - urlLength;

  try {
    const inputText = `Title: ${title}\n\n${summary || abstract}`;
    let truncatedText = inputText;
    if (inputText.length > maxPromptLength) {
      truncatedText = inputText.substring(0, maxPromptLength);
    }

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `You run a tech/ML account that comments on AI research papers with a mix of 
          genuine insight and playful commentary. Your tone is authentic, clever, 
          and occasionally irreverent - but never forced or "trying too hard to be funny." 
         

write 2 positive controversial statements about this paper
related to its main topic. statements can only be 10 words long.

Rules:
- Do not use quotation marks in your response
- Keep it UNDER ${
            maxContentLength - 20
          } characters (this is crucial - the tweet will be cut off if too long)
- No hashtags
- Write the tweet directly without any extra text
- Must be complete sentences/thoughts - nothing cut off

Here's the paper to comment on:

${truncatedText}

Respond with just the tweet text - no quotes, no explanation, no extra text.`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let tweetText = message.content[0].text.trim();
      // Remove any quotation marks that might have been added
      tweetText = tweetText.replace(/['"]/g, "");

      // If still too long, truncate with a clean cutoff
      if (tweetText.length > maxContentLength) {
        // Find the last space before the limit
        const lastSpace = tweetText.lastIndexOf(" ", maxContentLength - 4);
        tweetText = tweetText.substring(0, lastSpace) + "...";
      }

      tweetText = `${tweetText}${suffix}`;
      console.log("Tweet generated:", tweetText);
      return tweetText;
    } else {
      console.log("No tweet generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating tweet:", error);
    return "";
  }
}

async function postTweet(tweetText) {
  try {
    const tweet = await client.v2.tweet(tweetText);
    console.log(`Tweet posted with ID ${tweet.data.id}`);
    return tweet.data.id;
  } catch (error) {
    console.error(`Failed to post tweet: ${error}`);
    return null;
  }
}

async function processPapers() {
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .gte(
      "publishedDate",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    )
    .is("twitterPublishedDate", null)
    .order("totalScore", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  if (papers.length === 0) {
    console.log("No papers found to process");
    return;
  }

  const paper = papers[0];
  const { id, generatedSummary, abstract, title, slug } = paper;

  const tweetText = await generateShitpost(
    generatedSummary,
    abstract,
    title,
    slug
  );

  if (!tweetText) {
    console.log(`Unable to generate tweet for paper ${id}`);
    return;
  }

  const tweetId = await postTweet(tweetText);

  if (tweetId) {
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ twitterPublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating twitterPublishedDate for paper ${id}:`,
        updateError
      );
    } else {
      console.log(`Updated twitterPublishedDate for paper ${id}`);
    }
  }
}

processPapers();
