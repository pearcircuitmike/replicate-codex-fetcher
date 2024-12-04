import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function updateModelGithubScore(model) {
  console.log(`Updating GitHub score for model: ${model.id}`);
  console.log(`GitHub URL: ${model.githubUrl}`);

  try {
    const repoPath = model.githubUrl.split("https://github.com/")[1];
    console.log(`Extracted repository path: ${repoPath}`);

    const apiUrl = `https://api.github.com/repos/${repoPath}`;
    console.log(`GitHub API URL: ${apiUrl}`);

    const response = await axios.get(apiUrl);
    const stargazersCount = response.data.stargazers_count;
    const currentTimestamp = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("modelsData")
      .update({
        githubScore: stargazersCount,
        lastUpdated: currentTimestamp,
      })
      .eq("id", model.id);

    if (updateError) {
      console.error(
        `Failed to update GitHub score for model ${model.id} due to:`,
        updateError
      );
    } else {
      console.log(
        `Successfully updated GitHub score and lastUpdated for model ${model.id}`
      );
    }
  } catch (error) {
    console.error(
      `Failed to fetch GitHub data for model ${model.id} due to:`,
      error.message
    );
    if (error.response) {
      console.error("Error response data:", error.response.data);
      console.error("Error response status:", error.response.status);
      console.error("Error response headers:", error.response.headers);
    }
    console.error("Error config:", error.config);
  }

  // Add a delay between requests
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

export async function updateGithubScore() {
  console.log("Initiating the updateGithubScore process...");
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  while (hasMoreData) {
    console.log(
      `Fetching models from the database (start: ${start}, limit: ${limit})...`
    );

    const {
      data: models,
      error: fetchError,
      count,
    } = await supabase
      .from("modelsData")
      .select("id, githubUrl", { count: "exact" })
      .eq("platform", "replicate")
      .not("githubUrl", "is", null)
      .gte("indexedDate", sevenDaysAgo.toISOString())
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error("Error fetching models from the database:", fetchError);
      return;
    }

    if (models && models.length > 0) {
      console.log(`Processing ${models.length} models...`);
      for (const model of models) {
        await updateModelGithubScore(model);
      }
    }

    start += limit;
    hasMoreData = start < count;
    console.log(
      `Progress: processed up to ${start}, hasMoreData: ${hasMoreData}`
    );
  }

  console.log("Finished updating GitHub scores.");
}

updateGithubScore();
