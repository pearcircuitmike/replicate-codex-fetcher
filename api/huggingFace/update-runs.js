import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function updateRuns() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("id, creator, modelName")
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + models.length}`);

      for (const model of models) {
        const { creator, modelName } = model;
        const apiUrl =
          creator.toLowerCase() === "huggingface"
            ? `https://huggingface.co/api/models/${modelName}`
            : `https://huggingface.co/api/models/${creator}/${modelName}`;

        try {
          const response = await fetch(apiUrl);
          const json = await response.json();
          const runs = json.downloads;

          if (typeof runs !== "number") {
            console.error(`Failed to parse runs for model ${model.id}`);
            continue;
          }

          const currentDate = new Date();
          const formattedDate = `${
            currentDate.getMonth() + 1
          }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
            -2
          )}`; // M/DD/YY

          const { error: updateError } = await supabase
            .from("huggingFaceModelsData")
            .update({ runs: runs, lastUpdated: formattedDate })
            .eq("id", model.id);

          if (updateError) {
            console.error(`Failed to update model ${model.id}:`, updateError);
          } else {
            console.log(`Updated model ${model.id} with runs`);
          }
        } catch (error) {
          console.error(`Failed to fetch runs for model ${model.id}:`, error);
        }
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

updateRuns();
