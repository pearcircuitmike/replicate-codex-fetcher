import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Define your Supabase URL and key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveRunsHistory() {
  try {
    // Fetch all models from the modelsData table
    const { data: models, error: fetchError } = await supabase
      .from("combinedModelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Check if models data is available
    if (!models || models.length === 0) {
      console.log("No models data available in the modelsData table.");
      return;
    }

    for (const model of models) {
      // Check for the latest entry for the model in the runsHistory table
      const { data: runsHistoryData, error: runsHistoryError } = await supabase
        .from("runsHistory")
        .select("*")
        .eq("modelId", model.id)
        .order("timestamp", { ascending: false })
        .limit(1);

      if (runsHistoryError) {
        throw runsHistoryError;
      }

      const latestTimestamp =
        runsHistoryData && runsHistoryData[0]
          ? runsHistoryData[0].timestamp
          : null;

      // Skip adding records if the latest timestamp is within 24 hours of the current time
      if (
        latestTimestamp &&
        new Date() - new Date(latestTimestamp) < 24 * 60 * 60 * 1000
      ) {
        console.log(
          `Skipping new runs history data for model ID ${model.id} because it is within 24 hours.`
        );
        continue;
      }

      // Insert new runs history data
      console.log(
        `Inserting new runs history data for model ID ${model.id} named ${model.modelName}`
      );
      const { error: insertError } = await supabase.from("runsHistory").insert([
        {
          modelId: model.id,
          timestamp: new Date(),
          runs: model.runs,
        },
      ]);

      if (insertError) {
        throw insertError;
      }
    }

    console.log("Runs history data saved successfully.");
  } catch (error) {
    console.error("Failed to save runs history data:", error.message);
    if (error.data && error.data.length > 0) {
      for (const entry of error.data) {
        console.error("Error occurred for entry ID:", entry.id);
        console.error("Model ID of the entry:", entry.modelId);
      }
    }
  }
}

// Call the saveRunsHistory function to collect and store the history data
saveRunsHistory();
