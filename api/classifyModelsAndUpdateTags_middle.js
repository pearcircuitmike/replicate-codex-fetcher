import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Replicate from "replicate";
import fetch from "cross-fetch";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
  fetch: fetch,
});

const types = ["Text", "Image", "Audio", "Video"];
const classificationCategories = types.flatMap((fromType) =>
  types.map((toType) => `${fromType}-to-${toType}`)
);

export async function classifyModelsAndUpdateTags_middle() {
  const { data: models, error: fetchError } = await supabase
    .from("replicateModelsData_test")
    .select("*")
    .filter("tags", "eq", "");

  if (fetchError) {
    console.error(fetchError);
    return;
  }
  for (const model of models) {
    const modelUrl = `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}`;
    const modelData = await replicate.models.get(
      model.creator,
      model.modelName
    );

    const modelDefaultExample = modelData.default_example;

    const modelVersion = await replicate.models.versions.get(
      model.creator,
      model.modelName,
      modelData.latest_version.id
    );

    const openAPIInputSchema =
      modelVersion.openapi_schema.components.schemas.Input.properties;

    const openAPIOutputSchema =
      modelVersion.openapi_schema.components.schemas.Output;

    console.log(modelVersion.openapi_schema.components.schemas);

    const description = model.description ?? "No description provided.";
    const prompt = `Classify the following model into one of the specified
    categories based on the inputs and outputs. 
         You must respond exactly with the category and 
    no other words. For example, you can respond "Image-to-Image",
     "Text-to-Image", etc - you SHOULD NOT REPLY WITH ANYTHING ELSE. 

        Rules:

   Response must be of the form: Input-to-Output

   You must first read the description. 
   
   If the answer is in the description, provide it. Otherwise...

   For input:
   You must choose "video" if you see a word that says "video". Otherwise,you can NEVER choose video.
   You must choose "audio" if you see a word that says "speech" or "sound" or "music" or "speaker" or "audio". Otherwise, you can NEVER choose audio.
   You must choose"text" if you do NOT see any references to images mentioned in the schema, or if you see the word "prompt"
   Otherwise, you must choose "image".

   For output:
   You must choose "video" if you see a word that says "video". Otherwise,you can NEVER choose video.
   You must choose "audio" if you see a word that says "speech" or "sound" or "music" or "speaker" or "audio". Otherwise, you can NEVER choose audio.
   You must choose "text" if you do NOT see any references to images mentioned in the schema.
   Otherwise, you must choose "image".



   You may not choose any other categories besides those listed.

   Categories: ${classificationCategories.join(", ")}
   Description: ${description}
   Model: ${model.modelName}
   Model Input Schema: ${JSON.stringify(openAPIInputSchema)}
   Model Output Schema: ${JSON.stringify(openAPIOutputSchema)}
   Model Example Generation: ${JSON.stringify(modelDefaultExample)}

   Category: `;

    console.log(`Prompt: ${prompt}`); // Log the prompt for debugging purposes

    try {
      const response = await replicate.run(
        "replicate/flan-t5-xl:7a216605843d87f5426a10d2cc6940485a232336ed04d655ef86b91e020e9210",
        {
          input: {
            prompt: `${prompt}`,
          },
        }
      );

      console.log(response[0]); // Log the response for debugging

      const category = response[0];

      if (classificationCategories.includes(category)) {
        const { error: updateError } = await supabase
          .from("replicateModelsData_test")
          .update({ tags: category })
          .match({ id: model.id });

        if (updateError) {
          console.error(`Failed to update model ID ${model.id}:`, updateError);
        } else {
          console.log(
            `Updated model ID ${model.id} with category: ${category}`
          );
        }
      } else {
        console.log(`Invalid category: ${category}`);
      }
    } catch (err) {
      console.error(err);
    }
  }
}

classifyModelsAndUpdateTags_middle();
