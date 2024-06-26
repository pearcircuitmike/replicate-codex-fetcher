import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import slugify from "slugify";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const replicateApiKey = process.env.REPLICATE_API_KEY;

function generateSlug(creator, modelName) {
  const slugifiedCreator = slugify(creator, { lower: true, strict: true });
  const slugifiedModelName = slugify(modelName, { lower: true, strict: true });
  return `${slugifiedModelName}-${slugifiedCreator}`;
}

async function checkAndUpsertModel(data) {
  if (data.run_count < 1000) {
    console.log(
      `Skipping model ${data.owner}/${data.name} with ${data.run_count} runs (less than 1000)`
    );
    return;
  }

  const currentDate = new Date().toISOString();
  const slug = generateSlug(data.owner, data.name);

  const { data: existingModel, error: selectError } = await supabase
    .from("modelsData")
    .select("id")
    .eq("creator", data.owner)
    .eq("modelName", data.name)
    .eq("platform", "replicate")
    .single();

  if (selectError && selectError.code !== "PGRST116") {
    console.error(
      `Failed to check existing model ${data.owner}/${data.name}:`,
      selectError
    );
    return;
  }

  if (existingModel) {
    const { error: updateError } = await supabase
      .from("modelsData")
      .update({
        replicateScore: data.run_count,
        lastUpdated: currentDate,
        description: data.description,
        modelUrl: data.url,
        githubUrl: data.github_url,
        paperUrl: data.paper_url,
        licenseUrl: data.license_url,
        slug: slug,
      })
      .eq("id", existingModel.id)
      .eq("platform", "replicate");

    if (updateError) {
      console.error(
        `Failed to update model ${data.owner}/${data.name}:`,
        updateError
      );
    } else {
      console.log(`Updated model ${data.owner}/${data.name}`);
    }
  } else {
    const { error: insertError } = await supabase.from("modelsData").insert([
      {
        creator: data.owner,
        modelName: data.name,
        replicateScore: data.run_count,
        lastUpdated: currentDate,
        platform: "replicate",
        description: data.description,
        example: data.cover_image_url,
        modelUrl: data.url,
        githubUrl: data.github_url,
        paperUrl: data.paper_url,
        licenseUrl: data.license_url,
        indexedDate: currentDate,
        slug: slug || `${data.owner}-${data.name}`, // Fallback to a default slug if it's null or undefined
      },
    ]);

    if (insertError) {
      console.error(
        `Failed to insert model ${data.owner}/${data.name}:`,
        insertError
      );
    } else {
      console.log(`Inserted model ${data.owner}/${data.name}`);
    }
  }
}

export async function fetchNewModels() {
  let nextURL = "https://api.replicate.com/v1/models";

  while (nextURL) {
    try {
      const response = await axios.get(nextURL, {
        headers: {
          Authorization: `Token ${replicateApiKey}`,
        },
      });

      const models = response.data.results;

      for (const model of models) {
        await checkAndUpsertModel(model);
      }

      // Update the nextURL if "next" is present in the response for pagination
      nextURL = response.data.next;
    } catch (error) {
      console.error(
        "Failed to fetch new models from API. Error:",
        error.message
      );
      break;
    }
  }
}

fetchNewModels();
