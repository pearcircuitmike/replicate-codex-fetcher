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
  const limit = 5000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: rows, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select(
        "id, title, arxivCategories, abstract, authors, lastUpdated, arxivId, generatedSummary"
      )
      .is("embedding", null)
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error(fetchError);
      return;
    }

    if (rows.length === 0) {
      console.log("No papers without embeddings were found");
      hasMoreData = false;
    } else {
      console.log(`Processing papers ${start + 1} to ${start + rows.length}`);

      for (const row of rows) {
        const {
          id,
          title,
          arxivCategories,
          abstract,
          authors,
          lastUpdated,
          arxivId,
          generatedSummary,
        } = row;

        const inputText = `${title || ""} ${arxivCategories || ""} ${
          abstract || ""
        } ${authors || ""} ${lastUpdated || ""} ${arxivId || ""} ${
          generatedSummary || ""
        }`;

        try {
          const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: inputText,
          });

          const [{ embedding }] = embeddingResponse.data;

          await supabase
            .from("arxivPapersData")
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

      // After processing the batch, help the garbage collector by clearing large objects
      rows.length = 0; // Clear the array to free up memory
      start += limit;
      console.log(`Processed papers up to ${start}`);
    }
  }

  console.log("Job completed");
}

createEmbeddings();
