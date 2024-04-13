import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { Configuration, OpenAIApi } from "openai";
import dotenv from "dotenv";

dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const replicateApiKey = process.env.REPLICATE_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const configuration = new Configuration({
  apiKey: openaiApiKey,
});
const openai = new OpenAIApi(configuration);

async function getModelDetailsFromReplicate(owner, name) {
  try {
    const response = await axios.get(
      `https://api.replicate.com/v1/models/${owner}/${name}`,
      {
        headers: {
          Authorization: `Token ${replicateApiKey}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(
      `Failed to fetch model details from Replicate API for model ${owner}/${name}. Error:`,
      error.message
    );
    return null;
  }
}

export async function generateUseCase() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error: fetchError } = await supabase
      .from("replicateModelsData_NEW")
      .select("id, description, modelName, creator, tags, modelUrl")
      .or("generatedUseCase.is.null,generatedUseCase.eq.''")
      .not("description", "eq", null)
      .not("description", "eq", "")
      .gte("runs", 10000)
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (models.length === 0) {
      console.log("No models without generated use case were found");
      hasMoreData = false;
    } else {
      for (const model of models) {
        const { modelName, description, tags, creator } = model;
        const modelDetails = await getModelDetailsFromReplicate(
          creator,
          modelName
        );

        let generatedUseCase = "";

        if (modelDetails && modelDetails.default_example) {
          const inputDetails = JSON.stringify(
            modelDetails.default_example.input
          );
          const outputDetails = JSON.stringify(
            modelDetails.default_example.output
          );

          const prompt = `Write a concise, matter-of-fact overview in paragraph form (not a list) covering some possible use cases for this AI model and speculate on some possible products or practical uses of this model:
          ${modelName}
          Tags: ${tags}
          Description provided by the creator: ${description}
          Model's Input Schema: ${inputDetails.substring(0, 1000)}
          Model's Output Schema: ${outputDetails.substring(0, 1000)}
          Use cases:`;

          console.log(prompt);

          const response = await openai.createChatCompletion({
            model: "gpt-4",
            messages: [{ role: "system", content: prompt }],
          });

          generatedUseCase = response.data.choices[0].message.content.trim();
          console.log(generatedUseCase);
        } else {
          const prompt = `Write a concise overview in paragraph form (not a list) covering some possible use cases for this AI model and speculate on some possible products or practical uses of this model:
          ${modelName}
          Tags: ${tags}
          Description provided by the creator: ${description}
          Use cases:`;

          console.log(prompt);

          const response = await openai.createChatCompletion({
            model: "gpt-4",
            messages: [{ role: "system", content: prompt }],
          });

          generatedUseCase = response.data.choices[0].message.content.trim();
          console.log(generatedUseCase);
        }

        const currentDate = new Date();
        const formattedDate = `${
          currentDate.getMonth() + 1
        }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(
          -2
        )}`;

        const { error: updateError } = await supabase
          .from("replicateModelsData_NEW")
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
    }
  }

  console.log("Job completed");
}

generateUseCase();
