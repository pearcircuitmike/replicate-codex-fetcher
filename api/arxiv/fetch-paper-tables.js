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

// Human-like behavior constants
const BATCH_SIZE = 20; // Smaller batch size for more natural processing
const BASE_DELAY = 5000; // Base delay between actions
const VARIANCE_FACTOR = 0.3; // 30% variance in timing
const READING_TIME_PER_WORD = 250; // ms per word for "reading"
const MIN_PAGE_VIEW_TIME = 15000; // Minimum time to view a page
const MAX_PAGE_VIEW_TIME = 90000; // Maximum time to view a page
const TYPING_SPEED = 200; // ms per character for "typing"

// Browser simulation headers
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// Simulate human-like delay
function getHumanDelay(baseTime) {
  const variance = baseTime * VARIANCE_FACTOR;
  const randomVariance = (Math.random() - 0.5) * 2 * variance;
  return Math.max(baseTime + randomVariance, 1000);
}

// Simulate reading time based on content length
function getReadingTime(text) {
  const words = text.split(/\s+/).length;
  const baseTime = words * READING_TIME_PER_WORD;
  return getHumanDelay(
    Math.min(Math.max(baseTime, MIN_PAGE_VIEW_TIME), MAX_PAGE_VIEW_TIME)
  );
}

// Simulate typing delay
async function simulateTyping(text) {
  const typingTime = text.length * TYPING_SPEED;
  await delay(getHumanDelay(typingTime));
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function summarizeCaption(caption) {
  console.log("Reading and analyzing caption...");

  // Simulate reading the original caption
  await delay(getReadingTime(caption));

  try {
    // Simulate composing the prompt
    const prompt = `Rewrite this figure/table caption to be clear and concise in plain text with no special notation or figures in 20 words. "${caption}"
    
    Do not say "our" or imply you did the work. Do not give the table number. Just be matter of fact in third person. Do not say "Caption" or anything. Just provide the caption by itself.`;
    await simulateTyping(prompt);

    const result = await model.generateContent(prompt);
    const summary = result.response.text().trim();

    // Simulate reviewing the summary
    await delay(getReadingTime(summary));

    return summary;
  } catch (error) {
    console.error("Error in summarizeCaption:", error);
    throw error;
  }
}

async function cleanTableHtml(htmlTable, arxivId) {
  console.log(`Analyzing table structure for arxivId: ${arxivId}`);

  try {
    // Simulate analyzing the table structure
    await delay(getHumanDelay(5000));

    const prompt = `Clean and format the following HTML table. Return a well-formatted HTML table with the following requirements: [formatting requirements...]`;
    await simulateTyping(prompt);

    const result = await model.generateContent(prompt + htmlTable);
    const cleaned = result.response.text().trim();

    // Simulate reviewing the cleaned table
    await delay(getHumanDelay(3000));

    return cleaned;
  } catch (error) {
    console.error("Error in cleanTableHtml:", error);
    throw error;
  }
}

async function verifyTable(table) {
  console.log("Reviewing table structure and content...");

  try {
    // Simulate careful table review
    await delay(getHumanDelay(6000));

    const prompt = `Verify this HTML table meets these criteria and fix if needed: [verification criteria...]`;
    await simulateTyping(prompt);

    const result = await model.generateContent(prompt + table);
    const verified = result.response.text().trim();

    // Simulate final check
    await delay(getHumanDelay(2000));

    return verified;
  } catch (error) {
    console.error("Error in verifyTable:", error);
    throw error;
  }
}

async function fetchPaper(arxivId, retryCount = 0) {
  console.log(`Navigating to paper ${arxivId}...`);

  // Simulate coming from different referrers
  const referrers = [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/search/cs",
    "https://scholar.google.com/",
    "https://www.google.com/search",
  ];

  try {
    // Simulate page load time
    await delay(getHumanDelay(3000));

    const response = await axios.get(`https://arxiv.org/html/${arxivId}`, {
      headers: {
        ...browserHeaders,
        Referer: referrers[Math.floor(Math.random() * referrers.length)],
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    // Simulate page rendering time
    await delay(getHumanDelay(2000));

    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 403) {
      if (retryCount < 3) {
        const backoffTime = getHumanDelay(30000 * (retryCount + 1));
        console.log(
          `Access limited. Taking a break for ${Math.round(
            backoffTime / 1000
          )} seconds...`
        );
        await delay(backoffTime);
        return fetchPaper(arxivId, retryCount + 1);
      }
    }
    console.error(`Unable to access ${arxivId}:`, error);
    return null;
  }
}

async function processTable(table, index, arxivId) {
  console.log(`Examining table ${index + 1}...`);

  try {
    // Simulate initial table inspection
    await delay(getHumanDelay(4000));

    const originalCaption =
      table.querySelector(".ltx_caption")?.textContent?.trim() || "";

    // Simulate reading caption
    await delay(getReadingTime(originalCaption));

    const caption = await summarizeCaption(originalCaption);

    const tableContent = table.querySelector(".ltx_tabular")?.outerHTML || "";
    if (!tableContent) {
      console.log("No valid table content found, moving on...");
      return null;
    }

    // Simulate analyzing table structure
    await delay(getHumanDelay(5000));

    const cleanedTable = await cleanTableHtml(tableContent, arxivId);
    const verifiedTable = await verifyTable(cleanedTable);

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
  console.log(`\nAnalyzing paper ${paper.id} (${paper.arxivId})`);

  try {
    const html = await fetchPaper(paper.arxivId);
    if (!html) {
      console.log(`Paper ${paper.id} is not accessible`);
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [] })
        .eq("id", paper.id);
      return;
    }

    // Simulate initial paper review
    await delay(getReadingTime(html.slice(0, 1000)));

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const tables = [];

    // Look at first 2 tables like a human would typically focus on
    const tableElements = Array.from(
      document.querySelectorAll(".ltx_table")
    ).slice(0, 2);

    for (const [index, table] of tableElements.entries()) {
      const processedTable = await processTable(table, index, paper.arxivId);
      if (processedTable) {
        tables.push(processedTable);
        // Take a break between tables
        await delay(getHumanDelay(5000));
      }
    }

    tables.sort((a, b) => a.index - b.index);

    if (tables.length > 0) {
      // Review collected data before saving
      await delay(getHumanDelay(8000));

      await supabase
        .from("arxivPapersData")
        .update({ paperTables: tables })
        .eq("id", paper.id);
    } else {
      await supabase
        .from("arxivPapersData")
        .update({ paperTables: [] })
        .eq("id", paper.id);
    }
  } catch (error) {
    console.error(`Error analyzing paper ${paper.id}:`, error);
    await supabase
      .from("arxivPapersData")
      .update({ paperTables: [] })
      .eq("id", paper.id);
  }
}

async function main() {
  console.log("\n=== Starting paper analysis ===\n");

  try {
    let startIndex = 0;
    let hasMore = true;

    while (hasMore) {
      // Take breaks between sessions
      if (startIndex > 0) {
        const sessionBreak = getHumanDelay(300000); // 5-minute average break
        console.log(
          `Taking a break between sessions (${Math.round(
            sessionBreak / 1000
          )} seconds)...`
        );
        await delay(sessionBreak);
      }

      const { data: papers, error } = await supabase
        .from("arxivPapersData")
        .select("id, arxivId")
        .is("paperTables", null)
        .gt("totalScore", 0.5) // Only papers with score > 0.5
        .order("totalScore", { ascending: false })
        .range(startIndex, startIndex + BATCH_SIZE - 1);

      if (error) throw error;

      if (!papers?.length) {
        console.log("No more papers to analyze");
        hasMore = false;
        break;
      }

      for (const paper of papers) {
        await processAndStorePaper(paper);

        // Take a natural break between papers
        const breakTime = getHumanDelay(BASE_DELAY * 3);
        console.log(
          `Taking a short break (${Math.round(breakTime / 1000)} seconds)...`
        );
        await delay(breakTime);
      }

      startIndex += BATCH_SIZE;
    }
  } catch (error) {
    console.error("Error in main process:", error);
  }

  console.log("\n=== Paper analysis complete ===\n");
}

main().catch(console.error);
