import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Parser from "rss-parser";
import slugify from "slugify";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configure custom fields to capture arXiv-specific data
const rssParser = new Parser({
  customFields: {
    item: [
      ["arxiv:announce_type", "announceType"], // store <arxiv:announce_type> in item.announceType
    ],
  },
});

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

function isAnnounceTypeNew(item) {
  // item.announceType was set by the customFields parser config
  if (!item.announceType) return false;
  const announceType = item.announceType.trim().toLowerCase();
  return announceType === "new" || announceType === "replace-cross";
}

async function checkAndInsertPaperIfNew(data, arxivCategories, pubDate) {
  if (!isAnnounceTypeNew(data)) {
    console.log(
      `Skipping paper "${sanitizeValue(
        data.title
      )}" because its announceType is not "new" or "replace-cross".`
    );
    return;
  }

  const arxivId = extractArxivId(data.link);
  if (!arxivId) {
    console.error(`Failed to extract arxivId from URL: ${data.link}`);
    return;
  }

  const hasAllowedCategory = arxivCategories.some((cat) =>
    allowedCategories.includes(cat)
  );
  if (!hasAllowedCategory) {
    console.log(
      `Skipping paper "${sanitizeValue(
        data.title
      )}" because it does not have an allowed category.`
    );
    return;
  }

  // Check if this paper already exists
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

  if (existingPaper) {
    console.log(
      `Paper "${sanitizeValue(data.title)}" already exists. Skipping.`
    );
    return;
  }

  // Insert new paper
  const currentDate = new Date();
  const lastUpdated = currentDate.toISOString();
  const publishedDate = pubDate.toISOString();

  const abstract = sanitizeValue(
    data.contentSnippet.split("Abstract: ")[1] || ""
  );
  const authors = data.creator
    ? data.creator.split(", ").map(sanitizeValue)
    : [];
  const pdfUrl = generatePdfUrl(arxivId);
  const slug = generateSlug(data.title);

  const { error: insertError } = await supabase.from("arxivPapersData").insert([
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
    console.log(`Inserted new paper "${sanitizeValue(data.title)}"`);
  }
}

async function fetchPapersFromRSS(category) {
  try {
    console.log(`Fetching papers for category "${category}"...`);
    const feed = await rssParser.parseURL(
      `https://rss.arxiv.org/rss/${category}`
    );
    console.log(`Found ${feed.items.length} papers in category "${category}"`);

    const pubDate = new Date(feed.pubDate);

    for (const item of feed.items) {
      const arxivCategories = item.categories.filter(
        (cat) =>
          cat.startsWith("cs") ||
          cat.startsWith("eess") ||
          cat.startsWith("stat.ML")
      );
      if (arxivCategories.length > 0) {
        await checkAndInsertPaperIfNew(item, arxivCategories, pubDate);
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
