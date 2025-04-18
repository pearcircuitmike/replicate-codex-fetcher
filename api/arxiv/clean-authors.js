import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

console.log("[INFO] Starting script: clean-author-names.js");

// --- Configuration ---

// 1. Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "[ERROR] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in your environment variables or .env file."
  );
  process.exit(1); // Exit if Supabase config is missing
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("[INFO] Supabase client initialized.");

// 2. Initialize Gemini
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error(
    "[ERROR] GEMINI_API_KEY must be set in your environment variables or .env file."
  );
  process.exit(1); // Exit if Gemini key is missing
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash", // Updated model to 2.0 flash
});
console.log(
  "[INFO] GoogleGenerativeAI client initialized with model: gemini-2.0-flash."
);

// --- Constants ---
const BATCH_SIZE = 500; // How many rows to fetch from Supabase at a time
console.log(`[CONFIG] BATCH_SIZE set to: ${BATCH_SIZE}`);
// Regex to identify potentially malformed names.
// Looks for: single quotes, colons, parentheses, curly braces (like LaTeX)
// Adjust this regex based on the patterns you observe in your data.
const MALFORMED_NAME_REGEX = /[':()]|{[^}]+}/;
console.log(`[CONFIG] MALFORMED_NAME_REGEX set to: ${MALFORMED_NAME_REGEX}`);
const MAX_RETRIES = 3; // Max retries for Gemini API calls
console.log(`[CONFIG] MAX_RETRIES set to: ${MAX_RETRIES}`);
const RETRY_DELAY_MS = 100; // Delay between retries
console.log(`[CONFIG] RETRY_DELAY_MS set to: ${RETRY_DELAY_MS}`);

// --- Helper Functions ---

/**
 * Adds a delay.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function delay(ms) {
  // No console log needed here unless debugging delays
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processes a batch of author rows.
 * Checks names, calls Gemini for potentially malformed ones, and updates the DB.
 * @param {Array<{id: string, canonical_name: string}>} rows - Batch of rows from Supabase.
 * @returns {Promise<number>} - The number of names actually sent to Gemini for cleaning.
 */
async function processBatch(rows) {
  console.log(`  [BATCH] Starting processing for ${rows.length} fetched rows.`);
  let cleanedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    // Skip if canonical_name is null, empty, or doesn't look malformed
    if (!row.canonical_name || !MALFORMED_NAME_REGEX.test(row.canonical_name)) {
      // console.log(`  [SKIP] Row ID: ${row.id} (Name looks okay or is empty: "${row.canonical_name}")`);
      skippedCount++;
      continue; // Move to the next row
    }

    // Log if the name passes the regex test and will be processed
    console.log(
      `  [PROCESS] Row ID: ${row.id}. Potential issue found in name: "${row.canonical_name}". Attempting cleanup.`
    );

    // Prepare the prompt for Gemini
    const prompt = `
Analyze the following author name, which might contain formatting issues, extra characters, or LaTeX-like syntax.
Return ONLY the corrected, standardized full name as a single plain text string.
Do not include any explanations, markdown, quotation marks, or any text other than the corrected name itself.
Sometimes people put in nicknames which should be ignored.

Example Input: Michael Young (Mike)
Example Output: Michael Young

Example Input: Ag'ust P'almason Morthens
Example Output: Águst Pálmason Morthens

Example Input: 'Emilie Volpi (FR 3621)
Example Output: Emilie Volpi

Example Input: Natav{s}a Djurdjevac Conrad
Example Output: Nataša Djurdjevac Conrad

Example Input: Aamir Mehmood (Artificial Intelligence Lab
Example Output: Aamir Mehmood

Now, correct this name: ${row.canonical_name}
    `;

    let success = false;
    let retries = 0;
    let cleanedName = "";

    // Try calling Gemini with retries
    while (!success && retries < MAX_RETRIES) {
      try {
        console.log(
          `    [GEMINI] Calling Gemini for row ${row.id} (Attempt ${
            retries + 1
          }/${MAX_RETRIES})...`
        );
        const result = await geminiModel.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.2,
          },
        });
        console.log(`    [GEMINI] Received response for row ${row.id}.`);

        // Extract the text, trim whitespace, and remove potential surrounding quotes
        cleanedName = result.response
          .text()
          .trim()
          .replace(/^["']|["']$/g, ""); // Remove leading/trailing quotes

        // Basic validation: Check if the result is empty or excessively long (potential error)
        if (!cleanedName || cleanedName.length > 250) {
          console.warn(
            `    [WARN] Gemini returned an unusual result for row ${row.id}: "${cleanedName}". Skipping update.`
          );
          break; // Don't retry if the content seems invalid
        }

        console.log(`      Original Name: "${row.canonical_name}"`);
        console.log(`      Cleaned Name:  "${cleanedName}"`);
        success = true; // Mark as successful
        cleanedCount++; // Increment only if Gemini call was successful
      } catch (err) {
        retries++;
        console.error(
          `    [ERROR] Gemini API Error for row ${row.id} (Attempt ${retries}/${MAX_RETRIES}):`,
          err.message || err
        );
        if (retries < MAX_RETRIES) {
          console.log(
            `    [RETRY] Retrying Gemini call in ${RETRY_DELAY_MS / 1000}s...`
          );
          await delay(RETRY_DELAY_MS);
        } else {
          console.error(
            `    [ERROR] Max retries reached for Gemini call on row ${row.id}. Skipping update.`
          );
        }
      }
    } // End retry loop

    // If Gemini call was successful and we got a cleaned name different from the original
    if (success && cleanedName && cleanedName !== row.canonical_name) {
      console.log(`    [DB] Attempting to update row ${row.id} in Supabase...`);
      const { error: updateError } = await supabase
        .from("authors") // Target the correct table
        .update({ canonical_name: cleanedName, updated_at: new Date() }) // Update the correct column
        .eq("id", row.id);

      if (updateError) {
        console.error(
          `    [ERROR] Failed to update row ${row.id} in Supabase:`,
          updateError.message
        );
      } else {
        console.log(`    [DB] Successfully updated row ${row.id}.`);
      }
    } else if (success && cleanedName === row.canonical_name) {
      console.log(
        `    [INFO] Cleaned name is the same as original for row ${row.id}. No database update needed.`
      );
    } else if (!success) {
      console.log(
        `    [INFO] Gemini call failed for row ${row.id} after retries. No database update performed.`
      );
    }
    // Add a small delay to avoid overwhelming the APIs
    await delay(50); // 50ms delay between processing each row
  } // End loop through rows

  console.log(
    `  [BATCH] Finished processing batch. Skipped: ${skippedCount}, Attempted cleanup: ${cleanedCount}.`
  );
  return cleanedCount; // Return the count of names successfully processed by Gemini
}

// --- Main Function ---

/**
 * Fetches authors with null ORCID IDs in batches and processes them.
 */
async function cleanAuthorNames() {
  console.log("\n[MAIN] Starting author name cleaning process...");
  let offset = 0;
  let totalFetched = 0;
  let totalProcessedForCleaning = 0; // Count names successfully processed by Gemini
  let keepFetching = true;

  while (keepFetching) {
    console.log(
      `\n[MAIN] Fetching batch from Supabase... Limit: ${BATCH_SIZE}, Offset: ${offset}`
    );

    // 1. Fetch a batch of authors with null ORCID IDs
    const { data, error, count } = await supabase
      .from("authors")
      .select("id, canonical_name", { count: "exact" })
      .is("orcid_id", null)
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error("[ERROR] Supabase fetch error:", error.message);
      keepFetching = false;
      break;
    }

    // Log fetch results
    const fetchedCount = data ? data.length : 0;
    console.log(`[MAIN] Fetched ${fetchedCount} rows from Supabase.`);
    if (count !== null) {
      console.log(
        `[MAIN] Total potential rows with NULL ORCID matching query: ${count}`
      );
    }

    if (!data || data.length === 0) {
      console.log(
        "[MAIN] No more authors with null ORCID IDs found matching criteria."
      );
      keepFetching = false;
      break;
    }

    totalFetched += data.length;

    // 2. Process the current batch
    const processedInBatch = await processBatch(data);
    totalProcessedForCleaning += processedInBatch;

    // 3. Move to the next batch
    offset += data.length;
  }

  console.log("\n--- [SUMMARY] Cleaning Process Finished ---");
  console.log(
    `[SUMMARY] Total rows fetched from Supabase with NULL ORCID ID: ${totalFetched}`
  );
  console.log(
    `[SUMMARY] Total names successfully processed by Gemini: ${totalProcessedForCleaning}`
  );
  console.log("[SUMMARY] Author name cleaning script finished.");
}

// --- Run Script ---
cleanAuthorNames()
  .then(() => {
    console.log("\n[INFO] Script completed successfully.");
    process.exit(0); // Exit cleanly
  })
  .catch((err) => {
    console.error("\n[FATAL] Unhandled error during script execution:", err);
    process.exit(1); // Exit with error code
  });
