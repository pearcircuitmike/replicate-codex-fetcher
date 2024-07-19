import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const openai = new OpenAI({ apiKey: openaiApiKey });

export async function createEmbeddings() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: rows, error: fetchError } = await supabase
      .from("modelsData")
      .select("creator, modelName, generatedSummary, description, tags, id")
      .is("embedding", null)
      .eq("platform", "huggingFace")
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (rows.length === 0) {
      console.log("No models without embeddings were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + rows.length}`);

      for (const row of rows) {
        const { creator, modelName, generatedSummary, description, tags, id } =
          row;

        const inputText = `${creator || ""} ${modelName || ""} ${
          generatedSummary || ""
        }  ${description || ""} ${tags || ""}`;
        console.log(inputText);
        try {
          const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: inputText,
          });

          const [{ embedding }] = embeddingResponse.data;

          await supabase
            .from("modelsData")
            .update({ embedding: embedding })
            .eq("platform", "huggingFace")
            .eq("id", id);

          console.log(`Embedding created and inserted for row with id: ${id}`);
        } catch (error) {
          console.error(
            `Failed to create and insert embedding for row with id: ${id}. Error:`,
            error.message
          );
        }
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

createEmbeddings();
