import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Parser from "rss-parser";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const rssParser = new Parser();

const categories = ["cs", "eess"];

function formatDate(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function sanitizeValue(value) {
  return value.replace(/\\|\"/g, "");
}

function extractArxivId(url) {
  const match = url.match(/\/abs\/(.+)/);
  return match ? match[1] : null;
}

function generatePdfUrl(arxivId) {
  return `https://arxiv.org/pdf/${arxivId}.pdf`;
}

async function checkAndUpsertPaper(data, arxivCategories) {
  const currentDate = new Date();
  const lastUpdated = formatDate(currentDate);
  const publishedDate = new Date(data.pubDate);
  const arxivId = extractArxivId(data.link);

  if (!arxivId) {
    console.error(`Failed to extract arxivId from URL: ${data.link}`);
    return;
  }

  const { data: existingPaper, error: selectError } = await supabase
    .from("arxivPapersData")
    .select("id")
    .eq("arxivId", arxivId)
    .single();

  if (selectError && selectError.code !== "PGRST116") {
    console.error(
      `Failed to check existing paper "${sanitizeValue(data.title)}":`,
      selectError
    );
    return;
  }

  const abstract = sanitizeValue(
    data.contentSnippet.split("Abstract: ")[1] || ""
  );
  const authors = data.creator
    ? data.creator.split(", ").map(sanitizeValue)
    : [];
  const pdfUrl = generatePdfUrl(arxivId);

  if (existingPaper) {
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({
        lastUpdated: lastUpdated,
        abstract: abstract,
        authors: authors,
        paperUrl: sanitizeValue(data.link),
        pdfUrl: pdfUrl,
        publishedDate: publishedDate,
        indexedDate: lastUpdated,
        arxivCategories: arxivCategories.map(sanitizeValue),
      })
      .eq("id", existingPaper.id);

    if (updateError) {
      console.error(
        `Failed to update paper "${sanitizeValue(data.title)}":`,
        updateError
      );
    } else {
      console.log(`Updated paper "${sanitizeValue(data.title)}"`);
    }
  } else {
    const { error: insertError } = await supabase
      .from("arxivPapersData")
      .insert([
        {
          title: sanitizeValue(data.title),
          arxivCategories: arxivCategories.map(sanitizeValue),
          abstract: abstract,
          authors: authors,
          paperUrl: sanitizeValue(data.link),
          pdfUrl: pdfUrl,
          publishedDate: publishedDate,
          lastUpdated: lastUpdated,
          indexedDate: lastUpdated,
          arxivId: arxivId,
        },
      ]);

    if (insertError) {
      console.error(
        `Failed to insert paper "${sanitizeValue(data.title)}":`,
        insertError
      );
    } else {
      console.log(`Inserted paper "${sanitizeValue(data.title)}"`);
    }
  }
}

async function fetchPapersFromRSS(category) {
  try {
    console.log(`Fetching papers for category "${category}"...`);
    const feed = await rssParser.parseURL(
      `https://rss.arxiv.org/rss/${category}`
    );
    console.log(`Found ${feed.items.length} papers in category "${category}"`);

    for (const item of feed.items) {
      const arxivCategories = item.categories.filter(
        (cat) => cat.startsWith("cs") || cat.startsWith("eess")
      );
      if (arxivCategories.length > 0) {
        await checkAndUpsertPaper(item, arxivCategories);
      }
    }

    console.log(`Finished processing papers for category "${category}"`);
  } catch (error) {
    console.error(
      `Failed to fetch papers for category "${category}". Error:`,
      error.message
    );
  }
}

export async function fetchNewPapers() {
  console.log("Starting to fetch new papers from arXiv...");

  for (const category of categories) {
    await fetchPapersFromRSS(category);
  }

  console.log("Finished fetching new papers from arXiv.");
}

fetchNewPapers();
