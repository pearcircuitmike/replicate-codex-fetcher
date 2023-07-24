import { createClient } from "@supabase/supabase-js";
import { Configuration, OpenAIApi } from "openai";
import dotenv from "dotenv";

dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const configuration = new Configuration({
  apiKey: openaiApiKey,
});
const openai = new OpenAIApi(configuration);

export async function generateUseCase() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("replicateModelsData")
      .select("id, description, modelName, generatedSummary, tags")
      .or("generatedUseCase.is.null,generatedUseCase.eq.''")
      .not("description", "eq", null)
      .not("description", "eq", "")
      .gte("runs", 5000) // lower to expand to more models, but for now just generate for most popular
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models without generated use case were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + models.length}`);

      for (const model of models) {
        const { modelName, description, generatedSummary, tags } = model;
        console.log(modelName);

        let generatedUseCase = "";

        const prompt = `Write a concise overview in the style of Paul Graham in paragraph form (not a list) covering some possible use cases for this AI model for a technical audience and speculate on some possible products or practical uses of this model: ${modelName}\nTags: ${tags}\nDescription provided by the creator: ${description}\nSummary: ${generatedSummary}\nUse cases:`;
        const response = await openai.createChatCompletion({
          model: "gpt-3.5-turbo",
          messages: [{ role: "system", content: prompt }],
        });
        // console.log(prompt);

        generatedUseCase = response.data.choices[0].message.content.trim();

        console.log(generatedUseCase);

        const currentDate = new Date();
        const formattedDate = `${
          currentDate.getMonth() + 1
        }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
          -2
        )}`;

        const { error: updateError } = await supabase
          .from("replicateModelsData")
          .update({
            generatedUseCase,
            lastUpdated: formattedDate,
          })
          .eq("id", model.id);

        if (updateError) {
          console.error(`Failed to update model ${model.id}:`, updateError);
        } else {
          console.log(`Updated model ${model.id} with generated use case`);
        }
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

generateUseCase();
