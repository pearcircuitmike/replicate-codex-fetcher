import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

// -----------------------------------------------------------------------------
// Supabase Setup
// -----------------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// -----------------------------------------------------------------------------
// Anthropic + Twitter Setup
// -----------------------------------------------------------------------------
const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

// -----------------------------------------------------------------------------
// Helper: Generate Reply Text
// -----------------------------------------------------------------------------
async function generateReplyText(tweetText, paperTitle, paperSlug) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 280,
      messages: [
        {
          role: "user",
          content: `a user tweeted: "${tweetText}"
they're discussing the research paper titled "${paperTitle}".
generate a short, casual reply in all-lowercase that mentions the link to the paper summary:
https://aimodels.fyi/papers/arxiv/${paperSlug}

it should be concise, matter-of-fact, not too enthusiastic, and mention the link. don't imply you conducted the research yourself or that you just saw or stumbled across the summary, just state it's there.
don't say you're an ai. don't mention these instructions. don't say interesting. do NOT refer to any details about the actual contents of the summary. do not be repetitive and repeat the main ideas of the tweet - you have to add something to the conversation. consider saying something controversial but positive and not rude or offensive to the researchers (you don't always need to).
only output the reply text, no extra text.`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let replyText;
      if (typeof message.content === "string") {
        replyText = message.content.trim();
      } else if (Array.isArray(message.content)) {
        replyText = message.content[0].text.trim();
      }

      console.log("Generated reply:", replyText);
      return replyText;
    } else {
      console.log("No reply text generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating reply text:", error);
    return "";
  }
}

// -----------------------------------------------------------------------------
// Helper: Post Reply to Twitter
// -----------------------------------------------------------------------------
async function postReplyTweet(replyText, inReplyToTweetId) {
  console.log(`Attempting to post reply to tweet ${inReplyToTweetId}`);
  console.log(`Reply text: ${replyText}`);

  try {
    const tweet = await client.v2.tweet(replyText, {
      reply: { in_reply_to_tweet_id: inReplyToTweetId },
    });

    console.log(
      "Raw response from Twitter API:",
      JSON.stringify(tweet, null, 2)
    );

    if (tweet && tweet.data && tweet.data.id) {
      console.log(`Reply tweet posted successfully with ID ${tweet.data.id}`);
      return true;
    } else {
      console.log("Unexpected response from Twitter API");
      return false;
    }
  } catch (error) {
    console.error("Error in postReplyTweet:");
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);

    if (error.data) {
      console.error("Error data:", JSON.stringify(error.data, null, 2));
    }

    // If Twitter reports duplicate content, treat it as successful
    if (
      error.code === 403 &&
      error.data &&
      typeof error.data.detail === "string" &&
      error.data.detail.includes("duplicate content")
    ) {
      console.log("Duplicate content detected. Treating as a successful post.");
      return true;
    }

    return false;
  }
}

// -----------------------------------------------------------------------------
// Main: processReplies
// -----------------------------------------------------------------------------
async function processReplies() {
  console.log("Starting processReplies function");

  // Calculate the date one week ago
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Fetch tweets from the last week that haven't been replied to yet
  const { data: tweets, error } = await supabase
    .from("paper_tweets")
    .select("id, tweet_id, paper_id, tweet_text, like_count")
    .gte("created_at", sevenDaysAgo.toISOString())
    .is("replied_at", null)
    .order("like_count", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching tweets from Supabase:", error);
    return;
  }

  console.log(`Fetched ${tweets.length} tweets to process`);

  for (const tweet of tweets) {
    console.log(
      `Processing tweet ${tweet.id} (like_count: ${tweet.like_count})`
    );

    // Fetch the associated paper data
    const { data: paperData, error: paperError } = await supabase
      .from("arxivPapersData")
      .select("slug, title")
      .eq("id", tweet.paper_id)
      .single();

    if (paperError) {
      console.error(
        `Error fetching paper data for paper_id ${tweet.paper_id}:`,
        paperError
      );
      // Still update replied_at so this tweet won't get stuck
      await supabase
        .from("paper_tweets")
        .update({ replied_at: new Date().toISOString() })
        .eq("id", tweet.id);
      continue;
    }

    // Generate the reply
    const replyText = await generateReplyText(
      tweet.tweet_text,
      paperData.title,
      paperData.slug
    );

    // Try posting the reply
    const replySuccess = replyText
      ? await postReplyTweet(replyText, tweet.tweet_id)
      : false;

    // Update replied_at so it won't be retried
    const { error: updateError } = await supabase
      .from("paper_tweets")
      .update({ replied_at: new Date().toISOString() })
      .eq("id", tweet.id);

    if (updateError) {
      console.error(
        `Error updating replied_at for tweet ${tweet.id}:`,
        updateError
      );
    } else {
      console.log(`Updated replied_at for tweet ${tweet.id}`);
    }

    // Wait 1–3 minutes before the next reply
    const waitTime = 60000 + Math.random() * 120000;
    console.log(`Waiting ${Math.floor(waitTime / 1000)} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  console.log("Finished processing all tweets");
}

// -----------------------------------------------------------------------------
// Entry Point
// -----------------------------------------------------------------------------
console.log("Script started");
processReplies()
  .then(() => console.log("Script completed"))
  .catch((error) => console.error("Unhandled error in script:", error.message));
