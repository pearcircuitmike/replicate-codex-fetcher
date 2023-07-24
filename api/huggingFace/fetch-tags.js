import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cheerio from "cheerio";
import got from "got";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function fetchTags() {
  const huggingFaceBaseUrl = "https://huggingface.co";
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("modelUrl, id")
      .or("tags.eq.")
      .range(start, start + limit - 1);

    console.log(models.length);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models without tags were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + models.length}`);

      for (const model of models) {
        const modelUrl = model.modelUrl;
        console.log(modelUrl);

        try {
          const modelSpecificEndpoint = modelUrl.replace(
            huggingFaceBaseUrl,
            `${huggingFaceBaseUrl}/api/models`
          );
          console.log(modelSpecificEndpoint);
          const modelSpecificResponse = await got(modelSpecificEndpoint);
          const modelSpecificData = JSON.parse(modelSpecificResponse.body);
          const tags = modelSpecificData.pipeline_tag
            ? modelSpecificData.pipeline_tag
            : null;

          const currentDate = new Date();
          const formattedDate = `${
            currentDate.getMonth() + 1
          }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
            -2
          )}`; // M/DD/YY

          const { error: updateError } = await supabase
            .from("huggingFaceModelsData")
            .update({ tags: tags, lastUpdated: formattedDate })
            .eq("id", model.id);

          if (updateError) {
            console.error(`Failed to update model ${model.id}:`, updateError);
          } else {
            console.log(`Updated model ${model.id} with tags`);
          }
        } catch (error) {
          console.error(
            `Failed to fetch or parse tags for model ${model.id}:`,
            error
          );
        }
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

fetchTags();
