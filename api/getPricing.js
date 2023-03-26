import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import cheerio from "cheerio";
import dotenv from "dotenv";
dotenv.config();

// Define your Supabase URL and key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Define a mapping of hardware types to costs per second
const hardwareCostsPerSecond = {
  CPU: 0.0002,
  "Nvidia T4 GPU": 0.00055,
  "Nvidia A100 GPU": 0.0023,
};

// Function to get the runtime cost data (costToRun) for a model
async function getPricing(creator, modelName) {
  try {
    // Construct the model URL (properly encoding the values)
    const modelUrl = `https://replicate.com/${encodeURIComponent(
      creator
    )}/${encodeURIComponent(modelName)}`;

    // Fetch the model page HTML content
    const modelPageResponse = await axios.get(modelUrl);
    const $ = cheerio.load(modelPageResponse.data);

    // Extract the text content of the #performance div
    const performanceText = $("#performance").text();

    // Define the regular expressions to match the hardware type and typical completion time
    const hardwareTypePattern = /Predictions run on (.+?) hardware/;
    const typicalCompletionTimeSecondsPattern =
      /Predictions typically complete within (\d+) seconds/;

    // Extract the hardware type and typical completion time using the regular expressions
    const hardwareTypeMatch = performanceText.match(hardwareTypePattern);
    const timeMatchSeconds = performanceText.match(
      typicalCompletionTimeSecondsPattern
    );
    const hardwareType = hardwareTypeMatch ? hardwareTypeMatch[1] : null;
    const typicalCompletionTimeSeconds = timeMatchSeconds
      ? parseFloat(timeMatchSeconds[1])
      : null;

    // Calculate the costToRun value (if hardware type and typical completion time are available)
    let costToRun = null;
    if (
      hardwareType &&
      typicalCompletionTimeSeconds &&
      hardwareCostsPerSecond[hardwareType]
    ) {
      costToRun =
        hardwareCostsPerSecond[hardwareType] * typicalCompletionTimeSeconds;
    }

    // Return the costToRun value
    return costToRun;
  } catch (error) {
    console.error(
      "Failed to get runtime cost data from Replicate model page.",
      error.message
    );
    return null;
  }
}

// Function to fetch all models and get pricing for each model
async function updateAllModelsPricing() {
  try {
    // Fetch all models from the modelsData table
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Iterate through each model and update its runtime

    for (const model of models) {
      // Get pricing for the current model
      const costToRun = await getPricing(model.creator, model.modelName);

      // If costToRun is null, skip updating the model record
      if (costToRun === null) {
        console.log(
          `No costToRun data available for model ${model.modelName}. Skipping update.`
        );
        continue;
      }

      // Update the model record in the modelsData table
      const { error: updateError } = await supabase
        .from("modelsData")
        .update({ costToRun })
        .match({ id: model.id });

      if (updateError) {
        throw updateError;
      }

      console.log(
        `Updated costToRun for model ${model.modelName}: ${costToRun}`
      );
    }

    console.log(
      "Runtime cost data successfully updated for all models in Supabase table."
    );
  } catch (error) {
    console.error(
      "Failed to update runtime cost data for models in Supabase table.",
      error.message
    );
  }
}

// Call the updateAllModelsPricing function to start the update process
updateAllModelsPricing();
