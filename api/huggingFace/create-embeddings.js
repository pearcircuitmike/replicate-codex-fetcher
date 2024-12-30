import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const openai = new OpenAI({ apiKey: openaiApiKey });

// Function to truncate text to approximately stay within token limit
function truncateText(text, maxLength = 6000) {
  // Reduced from 8000 to 6000 for safety
  // More conservative approximation: 1 token ≈ 3 characters for English text
  const approximateCharLimit = maxLength * 3;

  if (text.length <= approximateCharLimit) {
    return text;
  }

  const truncated = text.slice(0, approximateCharLimit).trim();

  // Log truncation info for debugging
  console.log({
    originalLength: text.length,
    truncatedLength: truncated.length,
    approximateTokens: Math.ceil(truncated.length / 3),
  });

  return truncated;
}

export async function createEmbeddings() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;
  let failureCount = 0;
  const MAX_FAILURES = 5;

  while (hasMoreData) {
    if (failureCount >= MAX_FAILURES) {
      console.error(`Stopping after ${MAX_FAILURES} consecutive failures`);
      return;
    }

    const { data: rows, error: fetchError } = await supabase
      .from("modelsData")
      .select("creator, modelName, generatedSummary, description, tags, id")
      .is("embedding", null)
      .eq("platform", "huggingFace")
      .range(start, start + limit - 1);

    if (fetchError) {
      console.error("Error fetching data:", fetchError);
      return;
    }

    if (!rows || rows.length === 0) {
      console.log("No more models without embeddings were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + rows.length}`);

      for (const row of rows) {
        const { creator, modelName, generatedSummary, description, tags, id } =
          row;

        // Prioritize most important fields and truncate each individually
        const truncatedCreator = (creator || "").slice(0, 100);
        const truncatedModelName = (modelName || "").slice(0, 200);
        const truncatedSummary = (generatedSummary || "").slice(0, 1000);
        const truncatedDescription = (description || "").slice(0, 2000);
        const truncatedTags = (tags || "").slice(0, 200);

        // Combine truncated fields
        const inputText = truncateText(
          `${truncatedCreator} ${truncatedModelName} ${truncatedSummary} ${truncatedDescription} ${truncatedTags}`
        );

        try {
          const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: inputText,
          });

          const [{ embedding }] = embeddingResponse.data;

          const { error: updateError } = await supabase
            .from("modelsData")
            .update({ embedding: embedding })
            .eq("platform", "huggingFace")
            .eq("id", id);

          if (updateError) {
            throw new Error(
              `Failed to update database: ${updateError.message}`
            );
          }

          console.log(`Embedding created and inserted for row with id: ${id}`);
          failureCount = 0; // Reset failure count on success
        } catch (error) {
          console.error(
            `Failed to create and insert embedding for row with id: ${id}. Error:`,
            error.message
          );

          failureCount++;

          // Add exponential backoff delay
          const delay = Math.min(1000 * Math.pow(2, failureCount), 30000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

createEmbeddings();
