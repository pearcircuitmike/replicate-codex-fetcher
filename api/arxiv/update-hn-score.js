import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function fetchHackerNewsScore(arxivId) {
  try {
    // If there's no arXivId, just return 0
    if (!arxivId) {
      return 0;
    }

    const encodedId = encodeURIComponent(arxivId);
    // Use the arXiv ID in the query instead of the full paper URL
    const response = await axios.get(
      `http://hn.algolia.com/api/v1/search?query=${encodedId}&tags=story&typoTolerance=false`
    );
    const hits = response.data.hits;
    if (hits.length > 0) {
      return hits[0].points || 0;
    }
    return 0;
  } catch (error) {
    console.error(
      `Failed to fetch Hacker News score for arXiv ID ${arxivId}:`,
      error
    );
    return null;
  }
}

async function updateHackerNewsScore() {
  console.log("Starting to update Hacker News scores...");

  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      // Select the arxivId and also the paperUrl if you still want it for logging
      .select("id, arxivId, paperUrl")
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
        const { id, arxivId, paperUrl } = paper;

        console.log(
          `Fetching Hacker News score for paper "${paperUrl}" (arXiv ID: ${arxivId})...`
        );
        const hackerNewsScore = await fetchHackerNewsScore(arxivId);

        console.log(
          `Updating Hacker News score for "${paperUrl}" (arXiv ID: ${arxivId}) to ${hackerNewsScore}...`
        );

        const { error: updateError } = await supabase
          .from("arxivPapersData")
          .update({ hackerNewsScore, lastUpdated: new Date().toISOString() })
          .eq("id", id);

        if (updateError) {
          console.error(
            `Failed to update Hacker News score for paper "${paperUrl}":`,
            updateError
          );
        } else {
          console.log(
            `Updated Hacker News score for paper "${paperUrl}" to ${hackerNewsScore}.`
          );
        }
      }

      start += limit;
      console.log(`Processed papers up to ${start}`);
    }
  }

  console.log("Finished updating Hacker News scores.");
}

updateHackerNewsScore();
