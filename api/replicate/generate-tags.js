import { createClient } from "@supabase/supabase-js";
import got from "got";
import dotenv from "dotenv";
import Replicate from "replicate";
import { Configuration, OpenAIApi } from "openai";

dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

const configuration = new Configuration({
  apiKey: openaiApiKey,
});

const openai = new OpenAIApi(configuration);

const types = ["Text", "Image", "Audio", "Video"];
const classificationCategories = types.flatMap((fromType) =>
  types.map((toType) => `${fromType}-to-${toType}`)
);

export async function generateTags() {
  const { data: models, error: fetchError } = await supabase
    .from("replicateModelsData_NEW")
    .select("*")
    .or("tags.eq.,tags.is.null");

  console.log(models);

  if (fetchError) {
    console.error(fetchError);
    return;
  }

  for (const model of models) {
    const modelUrl = `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}`;
    const modelResponse = await fetch(modelUrl, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
      },
    });
    const modelData = await modelResponse.json();
    const versionId = modelData.latest_version?.id;

    const versionUrl = `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}/versions/${versionId}`;
    const response = await fetch(versionUrl, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
      },
    });
    const responseData = await response.json();

    const openAPIInputSchema = responseData.openapi_schema?.components?.schemas
      ?.Input.properties
      ? responseData.openapi_schema.components.schemas.Input.properties
      : "";
    const openAPIOutputSchema = responseData.openapi_schema?.components?.schemas
      ?.Output
      ? responseData.openapi_schema.components.schemas.Output
      : "";

    console.log(openAPIInputSchema);

    const description = model.description ?? "No description provided.";
    const prompt = `Classify the following model into one of the specified
     categories based on the inputs and outputs. 
          You must respond exactly with the category and 
     no other words. For example, you can respond "Image-to-Image",
      "Text-to-Image", etc - you SHOULD NOT REPLY WITH ANYTHING ELSE. 

         Rules:

    Response must be of the form: Input-to-Output

    You must first read the description. 
    Description: ${description}
    
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

    Categories: ${classificationCategories.join(", ")}

    You may not choose any other categories besides those listed.

    Model: ${model.modelName}
    Model Input Schema: ${JSON.stringify(openAPIInputSchema)}
    Model Output Schema: ${JSON.stringify(openAPIOutputSchema)}
    

    Category: `;

    console.log(`Prompt: ${prompt}`); // Log the prompt for debugging purposes

    try {
      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [{ role: "system", content: prompt }],
      });

      // Clean up the GPT-3 response by removing non-alphanumeric characters and trimming extra spaces
      const category = response.data.choices[0].message.content
        .replace(/[^\w\s-]/g, "")
        .trim();
      console.log(`GPT-3 Response: ${category}`);

      if (classificationCategories.includes(category)) {
        const { error: updateError } = await supabase
          .from("replicateModelsData_NEW")
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

generateTags();
