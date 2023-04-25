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
  "Nvidia T4 GPU": 0.00055,
  "Nvidia A100 (40GB) GPU": 0.0023,
  "Nvidia A100 80GB GPU": 0.0032,
};

export async function getPricing(creator, modelName) {
  try {
    const modelUrl = `https://replicate.com/${encodeURIComponent(
      creator
    )}/${encodeURIComponent(modelName)}`;

    const modelPageResponse = await axios.get(modelUrl);
    const $ = cheerio.load(modelPageResponse.data);

    const performanceText = $("#performance").text();

    const hardwareTypePattern = /Predictions run on (.+?) hardware/;
    const typicalCompletionTimeSecondsPattern =
      /Predictions typically complete within (\d+) seconds/;

    const hardwareTypeMatch = performanceText.match(hardwareTypePattern);
    const timeMatchSeconds = performanceText.match(
      typicalCompletionTimeSecondsPattern
    );
    const hardwareType = hardwareTypeMatch ? hardwareTypeMatch[1] : null;
    const typicalCompletionTimeSeconds = timeMatchSeconds
      ? parseFloat(timeMatchSeconds[1])
      : null;

    let costToRun = null;
    if (
      hardwareType &&
      typicalCompletionTimeSeconds &&
      hardwareCostsPerSecond[hardwareType]
    ) {
      costToRun =
        hardwareCostsPerSecond[hardwareType] * typicalCompletionTimeSeconds;
    }

    return {
      costToRun,
      hardwareType,
      typicalCompletionTimeSeconds,
    };
  } catch (error) {
    console.error(
      "Failed to get runtime cost data from Replicate model page.",
      error.message
    );
    return null;
  }
}

async function updateAllModelsPricing() {
  try {
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    for (const model of models) {
      const pricingData = await getPricing(model.creator, model.modelName);

      if (pricingData === null) {
        console.log(
          `No pricing data available for model ${model.modelName}. Skipping update.`
        );
        continue;
      }

      const { costToRun, hardwareType, typicalCompletionTimeSeconds } =
        pricingData;

      const { error: updateError } = await supabase
        .from("modelsData")
        .update({
          costToRun,
          predictionHardware: hardwareType,
          avgCompletionTime: typicalCompletionTimeSeconds,
        })
        .match({ id: model.id });

      if (updateError) {
        throw updateError;
      }

      console.log(
        `Updated pricing data for model ${model.modelName}: costToRun=${costToRun}, predictionHardware=${hardwareType}, avgCompletionTime=${typicalCompletionTimeSeconds}`
      );
    }

    console.log(
      "Pricing data successfully updated for all models in Supabase table."
    );
  } catch (error) {
    console.error(
      "Failed to update pricing data for models in Supabase table.",
      error.message
    );
  }
}

// Call the updateAllModelsPricing function to start the update process
updateAllModelsPricing();
export { updateAllModelsPricing };
