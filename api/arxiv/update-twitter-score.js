import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const bearerToken = process.env.TWITTER_BEARER_TOKEN;
const endpointUrl = "https://api.twitter.com/2/tweets/search/recent";

async function getTwitterDataForPaper(arxivId, paperId) {
  if (!arxivId) {
    // If no arXiv ID is found, return an empty array
    return [];
  }

  // Build the query using the arXiv ID, ignoring retweets
  const params = new URLSearchParams({
    query: `url:"${arxivId}" -is:retweet`,
    "tweet.fields": "public_metrics,author_id",
    "user.fields": "username",
    expansions: "author_id",
    max_results: "10",
    sort_order: "relevancy",
  });

  try {
    const response = await fetch(`${endpointUrl}?${params}`, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "User-Agent": "v2RecentSearchJS",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log("Twitter API Response:", JSON.stringify(data, null, 2));

    if (data.meta && data.meta.result_count > 0 && data.data) {
      const tweetData = data.data.map((tweet) => {
        const user = data.includes.users.find((u) => u.id === tweet.author_id);
        return {
          paper_id: paperId,
          tweet_text: tweet.text,
          tweet_id: tweet.id,
          username: user ? user.username : null,
          retweet_count: tweet.public_metrics.retweet_count,
          reply_count: tweet.public_metrics.reply_count,
          like_count: tweet.public_metrics.like_count,
          quote_count: tweet.public_metrics.quote_count,
          bookmark_count: tweet.public_metrics.bookmark_count,
          impression_count: tweet.public_metrics.impression_count,
        };
      });

      return tweetData;
    } else {
      console.log(`No tweets found for arXiv ID ${arxivId}`);
      return [];
    }
  } catch (error) {
    console.error(
      `Error searching for tweets with arXiv ID ${arxivId}: ${error}`
    );
    return [];
  }
}

async function logAndUpdateTwitterData() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("id, paperUrl, title, totalScore, arxivId")
    .gte("indexedDate", weekAgo)
    .order("totalScore", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { id, arxivId, paperUrl, title } = paper;
    const tweetData = await getTwitterDataForPaper(arxivId, id);

    console.log(
      `Paper ID: ${id}, Title: ${title}, arXiv ID: ${arxivId}, URL: ${paperUrl}, Tweets found: ${tweetData.length}`
    );

    if (tweetData.length > 0) {
      const { error: insertError } = await supabase
        .from("paper_tweets")
        .insert(tweetData);

      if (insertError) {
        console.error(`Error inserting tweets for paper ${id}:`, insertError);
      } else {
        console.log(
          `Successfully inserted ${tweetData.length} tweets for paper ${id}`
        );
      }
    } else {
      console.log(`No tweets to insert for paper ${id}`);
    }

    // Delay next API call by 2 seconds to respect Twitter's rate limit
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

logAndUpdateTwitterData();
