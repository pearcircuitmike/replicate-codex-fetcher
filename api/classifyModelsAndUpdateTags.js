import { createClient } from "@supabase/supabase-js";
import got from "got";
import dotenv from "dotenv";
dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const types = ["Text", "Image", "Audio", "Video"];
const classificationCategories = types.flatMap((fromType) =>
  types.map((toType) => `${fromType}-to-${toType}`)
);

async function classifyModelsAndUpdateTags() {
  // Log the values of the environment variables
  console.log(`OpenAI API Key: ${openaiApiKey}`);
  console.log(`Supabase URL: ${supabaseUrl}`);
  console.log(`Supabase Key: ${supabaseKey}`);

  const { data: models, error: fetchError } = await supabase
    .from("modelsData")
    .select("*")
    .filter("tags", "eq", "");

  // Log the result of the initial query
  console.log(`Number of models fetched: ${models.length}`);
  console.log(`Error in fetching models: ${fetchError}`);

  if (fetchError) {
    console.error(fetchError);
    return;
  }

  for (const model of models) {
    const description = model.description ?? "No description provided.";
    const prompt = `Classify the following model into one of the specified
     categories, based on your best guess. You must choose a 
     category and you must respond exactly with the classification and 
     no other words. For example, you can respond "Image-to-Image",
      "Text-to-Image", etc
    Categories: ${classificationCategories.join(", ")}
    Model: ${model.modelName}
    Description: ${description}
    
    Classification: `;

    console.log(`Prompt: ${prompt}`); // Log the prompt

    try {
      const response = await got
        .post("https://api.openai.com/v1/engines/davinci/completions", {
          json: { prompt, max_tokens: 10 },
          headers: { Authorization: `Bearer ${openaiApiKey}` },
        })
        .json();

      // Clean up the GPT-3 response by removing non-alphanumeric characters and trimming extra spaces
      const category = response.choices[0]?.text
        .replace(/[^\w\s-]/g, "")
        .trim();
      console.log(`GPT-3 Response: ${category}`); // Log cleaned GPT-3 response

      if (classificationCategories.includes(category)) {
        const { error: updateError } = await supabase
          .from("modelsData")
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

classifyModelsAndUpdateTags();
