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

export async function updateLikes() {
  console.log("Initiating the updateLikes process...");

  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("modelsData")
      .select("id, creator, modelName, indexedDate")
      .eq("platform", "huggingFace")
      .gte(
        "indexedDate",
        new Date(new Date().getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
      )
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error("Error fetching models from the database:", fetchError);
      return;
    }

    console.log(`Found ${models.length} models to update.`);

    if (models.length === 0) {
      hasMoreData = false;
    } else {
      const updatePromises = models.map((model) => updateModelLikes(model));
      await Promise.all(updatePromises);

      start += limit;
    }
  }

  console.log("Finished updating model likes.");
}
