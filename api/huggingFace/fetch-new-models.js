import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import LinkHeader from "http-link-header";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const huggingFaceApiToken = process.env.HUGGINGFACE_API_TOKEN;

/**
 * normalizeName
 * 1) Trim whitespace
 * 2) Strip leading/trailing punctuation
 * 3) Replace underscores/spaces/hyphens with a single '-'
 * 4) Convert to lowercase
 * 5) Preserve decimals and version text
 */
function normalizeName(name) {
  // 1) Trim whitespace
  let output = name.trim();

  // 2) Strip leading or trailing punctuation
  output = output.replace(/^[^\w\d]+|[^\w\d]+$/g, "");

  // 3) Convert underscores/spaces/hyphens to a single dash
  output = output.replace(/[\s\-_]+/g, "-");

  // 4) Lowercase for comparison
  output = output.toLowerCase();

  return output;
}

/**
 * fetchModelData
 * Grabs the next page of model data from Hugging Face
 */
async function fetchModelData(url) {
  const modelsResponse = await fetch(url, {
    method: "GET",
    // Removed authorization headers
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

/**
 * fetchNewModels
 * Loops over Hugging Face listings, inserts new records if not found by slug+platform.
 */
export async function fetchNewModels() {
  let huggingFaceBaseUrl =
    "https://huggingface.co/api/models?sort=likes&limit=5&full=true&config=true";

  while (huggingFaceBaseUrl) {
    const { modelsData, nextUrl } = await fetchModelData(huggingFaceBaseUrl);
    huggingFaceBaseUrl = nextUrl;

    for (const modelData of modelsData) {
      // If likes < 45, stop processing
      if (modelData.likes < 45) {
        console.log(
          "Reached a model with less than 45 likes, finishing the script."
        );
        return;
      }

      // Extract creator/modelName from 'id'
      const parts = modelData.id.split("/");
      const creator = parts.length > 1 ? parts[0] : "HuggingFace";
      const modelName = parts.length > 1 ? parts[1] : modelData.id;
      const huggingFaceScore = modelData.likes;
      const modelUrl = `https://huggingface.co/${modelData.id}`;

      // Normalize for slug
      const normalizedCreator = normalizeName(creator);
      const normalizedModelName = normalizeName(modelName);
      const slug = `${normalizedModelName}-${normalizedCreator}`;

      // Check for existing record by slug+platform
      const { data: existing, error: checkError } = await supabase
        .from("modelsData")
        .select("id")
        .eq("slug", slug)
        .eq("platform", "huggingFace");

      if (checkError) {
        console.error("Error checking existing models:", checkError);
        return;
      }

      if (existing && existing.length > 0) {
        // Already have a model for this slug/platform
        console.log(`Model with slug=${slug} already exists, skipping.`);
        continue;
      }

      // Insert (not upsert) a new record
      const { error: insertError } = await supabase.from("modelsData").insert([
        {
          creator: creator, // store raw
          modelName: modelName, // store raw
          huggingFaceScore: huggingFaceScore,
          lastUpdated: new Date().toISOString(),
          platform: "huggingFace",
          modelUrl: modelUrl,
          indexedDate: new Date().toISOString(),
          slug: slug, // store normalized slug
        },
      ]);

      if (insertError) {
        console.error(
          `Failed to insert model ${creator}/${modelName}:`,
          insertError
        );
      } else {
        console.log(
          `Inserted new model ${creator}/${modelName} (slug=${slug}).`
        );
      }
    }
  }
}

// If you want this file to run on its own:
fetchNewModels().catch((err) => console.error("Error in fetchNewModels:", err));
