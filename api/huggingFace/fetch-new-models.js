import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import LinkHeader from "http-link-header";
import slugify from "slugify";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function generateSlug(creator, modelName) {
  const slugifiedCreator = slugify(creator, { lower: true, strict: true });
  const slugifiedModelName = slugify(modelName, { lower: true, strict: true });
  return `${slugifiedModelName}-${slugifiedCreator}`;
}

async function fetchModelData(url) {
  const modelsResponse = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.HUGGINGFACE_API_TOKEN}`,
    },
  });
  const linkHeader = modelsResponse.headers.get("Link");
  const modelsData = await modelsResponse.json();
  let nextUrl = null;
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
  let huggingFaceBaseUrl =
    "https://huggingface.co/api/models?sort=likes&limit=5&full=true&config=true";
  while (huggingFaceBaseUrl) {
    const { modelsData, nextUrl } = await fetchModelData(huggingFaceBaseUrl);
    huggingFaceBaseUrl = nextUrl;
    for (const modelData of modelsData) {
      if (modelData.likes < 5) {
        console.log(
          "Reached a model with less than 5 likes, finishing the script."
        );
        return;
      }
      const parts = modelData.id.split("/");
      const creator = parts.length > 1 ? parts[0] : "HuggingFace";
      const modelName = parts.length > 1 ? parts[1] : modelData.id;

      const { data: existingModels, error: fetchError } = await supabase
        .from("modelsData")
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
        continue;
      }
      const tags = modelData.pipeline_tag;
      const huggingFaceScore = modelData.likes;
      const modelUrl = `https://huggingface.co/${modelData.id}`;
      const slug = generateSlug(creator, modelName);

      const { error: upsertError } = await supabase.from("modelsData").upsert([
        {
          creator: creator,
          modelName: modelName,
          huggingFaceScore: huggingFaceScore,
          lastUpdated: new Date().toISOString(),
          platform: "huggingFace",
          modelUrl: modelUrl,
          indexedDate: new Date().toISOString(),
          slug: slug || `${modelData.owner}-${modelData.name}`,
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
