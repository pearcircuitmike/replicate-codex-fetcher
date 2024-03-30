import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const replicateApiKey = process.env.REPLICATE_API_KEY;

function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

async function updateExistingModel(data) {
  const currentDate = new Date();
  const lastUpdated = formatDate(currentDate);

  console.log(`Checking model: ${data.owner}/${data.name}`);

  const { data: existingModels, error: fetchError } = await supabase
    .from("replicateModelsData")
    .select("id")
    .eq("creator", data.owner)
    .eq("modelName", data.name);

  if (fetchError) {
    console.error("Error fetching model from the database:", fetchError);
    return;
  }

  if (existingModels && existingModels.length > 0) {
    console.log(`Found existing model: ${data.owner}/${data.name}`);
    const { error: updateError } = await supabase
      .from("replicateModelsData")
      .update({
        lastUpdated: lastUpdated,
        licenseUrl: data.license_url,
        paperUrl: data.paper_url,
        githubUrl: data.github_url,
        description: data.description,
        runs: data.run_count,
      })
      .eq("id", existingModels[0].id);

    if (updateError) {
      console.error(
        `Failed to update model ${data.owner}/${data.name} due to:`,
        updateError
      );
    } else {
      console.log(`Successfully updated model ${data.owner}/${data.name}`);
    }
  } else {
    console.log(
      `Model ${data.owner}/${data.name} does not exist in the database.`
    );
  }
}

async function fetchModelsFromAPI() {
  let nextURL = "https://api.replicate.com/v1/models";
  console.log("Starting the model fetch process from Replicate API...");

  while (nextURL) {
    console.log(`Fetching from URL: ${nextURL}`);
    try {
      const response = await axios.get(nextURL, {
        headers: {
          Authorization: `Token ${replicateApiKey}`,
        },
      });

      console.log(`Received ${response.data.results.length} models from API.`);
      const models = response.data.results;
      for (const model of models) {
        await updateExistingModel(model);
      }

      // Update the nextURL if "next" is present in the response for pagination
      nextURL = response.data.next;
    } catch (error) {
      console.error("Failed to fetch models from API due to:", error.message);
      break;
    }
  }
  console.log("Finished processing models.");
}

export function updateRuns() {
  console.log("Initiating the updateRuns process...");
  fetchModelsFromAPI();
}

// Automatically call updateRuns when this script is executed
updateRuns();
