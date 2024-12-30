import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateSummary } from "./generate-summary.js"; // Adjust the path based on your structure

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function cleanAndRegenerateSummaries() {
  try {
    // Step 1: Find models with malformed summaries
    const { data: models, error } = await supabase
      .from("modelsData")
      .select("id")
      .eq("platform", "huggingFace")
      .not("generatedSummary", "is", null)
      .ilike("generatedSummary", "%[`%`]%");

    if (error) {
      console.error("Error fetching models with malformed summaries:", error);
      return;
    }

    if (!models || models.length === 0) {
      console.log("No malformed summaries found.");
      return;
    }

    console.log(`Found ${models.length} models with malformed summaries.`);

    // Step 2: Clear the malformed summaries
    const { error: clearError } = await supabase
      .from("modelsData")
      .update({ generatedSummary: null })
      .eq("platform", "huggingFace")
      .ilike("generatedSummary", "%[`%`]%");

    if (clearError) {
      console.error("Error clearing malformed summaries:", clearError);
      return;
    }

    console.log("Cleared malformed summaries. Regenerating summaries...");

    // Step 3: Call generateSummary
    await generateSummary();

    console.log("Summary regeneration completed.");
  } catch (error) {
    console.error("Error in cleanAndRegenerateSummaries:", error);
  }
}

cleanAndRegenerateSummaries();
