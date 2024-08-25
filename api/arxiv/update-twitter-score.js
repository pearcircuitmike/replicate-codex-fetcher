import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const bearerToken = process.env.TWITTER_BEARER_TOKEN;
const endpointUrl = "https://api.twitter.com/2/tweets/search/recent";

async function getTwitterDataForPaper(paperUrl, paperId) {
  const params = new URLSearchParams({
    query: `url:"${paperUrl}" -is:retweet`,
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

    if (data.meta.result_count > 0) {
      const tweetData = data.data.map((tweet) => ({
        paper_id: paperId,
        tweet_text: tweet.text,
        tweet_id: tweet.id,
        username: data.includes.users.find(
          (user) => user.id === tweet.author_id
        ).username,
        retweet_count: tweet.public_metrics.retweet_count,
        reply_count: tweet.public_metrics.reply_count,
        like_count: tweet.public_metrics.like_count,
        quote_count: tweet.public_metrics.quote_count,
        bookmark_count: tweet.public_metrics.bookmark_count,
        impression_count: tweet.public_metrics.impression_count,
      }));

      return tweetData;
    } else {
      console.log(`No tweets found for ${paperUrl}`);
      return [];
    }
  } catch (error) {
    console.error(`Error searching for tweets: ${error}`);
    return [];
  }
}

async function logAndUpdateTwitterData() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("id, paperUrl, title, totalScore")
    .gte("indexedDate", weekAgo)
    .gt("totalScore", 0.1)
    .order("totalScore", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { id, paperUrl, title } = paper;
    const tweetData = await getTwitterDataForPaper(paperUrl, id);

    console.log(
      `Paper ID: ${id}, Title: ${title}, URL: ${paperUrl}, Tweets found: ${tweetData.length}`
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
