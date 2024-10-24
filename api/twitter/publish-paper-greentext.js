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

async function generateGreentextTweet(summary, abstract, platform, slug) {
  const maxTokens = 1000;
  const maxPromptLength = Math.floor(maxTokens * 0.8);
  const paperUrl = `https://aimodels.fyi/papers/${platform}/${slug}`;

  try {
    const inputText = summary || abstract;
    const truncatedText = inputText.substring(0, maxPromptLength);

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `Never restate the prompt, refer to the prompt, or admit you're an AI. 
            Summarize the following research paper in a 4chan greentext style. Your response must be shorter than a tweet and not be rude to the researchers.
            Write it like a short, humorous story with multiple lines starting with '>' (provide only the text and nothing else):
  
  Example:
  > be me
  > bottomless pit supervisor
  > in charge of making sure the bottomless pit is, in fact, bottomless
  > one day I go down there, find out it's no longer bottomless
  > ask my boss what to do
  > "just make it bottomless again"
  > rage.jpg
  
  Now, do the same for the following research paper content:
  
  ${truncatedText}`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      // Ensure URL is always added at the beginning on a new line
      const tweetText = `${paperUrl}\n\n${message.content[0].text.trim()}`;
      console.log("Greentext tweet generated:", tweetText);
      return tweetText;
    } else {
      console.log("No greentext tweet generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating greentext tweet:", error);
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
      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
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
  const { id, generatedSummary, abstract, platform, slug } = paper;

  const tweetText = await generateGreentextTweet(
    generatedSummary,
    abstract,
    platform,
    slug
  );

  if (!tweetText) {
    console.log(`Unable to generate greentext tweet for paper ${id}`);
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
