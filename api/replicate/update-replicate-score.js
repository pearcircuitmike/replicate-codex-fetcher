import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const replicateApiKey = process.env.REPLICATE_API_KEY;

async function updateModelRuns(model) {
  console.log(`Updating runs for model: ${model.creator}/${model.modelName}`);

  try {
    const response = await axios.get(
      `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}`,
      {
        headers: {
          Authorization: `Token ${replicateApiKey}`,
        },
      }
    );

    const currentTimestamp = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("modelsData")
      .update({
        replicateScore: response.data.run_count,
        lastUpdated: currentTimestamp,
      })
      .eq("platform", "replicate")
      .eq("id", model.id);

    if (updateError) {
      console.error(
        `Failed to update runs for model ${model.creator}/${model.modelName} due to:`,
        updateError
      );
    } else {
      console.log(
        `Successfully updated runs and lastUpdated for model ${model.creator}/${model.modelName}`
      );
    }
  } catch (error) {
    console.error(
      `Failed to fetch model ${model.creator}/${model.modelName} from API due to:`,
      error.message
    );
  }
}

export async function updateRuns() {
  console.log("Initiating the updateRuns process...");

  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const {
      data: models,
      error: fetchError,
      count,
    } = await supabase
      .from("modelsData")
      .select("id, creator, modelName, indexedDate", { count: "exact" })
      .eq("platform", "replicate")
      .gte(
        "indexedDate",
        new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      )
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error("Error fetching models from the database:", fetchError);
      return;
    }

    console.log(`Found ${models.length} models to update.`);

    if (models.length > 0) {
      const updatePromises = models.map((model) => updateModelRuns(model));
      await Promise.all(updatePromises);
    }

    start += limit;
    hasMoreData = start < count;
  }

  console.log("Finished updating model runs.");
}

// Automatically call updateRuns when this script is executed
updateRuns();
