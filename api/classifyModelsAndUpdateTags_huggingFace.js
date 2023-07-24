import { createClient } from "@supabase/supabase-js";
import got from "got";
import dotenv from "dotenv";
import { Configuration, OpenAIApi } from "openai";
import axios from "axios";
import cheerio from "cheerio";

dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const huggingFaceBaseUrl = "https://huggingface.co";

const configuration = new Configuration({
  apiKey: openaiApiKey,
});

const openai = new OpenAIApi(configuration);

export async function classifyModelsAndUpdateTags_huggingFace() {
  const modelsResponse = await got(`${huggingFaceBaseUrl}/api/models`);
  const modelsData = JSON.parse(modelsResponse.body);

  const currentDate = new Date();
  const formattedDate = `${
    currentDate.getMonth() + 1
  }/${currentDate.getDate()}/${String(currentDate.getFullYear()).slice(-2)}`; // M/DD/YY

  for (const modelData of modelsData) {
    let [creator, modelName] = modelData.id.split("/");
    if (!modelName) {
      modelName = creator;
      creator = "huggingface";
    }

    // Fetch the model from database
    const { data: existingModels, error: fetchError } = await supabase
      .from("huggingFaceModelsData")
      .select("*")
      .eq("creator", creator)
      .eq("modelName", modelName);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    const existingModel = existingModels[0];

    if (existingModel) {
      // Check if model was updated in the last 24 hours
      const lastUpdatedDate = new Date(existingModel.lastUpdated);
      const differenceInHours =
        (currentDate - lastUpdatedDate) / (1000 * 60 * 60);

      if (differenceInHours <= 24) {
        console.log(
          `${creator}/${modelName} already updated in the last 24 hours, skipping`
        );
        continue; // Skip to next iteration if it was updated in the last 24 hours
      }

      // Check if a description already exists
      if (existingModel.description) {
        console.log(
          `Description already exists for ${creator}/${modelName}, skipping generation`
        );
        continue; // Skip to next iteration if a description already exists
      }
    }

    console.log(modelName);
    const tags = modelData.pipeline_tag; // Use the pipeline_tag as the tag
    const runs = modelData.downloads;

    const modelUrl =
      creator === "huggingface"
        ? `${huggingFaceBaseUrl}/${modelName}`
        : `${huggingFaceBaseUrl}/${creator}/${modelName}`;

    // Prepare the spaces from the model-specific endpoint
    const modelSpecificEndpoint = `${huggingFaceBaseUrl}/api/models/${modelData.id}`;
    const modelSpecificResponse = await got(modelSpecificEndpoint);
    const modelSpecificData = JSON.parse(modelSpecificResponse.body);
    let spaces = modelSpecificData.spaces || [];
    spaces = spaces.map((space) => space.replace(/\//g, "-"));

    const { data } = await axios.get(modelUrl);
    const $ = cheerio.load(data);
    let content = "";
    $(".prose.pl-6.-ml-6.hf-sanitized")
      .children("p")
      .each(function () {
        content += $(this).text() + "\n\n";
      });

    // Check if the model is new by checking if existingModel is empty
    const isNewModel = !existingModel;

    // Generate summary using ChatGPT-3.5 Turbo
    let generatedSummary = "";
    if (existingModel?.description) {
      generatedSummary = existingModel.description;
      console.log("Skipping generation for model:", modelName);
    } else {
      const prompt = `Write a concise, complete summary of what the model is and what it does for a technical audience: ${modelName}\nDescription: ${content}\nSummary:`;
      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [{ role: "system", content: prompt }],
      });

      generatedSummary = response.data.choices[0].message.content.trim();
    }

    console.log(generatedSummary);

    const { error: upsertError } = await supabase
      .from("huggingFaceModelsData")
      .upsert([
        {
          creator: creator,
          modelName: modelName,
          tags: tags, // Use the pipeline_tag as the tag
          runs: runs,
          lastUpdated: formattedDate,
          platform: "huggingFace",
          description: content,
          demoSources: spaces,
          modelUrl: modelUrl,
          indexedDate: isNewModel ? formattedDate : undefined,
          description: generatedSummary, // Add the generated summary here
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

classifyModelsAndUpdateTags_huggingFace();
