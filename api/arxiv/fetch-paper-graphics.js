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

const BATCH_SIZE = 100;
const MIN_DELAY = 2000; // Minimum 2 seconds
const MAX_DELAY = 5000; // Maximum 5 seconds
const MIN_RETRY_DELAY = 20000; // Minimum 20 seconds for retry
const MAX_RETRY_DELAY = 40000; // Maximum 40 seconds for retry
const MAX_RETRIES = 3;

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function summarizeCaption(caption) {
  console.log("Summarizing caption...");
  try {
    const result =
      await model.generateContent(`Rewrite this figure caption to be clear and concise in plain text with no special notation or figures in 10 words that state the key takeaway. "${caption}"
    
    Do not say "our" or imply you did the work. Just be matter of fact in third person. Do not say "Caption" or anything. Just provide the caption by itself.`);

    console.log("Caption summarization completed");
    return result.response.text().trim();
  } catch (error) {
    console.error("Error in summarizeCaption:", error);
    throw error;
  }
}

async function fetchPaper(arxivId, retryCount = 0) {
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
    if (error.response && error.response.status === 403) {
      if (retryCount < MAX_RETRIES) {
        const retryDelay = getRandomDelay(MIN_RETRY_DELAY, MAX_RETRY_DELAY);
        console.log(
          `Rate limited. Waiting ${retryDelay / 1000} seconds before retry ${
            retryCount + 1
          }...`
        );
        await delay(retryDelay);
        return fetchPaper(arxivId, retryCount + 1);
      }
    }
    console.error(`Failed to fetch ${arxivId}:`, error);
    return null;
  }
}

async function processFigure(figure, index, arxivId) {
  console.log(`Processing Figure ${index + 1}`);
  try {
    const originalCaption =
      figure.querySelector(".ltx_caption")?.textContent?.trim() || "";
    const images = figure.querySelectorAll("img");

    console.log(`Found ${images.length} images in figure`);
    console.log(
      `Original caption found: ${originalCaption.substring(0, 50)}...`
    );

    for (const img of images) {
      const imgSrc = img.getAttribute("src");
      console.log(`Raw image src: ${imgSrc}`);

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
          console.log(`Constructed URL: ${contentUrl}`);
          console.log("Getting summarized caption...");
          const summarizedCaption = await summarizeCaption(originalCaption);
          console.log(`Summarized caption: ${summarizedCaption}`);

          console.log(`Successfully processed figure ${index + 1}`);
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
    console.log(`No valid images found in figure ${index + 1}`);
    return null;
  } catch (error) {
    console.error(`Error processing figure ${index + 1}:`, error);
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
        .update({ paperGraphics: [] })
        .eq("id", paper.id);
      return;
    }
    console.log(`HTML content length: ${html.length} characters`);

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const graphics = [];

    const figureElements = Array.from(
      document.querySelectorAll(".ltx_figure")
    ).slice(0, 4);
    console.log(`Found ${figureElements.length} figure elements`);

    for (const [index, figure] of figureElements.entries()) {
      console.log(
        `\nProcessing figure ${index + 1} of ${figureElements.length}`
      );
      const processedFigure = await processFigure(figure, index, paper.arxivId);
      if (processedFigure) {
        graphics.push(processedFigure);
        console.log(`Successfully added figure ${index + 1} to results`);
      }
      if (graphics.length >= 8) {
        console.log("Reached maximum of 8 figures, stopping processing");
        break;
      }
    }

    graphics.sort((a, b) => a.index - b.index);
    console.log(`Total graphics processed: ${graphics.length}`);

    if (graphics.length > 0) {
      console.log("Updating Supabase with processed graphics...");
      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ paperGraphics: graphics })
        .eq("id", paper.id);

      if (updateError) throw updateError;
      console.log(
        `Successfully stored ${graphics.length} graphics for paper ${paper.id}`
      );
    } else {
      console.log(`No valid graphics found for paper ${paper.id}`);
      await supabase
        .from("arxivPapersData")
        .update({ paperGraphics: [] })
        .eq("id", paper.id);
    }
  } catch (error) {
    console.error(`Error processing paper ${paper.id}:`, error);
    await supabase
      .from("arxivPapersData")
      .update({ paperGraphics: [] })
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
        .is("paperGraphics", null)
        .order("totalScore", { ascending: false })
        .range(startIndex, startIndex + BATCH_SIZE - 1);

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
        const waitTime = getRandomDelay(MIN_DELAY, MAX_DELAY);
        console.log(
          `\nWaiting ${waitTime / 1000} seconds before next paper...`
        );
        await delay(waitTime);
      }

      startIndex += BATCH_SIZE;
    }
  } catch (error) {
    console.error("Error in main function:", error);
  }
  console.log("\n=== Paper processing complete ===\n");
}

main().catch(console.error);
