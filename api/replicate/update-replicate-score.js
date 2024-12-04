import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const replicateApiKey = process.env.REPLICATE_API_KEY;

async function updateModelRuns(model) {
  console.log(
    `Updating runs for model: ${model.creator}/${model.modelName} (ID: ${model.id})`
  );

  try {
    console.log(
      `Fetching data from Replicate API for model: ${model.creator}/${model.modelName}`
    );
    const response = await axios.get(
      `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}`,
      {
        headers: {
          Authorization: `Token ${replicateApiKey}`,
        },
      }
    );

    const runCount = response.data.run_count || 0;
    const currentTimestamp = new Date().toISOString();
    console.log(`Fetched run count: ${runCount}`);

    console.log(`Updating database for model ID: ${model.id}`);
    const { error: updateError } = await supabase
      .from("modelsData")
      .update({
        replicateScore: runCount,
        lastUpdated: currentTimestamp,
      })
      .eq("platform", "replicate")
      .eq("id", model.id);

    if (updateError) {
      console.error(
        `Failed to update runs for model ${model.creator}/${model.modelName} (ID: ${model.id}) due to:`,
        updateError
      );
    } else {
      console.log(
        `Successfully updated replicateScore and lastUpdated for model: ${model.creator}/${model.modelName} (ID: ${model.id})`
      );
    }
  } catch (error) {
    console.error(
      `Failed to fetch data for model ${model.creator}/${model.modelName} from Replicate API due to:`,
      error.message
    );
    console.error(`Error details:`, error.response?.data || error);
  }
}

export async function updateRuns() {
  console.log("Initiating the updateRuns process...");

  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    console.log(
      `Fetching models from database (start: ${start}, limit: ${limit})`
    );

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

    console.log(
      `Query returned ${models.length} models out of total ${count}.`
    );
    console.log(
      `Models retrieved: ${JSON.stringify(
        models.map((m) => m.id),
        null,
        2
      )}`
    );

    if (models.length > 0) {
      console.log(`Updating ${models.length} models...`);
      const updatePromises = models.map((model) => updateModelRuns(model));
      await Promise.all(updatePromises);
    } else {
      console.log("No models found in this batch.");
    }

    start += limit;
    hasMoreData = start < count;
    console.log(`Pagination: start=${start}, hasMoreData=${hasMoreData}`);
  }

  console.log("Finished updating model runs.");
}

// Automatically call updateRuns when this script is executed
updateRuns();
