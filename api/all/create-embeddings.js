import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Configuration, OpenAIApi } from "openai";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const configuration = new Configuration({ apiKey: openaiApiKey });
const openAi = new OpenAIApi(configuration);

async function createEmbeddings() {
  const { data: rows, error: fetchError } = await supabase
    .from("combinedModelsData")
    .select(
      "creator, modelName, generatedSummary, generatedUseCase, description, tags, id"
    ) // Specify columns
    .is("embedding", null)
    .gt("runs", 5000); // Only select models with runs greater than 1000

  if (fetchError) {
    console.error(fetchError);
    return;
  }

  for (const row of rows) {
    const {
      creator,
      modelName,
      generatedSummary,
      generatedUseCase,
      description,
      tags,
      id,
    } = row;

    const inputText = `${creator || ""} ${modelName || ""} ${
      generatedSummary || ""
    } ${generatedUseCase || ""} ${description || ""} ${tags || ""}`;
    console.log(inputText);
    try {
      const embeddingResponse = await openAi.createEmbedding({
        model: "text-embedding-ada-002",
        input: inputText,
      });

      const [{ embedding }] = embeddingResponse.data.data;

      await supabase
        .from("combinedModelsData")
        .update({ embedding: embedding })
        .eq("id", id);

      console.log(`Embedding created and inserted for row with id: ${id}`);
    } catch (error) {
      console.error(
        `Failed to create and insert embedding for row with id: ${id}. Error:`,
        error.message
      );
    }
  }
}

createEmbeddings();
