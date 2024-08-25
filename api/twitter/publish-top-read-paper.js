import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

function truncateTitle(title, maxLength = 200) {
  if (title.length <= maxLength) return title;
  return title.substring(0, maxLength - 3) + "...";
}

function generateTweetText(paper) {
  const prefix =
    "📚 Here's the top read AI research paper on the site today:\n\n";
  const suffix = `\n\nSummary here: https://aimodels.fyi/papers/arxiv/${paper.slug}`;
  const maxTitleLength = 280 - prefix.length - suffix.length;

  const truncatedTitle = truncateTitle(paper.title, maxTitleLength);
  return `${prefix}${truncatedTitle}${suffix}`;
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

async function processTopPaper() {
  const { data: papers, error } = await supabase
    .from("top_paper_views")
    .select("*")
    .order("view_count", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching top paper:", error);
    return;
  }

  if (papers.length === 0) {
    console.log("No top paper found");
    return;
  }

  const topPaper = papers[0];
  const tweetText = generateTweetText(topPaper);

  console.log("Potential tweet for top read paper:");
  console.log(tweetText);
  console.log("------------------------");
  console.log("Character count:", tweetText.length);

  console.log("\nPaper details:");
  console.log(`Title: "${topPaper.title}"`);
  console.log(`Views: ${topPaper.view_count}`);
  console.log(`Slug: ${topPaper.slug}`);

  // Post the tweet
  const tweetId = await postTweet(tweetText);

  if (tweetId) {
    console.log(`Successfully tweeted about paper ${topPaper.id}`);
  }
}

processTopPaper();
