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

// Modified timing constants to be more human-like
const BATCH_SIZE = 20; // Reduced batch size for more natural processing
const BASE_DELAY = 5000; // Base delay of 5 seconds
const VARIANCE_FACTOR = 0.3; // 30% variance in timing
const READING_TIME_PER_WORD = 250; // Average reading time per word in milliseconds
const MIN_PAGE_VIEW_TIME = 15000; // Minimum time to "read" a page
const MAX_PAGE_VIEW_TIME = 120000; // Maximum time to "read" a page
const TYPING_SPEED = 200; // Milliseconds per character for "typing"

// Common browser headers that actual browsers send
const browserHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

// Simulate human-like random delay
function getHumanDelay(baseTime) {
  const variance = baseTime * VARIANCE_FACTOR;
  const randomVariance = (Math.random() - 0.5) * 2 * variance;
  return Math.max(baseTime + randomVariance, 1000); // Minimum 1 second
}

// Simulate reading time based on text length
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
    // Simulate typing the prompt
    const prompt = `Rewrite this figure caption to be clear and concise in plain text with no special notation or figures in 10 words that state the key takeaway. "${caption}"  Do not say "our" or imply you did the work. Just be matter of fact in third person. Do not say "Caption" or anything. Just provide the caption by itself.`;
    await simulateTyping(prompt);

    const result = await model.generateContent(prompt);
    const summary = result.response.text().trim();

    // Simulate reviewing the generated summary
    await delay(getReadingTime(summary));

    return summary;
  } catch (error) {
    console.error("Error in summarizeCaption:", error);
    throw error;
  }
}

async function fetchPaper(arxivId, retryCount = 0) {
  console.log(`Navigating to paper ${arxivId}...`);

  // Add referrer to simulate coming from search or arxiv listing
  const referrers = [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/search/cs",
    "https://scholar.google.com/",
    "https://www.google.com/search",
  ];

  try {
    // Simulate page load time and network conditions
    await delay(getHumanDelay(3000));

    const response = await axios.get(`https://arxiv.org/html/${arxivId}`, {
      headers: {
        ...browserHeaders,
        Referer: referrers[Math.floor(Math.random() * referrers.length)],
      },
      // Simulate realistic network conditions
      timeout: 10000,
      maxRedirects: 5,
    });

    // Simulate page rendering and initial scan time
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

async function processFigure(figure, index, arxivId) {
  console.log(`Examining figure ${index + 1}...`);

  try {
    // Simulate human scanning the figure
    await delay(getHumanDelay(4000));

    const originalCaption =
      figure.querySelector(".ltx_caption")?.textContent?.trim() || "";
    const images = figure.querySelectorAll("img");

    // Simulate inspecting each image
    await delay(getHumanDelay(2000 * images.length));

    for (const img of images) {
      const imgSrc = img.getAttribute("src");

      if (imgSrc) {
        let contentUrl;
        const extractedMatch = imgSrc.match(/extracted\/(\d+)\/(.+)/);
        const isValidImageType = /\.(png|jpg|jpeg|webp)$/i.test(imgSrc);

        if (extractedMatch && isValidImageType) {
          const [, extractedId, imagePath] = extractedMatch;
          contentUrl = `https://arxiv.org/html/${arxivId}/extracted/${extractedId}/${imagePath}`;
        } else if (isValidImageType) {
          contentUrl = `https://arxiv.org/html/${arxivId}/${imgSrc}`;
        }

        if (contentUrl) {
          const summarizedCaption = await summarizeCaption(originalCaption);

          return {
            type: "figure",
            index: index + 1,
            caption: summarizedCaption,
            originalCaption: originalCaption,
            content: contentUrl,
            identifier: `Figure-${index + 1}`,
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error(`Error processing figure ${index + 1}:`, error);
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
        .update({ paperGraphics: [] })
        .eq("id", paper.id);
      return;
    }

    // Simulate page load and initial scanning
    await delay(getReadingTime(html.slice(0, 1000))); // Read first 1000 chars

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const graphics = [];

    // Process only first 4 figures like a human would typically focus on
    const figureElements = Array.from(
      document.querySelectorAll(".ltx_figure")
    ).slice(0, 4);

    for (const [index, figure] of figureElements.entries()) {
      const processedFigure = await processFigure(figure, index, paper.arxivId);
      if (processedFigure) {
        graphics.push(processedFigure);
        // Take a short break between figures like a human would
        await delay(getHumanDelay(5000));
      }
    }

    graphics.sort((a, b) => a.index - b.index);

    if (graphics.length > 0) {
      // Simulate reviewing the collected data before saving
      await delay(getHumanDelay(8000));

      await supabase
        .from("arxivPapersData")
        .update({ paperGraphics: graphics })
        .eq("id", paper.id);

      console.log(`Saved ${graphics.length} figures from paper ${paper.id}`);
    } else {
      await supabase
        .from("arxivPapersData")
        .update({ paperGraphics: [] })
        .eq("id", paper.id);
    }
  } catch (error) {
    console.error(`Error analyzing paper ${paper.id}:`, error);
    await supabase
      .from("arxivPapersData")
      .update({ paperGraphics: [] })
      .eq("id", paper.id);
  }
}

async function main() {
  console.log("\n=== Starting paper analysis ===\n");

  try {
    let startIndex = 0;
    let hasMore = true;

    while (hasMore) {
      // Simulate session-like behavior with breaks between batches
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
        .is("paperGraphics", null)
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
