import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const bearerToken = process.env.TWITTER_BEARER_TOKEN;
const endpointUrl = "https://api.twitter.com/2/tweets/search/recent";

async function getTwitterScoreForPaper(paperUrl) {
  const params = new URLSearchParams({
    query: `url:"${paperUrl}" -is:retweet`,
    "tweet.fields": "public_metrics",
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
      // Find the tweet with the highest engagement
      const mostPopularTweet = data.data.reduce(
        (max, tweet) =>
          tweet.public_metrics.retweet_count + tweet.public_metrics.like_count >
          max.public_metrics.retweet_count + max.public_metrics.like_count
            ? tweet
            : max,
        data.data[0]
      );

      const score =
        mostPopularTweet.public_metrics.retweet_count +
        mostPopularTweet.public_metrics.like_count;
      console.log(
        `Score for ${paperUrl}: ${score} (${mostPopularTweet.public_metrics.retweet_count} RTs + ${mostPopularTweet.public_metrics.like_count} likes)`
      );
      return score;
    } else {
      console.log(`No tweets found for ${paperUrl}`);
      return null;
    }
  } catch (error) {
    console.error(`Error searching for tweets: ${error}`);
    return null;
  }
}

async function logAndUpdateTwitterScores() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("id, paperUrl, title, totalScore")
    .gte("indexedDate", weekAgo)
    .gt("totalScore", 1)
    .order("totalScore", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { id, paperUrl, title } = paper;
    const twitterScore = await getTwitterScoreForPaper(paperUrl);

    console.log(
      `Paper ID: ${id}, Title: ${title}, URL: ${paperUrl}, Twitter Score: ${twitterScore}`
    );

    if (twitterScore !== null) {
      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ twitterScore })
        .eq("id", id);

      if (updateError) {
        console.error(
          `Error updating Twitter score for paper ${id}:`,
          updateError
        );
      } else {
        console.log(`Successfully updated Twitter score for paper ${id}`);
      }
    } else {
      console.log(
        `Skipped updating Twitter score for paper ${id} due to error or no tweets found`
      );
    }

    // Delay next API call by 2 seconds to respect Twitter's rate limit
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

logAndUpdateTwitterScores();
