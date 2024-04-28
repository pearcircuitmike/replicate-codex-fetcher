import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const huggingFaceApiToken = process.env.HUGGINGFACE_API_TOKEN;

async function updateModelLikes(model) {
  console.log(`Updating likes for model: ${model.creator}/${model.modelName}`);
  try {
    const response = await axios.get(
      `https://huggingface.co/api/models/${model.creator}/${model.modelName}`,
      {
        headers: {
          Authorization: `Bearer ${huggingFaceApiToken}`,
        },
      }
    );

    const currentTimestamp = new Date().toISOString();
    const newLikesCount = response.data.likes;

    const { error: updateError } = await supabase
      .from("modelsData")
      .update({
        huggingFaceScore: newLikesCount,
        lastUpdated: currentTimestamp,
      })
      .eq("platform", "huggingFace")
      .eq("id", model.id);

    if (updateError) {
      console.error(
        `Failed to update likes for model ${model.creator}/${model.modelName} due to:`,
        updateError
      );
    } else {
      console.log(
        `Successfully updated likes and lastUpdated for model ${model.creator}/${model.modelName}`
      );
      console.log(
        `New likes count for ${model.creator}/${model.modelName}: ${newLikesCount}`
      );
    }
  } catch (error) {
    console.error(
      `Failed to fetch model ${model.creator}/${model.modelName} from API due to:`,
      error.message
    );
  }
}

async function fetchModelsFromDatabase() {
  console.log("Fetching models from the database...");
  const { data: models, error: fetchError } = await supabase
    .from("modelsData")
    .select("id, creator, modelName, lastUpdated")
    .eq("platform", "huggingFace")
    .lt(
      "lastUpdated",
      new Date(Date.now() - 0.5 * 24 * 60 * 60 * 1000).toISOString()
    ); // 12 hrs

  if (fetchError) {
    console.error("Error fetching models from the database:", fetchError);
    return;
  }

  console.log(`Found ${models.length} models to update.`);

  for (const model of models) {
    await updateModelLikes(model);
  }

  console.log("Finished updating model likes.");
}

export function updateLikes() {
  console.log("Initiating the updateLikes process...");
  fetchModelsFromDatabase();
}

// Automatically call updateLikes when this script is executed
updateLikes();
