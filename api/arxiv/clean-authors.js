import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// 1. Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_SECRET_KEY,
});

// (A) Helper function to process a batch of rows
async function processBatch(rows) {
  for (const row of rows) {
    console.log(`  Cleaning row ID: ${row.id}`);
    const arrayToSend = row.authors;

    // ----- SAME PROMPT YOU HAD BEFORE -----
    const messageContent = `
I have a lot of mangled arrays with LaTeX-like values or diacritics that need to be fixed.
I'll give you the array, and you return the corrected array with the authors' proper unicode
(and nothing else, just the array).

Example:
Input: ["Maia Trower","Natav{s}a Djurdjevac Conrad","Stefan Klus"]
Output: ["Maia Trower","Nataša Djurdjevac Conrad","Stefan Klus"]

Now fix this array: ${JSON.stringify(arrayToSend)}
    `;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", // or "gpt-4o"
        messages: [
          {
            role: "developer",
            content: messageContent,
          },
        ],
      });

      // LLM's cleaned output
      const cleanedString = completion.choices[0].message.content.trim();
      console.log("    Original Authors:", JSON.stringify(row.authors));
      console.log("    Cleaned Authors: ", cleanedString);

      // Convert the LLM response to an actual array
      const cleanedArray = JSON.parse(cleanedString);

      // Update the database with the cleaned array
      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ authors: cleanedArray })
        .eq("id", row.id);

      if (updateError) {
        console.error(`    Failed to update row ${row.id}:`, updateError);
      } else {
        console.log(`    Successfully updated row ${row.id}.`);
      }
    } catch (err) {
      console.error(`    OpenAI API Error for row ${row.id}:`, err);
    }
  }
}

// (B) Main function to paginate through all messed-up rows
async function cleanAuthors() {
  let offset = 0;
  const pageSize = 1000; // how many rows to fetch each time
  let totalCleaned = 0;

  while (true) {
    // 1. Call the function with offset/limit
    const { data, error } = await supabase.rpc("get_messed_up_rows", {
      p_offset: offset,
      p_limit: pageSize,
    });

    if (error) {
      console.error("RPC error calling get_messed_up_rows:", error);
      break;
    }

    if (!data || data.length === 0) {
      console.log("No more messed-up rows found. Done!");
      break;
    }

    console.log(
      `\nFetched ${data.length} messed-up rows at offset ${offset}...`
    );

    // 2. Process the chunk
    await processBatch(data);

    totalCleaned += data.length;
    offset += data.length; // move offset by however many we got
  }

  console.log(
    `\nDone processing all rows in chunks. Cleaned total of ${totalCleaned} rows.`
  );
}

// (C) Run
await cleanAuthors();
console.log("Completed clean-authors script.");
