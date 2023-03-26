import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import pLimit from "p-limit";
import dotenv from "dotenv";
dotenv.config();

// Define your Supabase URL and key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Define the Replicate API token
const replicateApiToken = process.env.REPLICATE_API_KEY;

// Function to format the date in MM/DD/YY format
function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1; // Months are 0-indexed
  const year = date.getFullYear().toString().slice(-2); // Get the last two digits of the year
  return `${month}/${day}/${year}`;
}

// Function to update a single model
async function updateModel(model, lastUpdated) {
  try {
    // Construct the model URL for the Replicate API
    const modelUrl = `https://api.replicate.com/v1/models/${encodeURIComponent(
      model.creator
    )}/${encodeURIComponent(model.modelName)}`;

    // Log the URL being requested to debug
    console.log(`Requesting URL: ${modelUrl}`);

    // Fetch model data from the Replicate API
    const response = await axios.get(modelUrl, {
      headers: { Authorization: `Token ${replicateApiToken}` },
    });

    // Get the cover_image_url and replace "https://replicate.comNone" with an empty string
    let example = response.data.cover_image_url;
    if (example === "https://replicate.comNone") {
      example = "";
    }

    // Prepare the updated data
    const updatedData = {
      lastUpdated: lastUpdated,
      description: response.data.description,
      example: example,
      modelUrl: response.data.url,
      runs: response.data.run_count,
      githubUrl: response.data.github_url,
      paperUrl: response.data.paper_url,
      licenseUrl: response.data.license_url,
    };

    // Update the model record in the modelsData table
    const { error: updateError } = await supabase
      .from("modelsData")
      .update(updatedData)
      .match({ id: model.id });

    if (updateError) {
      throw updateError;
    }
  } catch (error) {
    console.error(
      `Failed to update model with ID ${model.id} in Supabase table.`,
      error.message
    );
  }
}

// Function to sleep for a specified duration (in milliseconds)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateModelsData() {
  try {
    // Fetch all models from the modelsData table
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Get the current date and format it
    const currentDate = new Date();
    const lastUpdated = formatDate(currentDate);

    // Set a limit on the number of concurrent API calls
    const limit = pLimit(10); // Set the desired concurrency limit

    // Batch size and delay between batches
    const batchSize = 50;
    const delayBetweenBatches = 5000; // 5 seconds

    // Process models in batches
    for (let i = 0; i < models.length; i += batchSize) {
      // Slice the models array to get the current batch
      const batch = models.slice(i, i + batchSize); // Process models in the current batch with limited concurrency
      const updatePromises = batch.map((model) =>
        limit(() => updateModel(model, lastUpdated))
      );
      await Promise.all(updatePromises);

      // If there are more batches, add a delay before processing the next batch
      if (i + batchSize < models.length) {
        await sleep(delayBetweenBatches);
      }
    }

    console.log("Models data successfully updated in Supabase table.");
  } catch (error) {
    console.error(
      "Failed to update models data in Supabase table.",
      error.message
    );
  }
}

// Call the updateModelsData function to start the update process
updateModelsData();
