import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Parser from "rss-parser";
import slugify from "slugify";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const rssParser = new Parser();

const categories = ["cs", "eess"];

const allowedCategories = [
  "cs.AI",
  "cs.CL",
  "cs.CV",
  "cs.CY",
  "cs.DC",
  "cs.ET",
  "cs.HC",
  "cs.IR",
  "cs.LG",
  "cs.MA",
  "cs.MM",
  "cs.NE",
  "cs.RO",
  "cs.SD",
  "cs.NI",
  "eess.AS",
  "eess.IV",
  "stat.ML",
];

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

function generateSlug(title) {
  const articleRegex = /\b(a|an|the|of|for|in|on|and|with)\b/gi;
  const slug = slugify(title, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@]/g,
  })
    .replace(articleRegex, "")
    .replace(/[-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.split("-").slice(0, 7).join("-");
}
async function checkAndUpsertPaper(data, arxivCategories, pubDate) {
  const currentDate = new Date();
  const lastUpdated = formatDate(currentDate);
  const publishedDate = pubDate;
  const arxivId = extractArxivId(data.link);

  if (!arxivId) {
    console.error(`Failed to extract arxivId from URL: ${data.link}`);
    return;
  }

  // Check if the paper has at least one of the allowed categories
  const hasAllowedCategory = arxivCategories.some((category) =>
    allowedCategories.includes(category)
  );
  if (!hasAllowedCategory) {
    console.log(
      `Skipping paper "${sanitizeValue(
        data.title
      )}" as it does not have any of the allowed categories.`
    );
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
  const slug = generateSlug(data.title);

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
        slug: slug,
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
          slug: slug,
          platform: "arxiv",
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

    const pubDate = new Date(feed.pubDate); // Parse the pubDate from the feed

    for (const item of feed.items) {
      const arxivCategories = item.categories.filter(
        (cat) =>
          cat.startsWith("cs") ||
          cat.startsWith("eess") ||
          cat.startsWith("stat.ML")
      );
      if (arxivCategories.length > 0) {
        await checkAndUpsertPaper(item, arxivCategories, pubDate); // Pass the pubDate to the function
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
