import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Define your Supabase URL and key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function saveCostToRunHistory() {
  try {
    // Fetch all models from the modelsData table
    const { data: models, error: fetchError } = await supabase
      .from("replicateModelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Check if models data is available
    if (!models || models.length === 0) {
      console.log("No models data available in the replicateModelsData table.");
      return;
    }

    for (const model of models) {
      // Check for the latest entry for the model in the costToRunHistory table
      const { data: costToRunHistoryData, error: costToRunHistoryError } =
        await supabase
          .from("costToRunHistory")
          .select("*")
          .eq("modelId", model.id)
          .order("timestamp", { ascending: false })
          .limit(1);

      if (costToRunHistoryError) {
        throw costToRunHistoryError;
      }

      // Insert new costToRun history data
      console.log(
        `Inserting new costToRun history data for model ID ${model.id}`
      );
      const { error: insertError } = await supabase
        .from("costToRunHistory")
        .insert([
          {
            modelId: model.id,
            timestamp: new Date(),
            cost_to_run: model.costToRun,
          },
        ]);

      if (insertError) {
        throw insertError;
      }
    }

    console.log("CostToRun history data saved successfully.");
  } catch (error) {
    console.error("Failed to save costToRun history data.", error.message);
  }
}

// Call the saveCostToRunHistory function to collect and store the history data
saveCostToRunHistory();
