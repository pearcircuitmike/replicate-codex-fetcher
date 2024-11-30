import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });

async function summarizeCaption(caption) {
  console.log("Summarizing caption...");
  try {
    const result =
      await model.generateContent(`Rewrite this figure/table caption to be clear and concise in plain text with no special notation or figures in 20 words. "${caption}"
    
    Do not say "our" or imply you did the work. Do not give the table number. Just be matter of fact in third person. Do not say "Caption" or anything. Just provide the caption by itself.`);

    console.log("Caption summarization completed");
    return result.response.text().trim();
  } catch (error) {
    console.error("Error in summarizeCaption:", error);
    throw error;
  }
}

async function cleanTableHtml(htmlTable, arxivId) {
  console.log(`Cleaning table HTML for arxivId: ${arxivId}`);
  try {
    const result =
      await model.generateContent(`Clean and format the following HTML table. Return a well-formatted HTML table with the following requirements:
    - Use clean, semantic HTML5
    - Include proper table structure (thead, tbody)
    - Preserve all data and formatting
    - Convert any LaTeX or special notation to plain text
    - Remove any unnecessary classes or styling
    - Keep only essential attributes
    - If images exist, convert paths to https://arxiv.org/html/${arxivId}/filename.png
    - Format numbers consistently
    - Ensure proper cell alignment
    - Add proper scope attributes to header cells
    
    Return only the cleaned HTML table, nothing else.
    ${htmlTable}`);

    console.log("Table HTML cleaning completed");
    return result.response.text().trim();
  } catch (error) {
    console.error("Error in cleanTableHtml:", error);
    throw error;
  }
}

async function verifyTable(table) {
  console.log("Verifying table...");
  try {
    const result =
      await model.generateContent(`Verify this HTML table meets these criteria and fix if needed:
    - Contains meaningful data (not author info or pseudo-code)
    - Has proper structure and formatting
    - Data is readable and properly aligned
    - Numbers are consistently formatted
    - Headers make sense
    - Table provides useful information
    
    Return the verified/fixed HTML table only. No explanation needed.
    ${table}`);

    console.log("Table verification completed");
    return result.response.text().trim();
  } catch (error) {
    console.error("Error in verifyTable:", error);
    throw error;
  }
}

async function fetchPaper(arxivId) {
  console.log(`Fetching paper with arxivId: ${arxivId}`);
  try {
    const response = await axios.get(`https://arxiv.org/html/${arxivId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    console.log(`Successfully fetched paper ${arxivId}`);
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch ${arxivId}:`, error);
    return null;
  }
}

async function processTable(table, index, arxivId) {
  console.log(`Processing table ${index + 1} for arxivId: ${arxivId}`);
  try {
    const originalCaption =
      table.querySelector(".ltx_caption")?.textContent?.trim() || "";
    console.log(
      `Original caption found: ${originalCaption.substring(0, 50)}...`
    );

    const caption = await summarizeCaption(originalCaption);
    console.log(`Summarized caption: ${caption}`);

    const tableContent = table.querySelector(".ltx_tabular")?.outerHTML || "";
    if (!tableContent) {
      console.log("No table content found, skipping...");
      return null;
    }
    console.log(`Table HTML content length: ${tableContent.length} characters`);

    const cleanedTable = await cleanTableHtml(tableContent, arxivId);
    console.log(`Cleaned table length: ${cleanedTable.length} characters`);

    const verifiedTable = await verifyTable(cleanedTable);
    console.log(`Verified table length: ${verifiedTable.length} characters`);

    console.log(`Successfully processed table ${index + 1}`);
    return {
      index: index + 1,
      caption,
      originalCaption,
      tableHtml: verifiedTable,
      identifier: `Table-${index + 1}`,
    };
  } catch (error) {
    console.error(`Error processing table ${index + 1}:`, error);
    return null;
  }
}

async function processAndStorePaper(paper) {
  console.log(`\nStarting to process paper ${paper.id} (${paper.arxivId})`);
  try {
    const html = await fetchPaper(paper.arxivId);
    if (!html) {
      console.log(`No HTML content found for paper ${paper.id}`);
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [] })
        .eq("id", paper.id);
      return;
    }
    console.log(`HTML content length: ${html.length} characters`);

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const tables = [];

    const tableElements = Array.from(
      document.querySelectorAll(".ltx_table")
    ).slice(0, 2);
    console.log(`Found ${tableElements.length} table elements`);

    for (const [index, table] of tableElements.entries()) {
      console.log(`\nProcessing table ${index + 1} of ${tableElements.length}`);
      const processedTable = await processTable(table, index, paper.arxivId);
      if (processedTable) {
        tables.push(processedTable);
        console.log(`Successfully added table ${index + 1} to results`);
      }
      if (tables.length >= 4) {
        console.log("Reached maximum of 4 tables, stopping processing");
        break;
      }
    }

    tables.sort((a, b) => a.index - b.index);
    console.log(`Total tables processed: ${tables.length}`);

    if (tables.length > 0) {
      console.log("Updating Supabase with processed tables...");
      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ paperTables: tables })
        .eq("id", paper.id);

      if (updateError) throw updateError;
      console.log(
        `Successfully stored ${tables.length} tables for paper ${paper.id}`
      );
    } else {
      console.log(`No valid tables found for paper ${paper.id}`);
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [] })
        .eq("id", paper.id);
    }
  } catch (error) {
    console.error(`Error processing paper ${paper.id}:`, error);
    await supabase
      .from("arxivPapersData")
      .update({ paperTables: [] })
      .eq("id", paper.id);
  }
}

async function main() {
  console.log("\n=== Starting paper processing ===\n");
  try {
    let startIndex = 0;
    let hasMore = true;

    while (hasMore) {
      console.log(`\nFetching papers from index ${startIndex}...`);
      const { data: papers, error } = await supabase
        .from("arxivPapersData")
        .select("id, arxivId")
        .is("paperTables", null)
        .order("totalScore", { ascending: false })
        .range(startIndex, startIndex + 99);

      if (error) throw error;

      if (!papers?.length) {
        console.log("No more papers to process");
        hasMore = false;
        break;
      }

      console.log(`Processing batch of ${papers.length} papers`);

      for (const paper of papers) {
        console.log(
          `\n=== Processing paper ${paper.id} (${paper.arxivId}) ===\n`
        );
        await processAndStorePaper(paper);
        console.log("\nWaiting 1 second before next paper...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      startIndex += 100;
    }
  } catch (error) {
    console.error("Error in main function:", error);
  }
  console.log("\n=== Paper processing complete ===\n");
}

main().catch(console.error);
