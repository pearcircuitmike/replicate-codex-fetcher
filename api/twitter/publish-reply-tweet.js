import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";

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

async function generateReplyText(tweetText, paperSlug) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 280, // Twitter's character limit
      messages: [
        {
          role: "user",
          content: `Generate a brief, engaging reply to the following tweet about a research paper. 
          Include a link to the paper summary. The reply should be concise and fit within Twitter's character limit. It should be casual and written like a regular person tweets.
          

Tweet: ${tweetText}

Paper summary link: https://aimodels.fyi/papers/arxiv/${paperSlug}

Never mention you are an AI, responding to a prompt, mention your instructions, or anything like that. Reply only exactly with your reply text and nothing else.

If you can't come up with something meaningful to say, just say something about how the paper summary can be found at the link.

reply in all lower case. be matter of fact and do not hype things up.  

Reply:`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let replyText = message.content[0].text.trim();
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

async function postReplyTweet(tweetText, inReplyToTweetId) {
  console.log(`Attempting to post reply to tweet ${inReplyToTweetId}`);
  console.log(`Reply text: ${tweetText}`);

  try {
    const tweet = await client.v2.tweet(tweetText, {
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

    if (
      error.code === 403 &&
      error.data &&
      error.data.detail.includes("duplicate content")
    ) {
      console.log(
        "Duplicate content detected. Treating as a successful post to avoid repeated attempts."
      );
      return true;
    }

    return false;
  }
}

async function processReplies() {
  console.log("Starting processReplies function");

  const { data: tweets, error } = await supabase
    .from("paper_tweets")
    .select("id, tweet_id, paper_id")
    .is("replied_at", null)
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    console.error("Error fetching tweets from Supabase:", error);
    return;
  }

  console.log(`Fetched ${tweets.length} tweets to process`);

  for (const tweet of tweets) {
    console.log(`Processing tweet ${tweet.id}`);

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
      continue;
    }

    const replyText = await generateReplyText(paperData.title, paperData.slug);

    if (!replyText) {
      console.log(`Failed to generate reply for tweet ${tweet.id}`);
      continue;
    }

    console.log(`Posting reply to tweet ${tweet.tweet_id}`);
    const replySuccess = await postReplyTweet(replyText, tweet.tweet_id);

    if (replySuccess) {
      console.log(`Updating replied_at for tweet ${tweet.id}`);
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
        console.log(`Successfully updated replied_at for tweet ${tweet.id}`);
      }

      console.log(`Waiting for 30 seconds before processing next tweet`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
    } else {
      console.log(
        `Failed to post reply for tweet ${tweet.id}. Skipping database update.`
      );
    }
  }

  console.log("Finished processing all tweets");
}

console.log("Script started");
processReplies()
  .then(() => console.log("Script completed"))
  .catch((error) => console.error("Unhandled error in script:", error.message));
