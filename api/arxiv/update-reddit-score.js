import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const clientId = process.env.REDDIT_CLIENT_ID;
const clientSecret = process.env.REDDIT_CLIENT_SECRET;
const username = process.env.REDDIT_USERNAME;
const password = process.env.REDDIT_PASSWORD;

let accessToken = null;

async function getAccessToken() {
  console.log("Generating access token...");
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

  const data = response.data;
  console.log("Access token response:", data);

  if (data.access_token) {
    console.log("Access token generated successfully.");
    return data.access_token;
  } else {
    console.error("Failed to generate access token.");
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRedditScore(paperUrl) {
  try {
    if (!accessToken) {
      accessToken = await getAccessToken();
      if (!accessToken) {
        console.error("Access token is missing. Skipping Reddit score fetch.");
        return null;
      }
    }

    console.log("Paper URL:", paperUrl);
    const encodedUrl = encodeURIComponent(paperUrl);
    console.log("Encoded URL:", encodedUrl);

    const apiUrl = `https://oauth.reddit.com/search.json?q=${encodedUrl}&limit=10&sort=top`;
    console.log("API URL:", apiUrl);

    const response = await axios.get(apiUrl, {
      headers: {
        Authorization: `${accessToken}`,
        "User-Agent": "aimodelsfyiscript by successful-western27",
      },
    });

    console.log("Access Token:", accessToken);
    console.log("Encoded URL:", encodedUrl);
    console.log("Request Headers:", response.headers);
    console.log("Reddit API response status:", response.status);

    if (response.status === 200) {
      const data = response.data;
      console.log("Reddit API response data:", data);

      if (data && Array.isArray(data)) {
        let totalScore = 0;
        for (const listing of data) {
          if (
            listing &&
            listing.kind === "Listing" &&
            listing.data &&
            listing.data.children &&
            Array.isArray(listing.data.children)
          ) {
            const posts = listing.data.children;
            const listingScore = posts.reduce(
              (sum, post) => sum + (post.data.score || 0),
              0
            );
            totalScore += listingScore;
          }
        }
        return totalScore;
      }
      console.log("No valid listings found.");
      return 0;
    } else {
      console.error("Reddit API request failed with status:", response.status);
      return null;
    }
  } catch (error) {
    console.error(`Failed to fetch Reddit score for ${paperUrl}:`, error);
    return null;
  }
}

async function updateRedditScore() {
  console.log("Starting to update Reddit scores...");
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      .select("id, paperUrl")
      .gte(
        "publishedDate",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      )
      .range(start, start + limit - 1);

    if (error) {
      console.error("Failed to fetch papers from the database:", error);
      return;
    }

    if (papers.length === 0) {
      console.log("No more papers to process.");
      hasMoreData = false;
    } else {
      console.log(`Processing ${papers.length} papers...`);
      for (const paper of papers) {
        const { id, paperUrl } = paper;
        console.log(`Fetching Reddit score for paper "${paperUrl}"...`);
        const redditScore = await fetchRedditScore(paperUrl);
        console.log(
          `Updating Reddit score for paper "${paperUrl}" to ${redditScore}...`
        );
        const { error: updateError } = await supabase
          .from("arxivPapersData")
          .update({ redditScore, lastUpdated: new Date().toISOString() })
          .eq("id", id);

        if (updateError) {
          console.error(
            `Failed to update Reddit score for paper "${paperUrl}":`,
            updateError
          );
        } else {
          console.log(
            `Updated Reddit score for paper "${paperUrl}" to ${redditScore}.`
          );
        }

        // Delay for 667 milliseconds to stay within the rate limit
        await delay(667);
      }
      start += limit;
      console.log(`Processed papers up to ${start}`);
    }
  }

  console.log("Finished updating Reddit scores.");
}

updateRedditScore();
