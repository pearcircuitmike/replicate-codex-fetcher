import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveRunsHistory() {
  try {
    const { data: models, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("id, runs");

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (!models || models.length === 0) {
      console.log("No models data available in the modelsData table.");
      return;
    }

    for (const model of models) {
      const { data: runsHistoryData, error: runsHistoryError } = await supabase
        .from("runsHistory")
        .select("timestamp")
        .eq("modelId", model.id)
        .order("timestamp", { ascending: false })
        .limit(1);

      if (runsHistoryError) {
        console.error(runsHistoryError);
        continue;
      }

      const latestTimestamp =
        runsHistoryData && runsHistoryData[0]
          ? runsHistoryData[0].timestamp
          : null;

      if (
        latestTimestamp &&
        new Date() - new Date(latestTimestamp) < 24 * 60 * 60 * 1000
      ) {
        console.log(
          `Skipping new runs history data for model ID ${model.id} because it is within 24 hours.`
        );
        continue;
      }

      console.log(`Inserting new runs history data for model ID ${model.id}`);
      const { error: insertError } = await supabase.from("runsHistory").insert([
        {
          modelId: model.id,
          timestamp: new Date(),
          runs: model.runs,
        },
      ]);

      if (insertError) {
        console.error(insertError);
      }
    }

    console.log("Runs history data saved successfully.");
  } catch (error) {
    console.error("Failed to save runs history data:", error);
  }
}

saveRunsHistory();
