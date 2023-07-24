import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Configuration } from "openai";
import LinkHeader from "http-link-header"; // Add this line

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const configuration = new Configuration({
  apiKey: process.env.OPENAI_SECRET_KEY,
});

async function fetchModelData(url) {
  const modelsResponse = await fetch(url);
  const linkHeader = modelsResponse.headers.get("Link");
  const modelsData = await modelsResponse.json();

  let nextUrl = null;

  // Check if Link header exists
  if (linkHeader) {
    const link = LinkHeader.parse(linkHeader);
    const nextLink = link.get("rel", "next");
    if (nextLink.length > 0) {
      nextUrl = nextLink[0].uri;
    }
  }

  return { modelsData, nextUrl };
}

export async function fetchNewModels() {
  let huggingFaceBaseUrl = "https://huggingface.co/api/models";
  while (huggingFaceBaseUrl) {
    const { modelsData, nextUrl } = await fetchModelData(huggingFaceBaseUrl);
    huggingFaceBaseUrl = nextUrl;
    const currentDate = new Date();
    const formattedDate = `${
      currentDate.getMonth() + 1
    }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(-2)}`; // M/DD/YY

    for (const modelData of modelsData) {
      let [creator, modelName] = modelData.id.split("/");
      if (!modelName) {
        modelName = creator;
        creator = "huggingface";
      }

      const { data: existingModels, error: fetchError } = await supabase
        .from("huggingFaceModelsData")
        .select("creator, modelName, id")
        .eq("creator", creator)
        .eq("modelName", modelName);

      if (fetchError) {
        console.error(fetchError);
        return;
      }

      if (existingModels.length > 0) {
        console.log(
          `Existing model already exists for ${creator}/${modelName}, skipping insertion`
        );
        continue; // Skip to next iteration if a model already exists
      }

      const tags = modelData.pipeline_tag; // Use the pipeline_tag as the tag
      const runs = modelData.downloads;

      const modelUrl =
        creator === "huggingface"
          ? `https://huggingface.co/api/models/${modelName}`
          : `https://huggingface.co/api/models/${creator}/${modelName}`;

      const { error: upsertError } = await supabase
        .from("huggingFaceModelsData")
        .upsert([
          {
            creator: creator,
            modelName: modelName,
            tags: "", // tags handled in another script
            runs: runs,
            lastUpdated: formattedDate,
            platform: "huggingFace",
            description: "", // Leave the description blank
            demoSources: [], // demosources handled in another script
            modelUrl: modelUrl,
            indexedDate: formattedDate, // Set indexedDate to the current date
          },
        ]);

      if (upsertError) {
        console.error(
          `Failed to upsert model ${creator}/${modelName}:`,
          upsertError
        );
      } else {
        console.log(`Upserted model ${creator}/${modelName} with tag: ${tags}`);
      }
    }
  }
}

fetchNewModels();
