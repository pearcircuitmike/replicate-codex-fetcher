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

async function generateTweetText(summary, abstract, platform, slug) {
  const maxTokens = 1000;
  const promptPercentage = 0.8;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);
  const prefix = "🔥 Trending paper: ";
  const suffix = `\n\nMore info: https://aimodels.fyi/papers/${platform}/${slug}`;
  const maxTweetLength = 280 - prefix.length - suffix.length;

  try {
    const inputText = summary || abstract;
    let truncatedText = inputText;
    if (inputText.length > maxPromptLength) {
      truncatedText = inputText.substring(0, maxPromptLength);
    }

    const message = await anthropic.messages.create({
      model: "claude-3-opus-20240229",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `Summarize the following research paper in one clear, twitter concise phrase:

          ${truncatedText}
          `,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let tweetText = message.content[0].text.trim();
      if (tweetText.length > maxTweetLength) {
        tweetText = tweetText.substring(0, maxTweetLength);
      }
      tweetText = `${prefix}${tweetText}${suffix}`;
      console.log("Tweet text generated:", tweetText);
      return tweetText;
    } else {
      console.log("No tweet text generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating tweet text:", error);
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
      new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    )
    .is("twitterPublishedDate", null)
    .order("totalScore", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { id, generatedSummary, abstract, platform, slug } = paper;

    const tweetText = await generateTweetText(
      generatedSummary,
      abstract,
      platform,
      slug
    );

    if (!tweetText) {
      console.log(`Unable to generate tweet text for paper ${id}`);
      continue;
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

    await delay(30000); // 30-second delay to avoid rate limits
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

processPapers();
