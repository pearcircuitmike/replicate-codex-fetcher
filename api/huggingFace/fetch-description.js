import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import cheerio from "cheerio";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function fetchDescription() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("modelUrl, id")
      .or("description.is.null,description.eq.")
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models without descriptions were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + models.length}`);

      for (const model of models) {
        const modelUrl = model.modelUrl;

        try {
          const response = await fetch(modelUrl);
          const body = await response.text();
          const $ = cheerio.load(body);
          let content = "";

          $(".prose.pl-6.-ml-6.hf-sanitized")
            .children("p, h1, h2, h3, ul, li, ol")
            .each(function () {
              content += $(this).text() + "\n\n";
            });

          if (content.trim() === "") {
            content = "Platform did not provide a description for this model.";
          }
          console.log(content);

          const currentDate = new Date();
          const formattedDate = `${
            currentDate.getMonth() + 1
          }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
            -2
          )}`; // M/DD/YY

          const { error: updateError } = await supabase
            .from("huggingFaceModelsData")
            .update({ description: content, lastUpdated: formattedDate })
            .eq("id", model.id);

          if (updateError) {
            console.error(`Failed to update model ${model.id}:`, updateError);
          } else {
            console.log(`Updated model ${model.id} with description`);
          }
        } catch (error) {
          console.error(
            `Failed to fetch or parse description for model ${model.id}:`,
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

fetchDescription();
