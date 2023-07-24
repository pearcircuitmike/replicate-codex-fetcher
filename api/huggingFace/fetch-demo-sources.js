import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cheerio from "cheerio";
import got from "got";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function fetchDemoSources() {
  const huggingFaceBaseUrl = "https://huggingface.co";
  const limit = 1000;
  let start = 0;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("modelUrl, id, demoSources")
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models were found");
      return;
    }

    for (const model of models) {
      if (model.demoSources === null || model.demoSources.length === 0) {
        const modelUrl = model.modelUrl;

        try {
          const modelSpecificEndpoint = modelUrl.replace(
            huggingFaceBaseUrl,
            `${huggingFaceBaseUrl}/api/models`
          );
          const modelSpecificResponse = await got(modelSpecificEndpoint);
          const modelSpecificData = JSON.parse(modelSpecificResponse.body);
          let spaces = modelSpecificData.spaces || [];
          spaces = spaces.map((space) => space.replace(/\//g, "-"));

          const currentDate = new Date();
          const formattedDate = `${
            currentDate.getMonth() + 1
          }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
            -2
          )}`; // M/DD/YY

          const { error: updateError } = await supabase
            .from("huggingFaceModelsData")
            .update({ demoSources: spaces, lastUpdated: formattedDate })
            .eq("id", model.id);

          if (updateError) {
            console.error(
              `Failed to update demo sources for model ${model.id}:`,
              updateError
            );
          } else {
            console.log(
              `Updated demo sources for model ${model.id} with ${spaces.length} sources`
            );
          }
        } catch (error) {
          console.error(
            `Failed to fetch or update demo sources for model ${model.id}:`,
            error
          );
        }
      }
    }

    start += limit;
    console.log(`Processed models up to ${start}`);

    if (models.length < limit) {
      hasMoreData = false;
    }
  }

  console.log("Job completed");
}

fetchDemoSources();
