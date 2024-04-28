import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const turndownService = new TurndownService();

export async function fetchDescription() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("modelUrl, id")
      .eq("platform", "huggingFace")
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
          const response = await axios.get(modelUrl);
          const dom = new JSDOM(response.data);

          const descriptionElement = dom.window.document.evaluate(
            "/html/body/div[1]/main/div[2]/section[1]/div[3]/div[3]",
            dom.window.document,
            null,
            dom.window.XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;

          let content = "";
          if (descriptionElement) {
            const descriptionHtml = descriptionElement.innerHTML.trim();
            content = turndownService.turndown(descriptionHtml);
          }

          if (content.trim() === "") {
            content = "Platform did not provide a description for this model.";
          }

          // Remove or replace any non-valid characters using a regular expression
          const sanitizedContent = content.replace(
            /[^\x09\x0A\x0D\x20-\x7E]/g,
            ""
          );

          console.log(sanitizedContent);

          const currentDate = new Date();
          const timestamptz = currentDate.toISOString();

          const { error: updateError } = await supabase
            .from("modelsData")
            .update({ description: sanitizedContent, lastUpdated: timestamptz })
            .eq("platform", "huggingFace")
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
