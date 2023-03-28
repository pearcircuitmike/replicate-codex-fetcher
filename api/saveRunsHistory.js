import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// Define your Supabase URL and key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function saveRunsHistory() {
  try {
    // Fetch all models from the modelsData table
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("*");

    if (fetchError) {
      throw fetchError;
    }

    // Check if models data is available
    if (!models || models.length === 0) {
      console.log("No models data available in the modelsData table.");
      return;
    }

    // Get the current date and time
    const currentDate = new Date();
    // Calculate the date and time 24 hours before the current time
    const oneDayBefore = new Date(currentDate.getTime() - 24 * 60 * 60 * 1000);

    for (const model of models) {
      // Check for the latest entry for the model in the runsHistory table
      const { data: runsHistoryData, error: runsHistoryError } = await supabase
        .from("runsHistory")
        .select("*")
        .eq("model_id", model.id)
        .order("timestamp", { ascending: false })
        .limit(1);

      if (runsHistoryError) {
        throw runsHistoryError;
      }

      if (
        runsHistoryData &&
        runsHistoryData.length > 0 &&
        new Date(runsHistoryData[0].timestamp) >= oneDayBefore
      ) {
        // Update the existing runs history data
        console.log(
          `Updating existing runs history data for model ID ${model.id}`
        );
        const { error: updateError } = await supabase
          .from("runsHistory")
          .update({ runs: model.runs })
          .eq("id", runsHistoryData[0].id);

        if (updateError) {
          throw updateError;
        }
      } else {
        // Insert new runs history data
        console.log(`Inserting new runs history data for model ID ${model.id}`);
        const { error: insertError } = await supabase
          .from("runsHistory")
          .insert([
            {
              model_id: model.id,
              timestamp: currentDate,
              runs: model.runs,
            },
          ]);

        if (insertError) {
          throw insertError;
        }
      }
    }

    console.log("Runs history data saved successfully.");
  } catch (error) {
    console.error("Failed to save runs history data.", error.message);
  }
}

// Call the saveRunsHistory function to collect and store the history data
saveRunsHistory();
