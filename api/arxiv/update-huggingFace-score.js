import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const MAX_TO_PROCESS = 500;

/**
 * Fetch the Hugging Face repos for a given arXiv ID and compute a repos score.
 * The score is the sum of the counts for models, datasets, and spaces.
 *
 * @param {string} arxivId - The arXiv ID of the paper.
 * @returns {Promise<number>} - The computed repos score.
 */
async function fetchReposScore(arxivId) {
  if (!arxivId) {
    console.error("No arXiv ID provided.");
    return 0;
  }
  try {
    const url = `https://huggingface.co/api/arxiv/${encodeURIComponent(
      arxivId
    )}/repos`;
    const response = await axios.get(url);
    const data = response.data;
    const modelsCount = Array.isArray(data.models) ? data.models.length : 0;
    const datasetsCount = Array.isArray(data.datasets)
      ? data.datasets.length
      : 0;
    const spacesCount = Array.isArray(data.spaces) ? data.spaces.length : 0;
    return modelsCount + datasetsCount + spacesCount;
  } catch (error) {
    console.error(
      `Error fetching repos for arXiv ID ${arxivId}: ${error.message}`
    );
    return 0;
  }
}

/**
 * Paginates through the "arxivPapersData" table for papers indexed in the last week,
 * then prioritizes those that appear in daily papers, computes a composite score,
 * and updates the record with the new huggingFaceScore and lastUpdated timestamp.
 */
async function updateHuggingFaceScore() {
  console.log("Starting to update Hugging Face scores...");

  // 1. Fetch daily papers from Hugging Face and build a map keyed by arXiv ID.
  const dailyPapersMap = new Map();
  try {
    const dailyResponse = await axios.get(
      "https://huggingface.co/api/daily_papers"
    );
    const dailyPapers = dailyResponse.data;
    if (Array.isArray(dailyPapers)) {
      for (const entry of dailyPapers) {
        const arxivId = entry.paper?.id;
        if (arxivId) {
          dailyPapersMap.set(arxivId, entry);
        }
      }
      console.log(`Fetched ${dailyPapersMap.size} daily paper entries.`);
    } else {
      console.error("Unexpected daily papers response format.");
    }
  } catch (error) {
    console.error("Error fetching daily papers data:", error.message);
  }

  // 2. Set up pagination: select papers from the last week (using indexedDate).
  const oneWeekAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  // Separate papers into two arrays: those in daily papers and others.
  const dailyList = [];
  const otherList = [];
  let totalCollected = 0;

  while (hasMoreData && totalCollected < MAX_TO_PROCESS) {
    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      .select("id, arxivId, paperUrl, indexedDate")
      .gte("indexedDate", oneWeekAgo)
      .range(start, start + limit - 1);

    if (error) {
      console.error("Failed to fetch papers from the database:", error);
      return;
    }

    if (!papers || papers.length === 0) {
      console.log("No more papers to process.");
      hasMoreData = false;
      break;
    }

    for (const paper of papers) {
      if (totalCollected >= MAX_TO_PROCESS) break;
      const arxivId = paper.arxivId;
      if (arxivId && dailyPapersMap.has(arxivId)) {
        dailyList.push(paper);
      } else {
        otherList.push(paper);
      }
      totalCollected = dailyList.length + otherList.length;
    }
    start += limit;
  }

  // Combine daily papers first then others.
  const combinedPapers = [...dailyList, ...otherList].slice(0, MAX_TO_PROCESS);
  console.log(
    `Processing ${combinedPapers.length} papers (daily papers prioritized)...`
  );

  // 3. Process each paper: compute scores and update the database.
  for (const paper of combinedPapers) {
    const { id, arxivId, paperUrl } = paper;
    console.log(`\nProcessing paper: "${paperUrl}" (arXiv ID: ${arxivId})...`);

    // Fetch the repos score from the Hugging Face repos endpoint.
    const reposScore = await fetchReposScore(arxivId);
    console.log(`Repos Score for arXiv ID ${arxivId}: ${reposScore}`);

    // Check for a daily paper entry; if present, calculate the daily score.
    let dailyScore = 0;
    let upvotes = 0,
      numComments = 0;
    const dailyEntry = dailyPapersMap.get(arxivId);
    if (dailyEntry) {
      upvotes = Number(dailyEntry.paper?.upvotes) || 0;
      numComments = Number(dailyEntry.numComments) || 0;
      dailyScore = upvotes + numComments;
      console.log(
        `Daily Entry found: Upvotes: ${upvotes}, Comments: ${numComments} (Daily Score: ${dailyScore})`
      );
    } else {
      console.log("No Daily Entry found for this paper.");
    }

    // Composite score: the sum of the repos score and the daily score.
    const compositeScore = reposScore + dailyScore;
    console.log(
      `Composite Score (Repos Score + Daily Score): ${compositeScore}`
    );

    // Update the record in the database: set huggingFaceScore and update lastUpdated.
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({
        huggingFaceScore: compositeScore,
        lastUpdated: now,
      })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Failed to update record for paper "${paperUrl}" (ID: ${id}):`,
        updateError
      );
    } else {
      console.log(
        `Successfully updated paper "${paperUrl}" with huggingFaceScore: ${compositeScore} and lastUpdated: ${now}`
      );
    }
  }

  console.log("Finished processing and updating papers.");
}

updateHuggingFaceScore();
