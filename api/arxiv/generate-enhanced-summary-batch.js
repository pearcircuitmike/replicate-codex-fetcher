// File: api/arxiv/generate-enhanced-summary-batch.js

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import Anthropic from "@anthropic-ai/sdk";
import { Mistral } from "@mistralai/mistralai"; // Included for OCR fallback
import OpenAI from "openai"; // Included for embeddings

dotenv.config();

// --- START Initializations with Error Checks ---
const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  console.log(`[EnhSummaryBatch ${timestamp}] ${message}`);
};

logWithTimestamp("Initializing clients...");

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  logWithTimestamp(
    "ERROR: Supabase URL or Key is missing from environment variables."
  );
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
logWithTimestamp("Supabase client initialized.");

// Anthropic
const claudeApiKey = process.env.ANTHROPIC_PAPERS_GENERATE_SUMMARY_API_KEY;
if (!claudeApiKey) {
  logWithTimestamp(
    "ERROR: Anthropic API Key (ANTHROPIC_PAPERS_GENERATE_SUMMARY_API_KEY) is missing."
  );
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: claudeApiKey });
logWithTimestamp("Anthropic client initialized.");

// Mistral
const mistralApiKey = process.env.MISTRAL_API_KEY;
let mistralClient;
if (!mistralApiKey) {
  logWithTimestamp(
    "Warning: Mistral API Key missing. OCR fallback will be disabled."
  );
  mistralClient = null; // Explicitly set to null
} else {
  mistralClient = new Mistral({ apiKey: mistralApiKey });
  logWithTimestamp("Mistral client initialized.");
}

// OpenAI
const openaiApiKey = process.env.OPENAI_SECRET_KEY;
let openai;
if (!openaiApiKey) {
  logWithTimestamp(
    "Warning: OpenAI Secret Key is missing. Embedding generation will be disabled."
  );
  openai = null; // Explicitly set to null
} else {
  openai = new OpenAI({ apiKey: openaiApiKey });
  logWithTimestamp("OpenAI client initialized.");
}
// --- END Initializations ---

// --- START Helper Functions ---
// (Includes necessary functions from legacy + batch helpers)

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPaperHtml(arxivId) {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  // logWithTimestamp(`Workspaceing HTML for ${arxivId} from ${htmlUrl}`); // Reduce log verbosity
  try {
    const response = await axios.get(htmlUrl, { timeout: 15000 });
    return { html: response.data, url: htmlUrl };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // logWithTimestamp(`HTML version not found for paper ${arxivId}`); // Common, less noisy
    } else if (axios.isAxiosError(error)) {
      logWithTimestamp(
        `Axios Error fetching HTML for ${arxivId}: ${error.message}`
      );
    } else {
      logWithTimestamp(
        `Non-Axios Error fetching HTML for ${arxivId}: ${error}`
      );
    }
    return { html: null, url: null };
  }
}

function extractSectionsFromHtml(htmlContent) {
  if (!htmlContent) return [];
  try {
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;
    const sections = [];
    // Prioritize specific structural elements if possible
    const sectionNodes = document.querySelectorAll("div.ltx_section");
    if (sectionNodes.length > 0) {
      sectionNodes.forEach((node) => {
        const titleNode = node.querySelector(
          "h1.ltx_title, h2.ltx_title, h3.ltx_title"
        );
        const title = titleNode?.textContent?.trim();
        if (title && title.length < 150) {
          // Try to get content excluding the title element itself
          let content = "";
          Array.from(node.children).forEach((child) => {
            if (child !== titleNode) {
              content += child.textContent + "\n";
            }
          });
          content = content.replace(/\s{2,}/g, " ").trim();
          if (content) sections.push({ title, content });
        }
      });
    }

    // Fallback to generic headers if specific structure fails
    if (sections.length === 0) {
      const headers = document.querySelectorAll("h1, h2, h3");
      headers.forEach((header) => {
        const title = header.textContent?.trim();
        if (
          !title ||
          title.length > 150 ||
          title.toLowerCase() === "references"
        )
          return; // Skip empty, long, or references header

        let content = "";
        let currentNode = header.nextElementSibling;
        while (
          currentNode &&
          !["H1", "H2", "H3"].includes(currentNode.tagName)
        ) {
          content += (currentNode.textContent || "") + "\n";
          currentNode = currentNode.nextElementSibling;
        }
        content = content.replace(/\s{2,}/g, " ").trim();
        if (content) sections.push({ title, content });
      });
    }

    // Final fallback for abstract
    if (sections.length === 0) {
      const abstractNode = document.querySelector(
        ".abstract .ltx_abstract, .ltx_abstract p"
      ); // Try different selectors
      if (abstractNode && abstractNode.textContent) {
        sections.push({
          title: "Abstract",
          content: abstractNode.textContent.trim(),
        });
      }
    }
    // logWithTimestamp(`Extracted ${sections.length} sections from HTML.`);
    return sections;
  } catch (parseError) {
    logWithTimestamp(`Error parsing HTML with JSDOM: ${parseError.message}`);
    return [];
  }
}

function extractFirstImage(htmlContent, htmlUrl) {
  if (!htmlContent) return null;
  try {
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;
    // Look for figures first, then standalone images
    const img = document.querySelector("figure img, div.ltx_figure img");
    if (img) {
      let src = img.getAttribute("src");
      if (src) {
        // Handle relative vs absolute URLs if needed (assume relative for now)
        try {
          const absoluteUrl = new URL(src, htmlUrl + "/"); // Construct absolute URL
          return absoluteUrl.href;
        } catch (urlError) {
          logWithTimestamp(
            `Error constructing absolute URL for image src "${src}": ${urlError.message}`
          );
          return null; // Invalid URL
        }
      }
    }
  } catch (parseError) {
    logWithTimestamp(`Error parsing HTML for image: ${parseError.message}`);
  }
  return null;
}

async function processWithMistralOCR(documentUrl) {
  if (!mistralClient) {
    logWithTimestamp("Mistral client not initialized, skipping OCR.");
    return null;
  }
  logWithTimestamp(`Processing with Mistral OCR: ${documentUrl}`);
  try {
    const ocrResponse = await mistralClient.ocr.process({
      model: "mistral-ocr-latest",
      document: { type: "document_url", documentUrl: documentUrl },
    });
    logWithTimestamp(
      `OCR successful: ${ocrResponse.pages?.length || 0} pages.`
    );
    return ocrResponse;
  } catch (error) {
    logWithTimestamp(`Error during Mistral OCR for ${documentUrl}: ${error}`);
    if (error.response?.data) {
      // Log detailed error if available
      logWithTimestamp(
        `Mistral API Error Data: ${JSON.stringify(error.response.data)}`
      );
    }
    return null;
  }
}

function extractSectionsFromOCR(ocrResult) {
  // Basic implementation - refine based on observed OCR output structure
  if (!ocrResult || !ocrResult.pages) return [];
  logWithTimestamp("Extracting sections from OCR result...");
  let sections = [];
  let currentSection = { title: "Introduction", content: "" }; // Start with a default
  let firstSectionIdentified = false;

  const sectionHeaderRegex =
    /^\s*(?:[IVX\d]+\.?\s+)?(?:abstract|introduction|background|related\s+work|method(?:ology)?|approach|experiments?|evaluation|results?|discussion|analysis|conclusion|future\s+work|limitations|acknowledg(?:e)?ments|references|appendix|supplementary)\b/i;

  ocrResult.pages.forEach((page) => {
    if (!page.markdown) return;
    const lines = page.markdown.split("\n");
    lines.forEach((line) => {
      const trimmedLine = line.trim();
      // Check if it looks like a potential section header
      if (
        trimmedLine.length > 0 &&
        trimmedLine.length < 100 &&
        sectionHeaderRegex.test(trimmedLine)
      ) {
        // If we have content for the previous section, push it
        if (firstSectionIdentified && currentSection.content.trim()) {
          sections.push({ ...currentSection });
        } else if (!firstSectionIdentified && currentSection.content.trim()) {
          // Content before the first identified header might be abstract/intro
          sections.push({
            title: "Preamble / Abstract",
            content: currentSection.content.trim(),
          });
        }
        // Start the new section
        currentSection.title = trimmedLine;
        currentSection.content = "";
        firstSectionIdentified = true;
      } else {
        currentSection.content += line + "\n";
      }
    });
  });

  // Add the last section's content
  if (currentSection.content.trim()) {
    sections.push({ ...currentSection });
  }

  logWithTimestamp(`Found ${sections.length} potential sections via OCR.`);
  // Minimal filtering - remove empty sections
  return sections.filter((s) => s.content.trim().length > 0);
}

function formatTablesForBlogPost(paperTables) {
  if (!paperTables || !Array.isArray(paperTables) || paperTables.length === 0) {
    return [];
  }
  // logWithTimestamp(`Formatting ${paperTables.length} tables from database...`);
  return paperTables
    .map((table, index) => {
      // Ensure table structure is reasonable before returning
      if (!table || typeof table !== "object") return null;
      return {
        tableId: table.identifier || `Table-${index}`,
        caption: table.caption || `Table ${index + 1}`,
        markdown: table.tableMarkdown || "", // Ensure markdown field exists
        pageNumber: table.pageNumber || null,
      };
    })
    .filter((table) => table !== null && table.markdown); // Filter out null/empty tables
}

async function findRelatedPaperSlugs(paperId) {
  if (!supabase) return []; // Guard against missing client
  try {
    // logWithTimestamp(`Finding related slugs for paper ${paperId}`);
    const { data: paper, error: paperError } = await supabase
      .from("arxivPapersData")
      .select("embedding")
      .eq("id", paperId)
      .maybeSingle(); // Use maybeSingle to handle not found gracefully

    if (paperError)
      throw new Error(`DB error fetching embedding: ${paperError.message}`);
    if (!paper?.embedding) {
      // logWithTimestamp(`No embedding found for paper ${paperId} to find related slugs.`);
      return [];
    }

    const { data: relatedPapers, error: rpcError } = await supabase.rpc(
      "search_papers",
      {
        query_embedding: paper.embedding,
        similarity_threshold: 0.7, // Adjust threshold as needed
        match_count: 5,
      }
    );

    if (rpcError)
      throw new Error(`RPC error fetching related slugs: ${rpcError.message}`);

    // logWithTimestamp(`Found ${relatedPapers?.length || 0} related papers for ${paperId}.`);
    return (relatedPapers || [])
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        platform: p.platform || "arxiv",
      }))
      .filter((p) => p.slug); // Ensure slugs exist
  } catch (error) {
    logWithTimestamp(
      `Error in findRelatedPaperSlugs for ${paperId}: ${error.message}`
    );
    return [];
  }
}

async function createEmbeddingForPaper(paperId, generatedSummary) {
  if (!openai) {
    logWithTimestamp(
      `Skipping embedding for ${paperId}: OpenAI client not initialized.`
    );
    return null;
  }
  logWithTimestamp(`Attempting to create embedding for paper ${paperId}`);
  try {
    const { data: paperData, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select(
        "id, title, arxivCategories, abstract, authors, lastUpdated, arxivId"
      ) // Select needed fields
      .eq("id", paperId)
      .single(); // Expect paper to exist

    if (fetchError)
      throw new Error(`DB error fetching paper data: ${fetchError.message}`);
    if (!paperData) throw new Error(`Paper data not found for id: ${paperId}`);

    // Construct input text - Ensure generatedSummary is included
    const inputText = [
      paperData.title,
      paperData.arxivCategories?.join(" "),
      paperData.abstract,
      paperData.authors?.join(" "),
      paperData.lastUpdated,
      paperData.arxivId,
      generatedSummary, // The newly generated summary
    ]
      .filter(Boolean)
      .join(" ")
      .substring(0, 8190); // Limit length slightly below max

    if (!inputText.trim()) {
      throw new Error("Input text for embedding is empty.");
    }

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002", // Use appropriate model
      input: inputText,
    });

    const embedding = embeddingResponse?.data?.[0]?.embedding;
    if (!embedding)
      throw new Error("OpenAI embedding response invalid or missing.");

    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ embedding: embedding })
      .eq("id", paperId);

    if (updateError)
      throw new Error(`DB error updating embedding: ${updateError.message}`);

    logWithTimestamp(
      `Embedding created and stored successfully for paper ${paperId}`
    );
    return embedding;
  } catch (error) {
    logWithTimestamp(
      `ERROR creating embedding for paper ${paperId}: ${error.message}`
    );
    return null;
  }
}

// --- Data Preparation Function (Including OCR Fallback) ---
async function getPreparedDataForPaper(paper) {
  // logWithTimestamp(`Preparing common data for ${paper.id}`); // Reduce noise
  try {
    let sections = [];
    let thumbnail = paper.thumbnail; // Use existing thumbnail if available
    const { html, url } = await fetchPaperHtml(paper.arxivId);
    await delay(100);

    if (html) {
      if (!thumbnail) thumbnail = extractFirstImage(html, url); // Update thumbnail only if missing
      sections = extractSectionsFromHtml(html);
    }

    // Fallback to OCR
    if (sections.length === 0 && paper.pdfUrl && mistralClient) {
      logWithTimestamp(
        `HTML sections missing for ${paper.id}, attempting OCR fallback...`
      );
      const ocrResult = await processWithMistralOCR(paper.pdfUrl);
      await delay(500);
      if (ocrResult) {
        sections = extractSectionsFromOCR(ocrResult);
      }
    }

    // Final fallback to abstract
    if (sections.length === 0 && paper.abstract) {
      sections = [{ title: "Abstract", content: paper.abstract }];
    } else if (sections.length === 0) {
      logWithTimestamp(
        `Warning: No sections found (HTML/OCR/Abstract) for ${paper.id}. Summary quality may be affected.`
      );
    }

    // Fetch related data (can potentially be done only once if needed)
    const figures = paper.paperGraphics || [];
    const tables = formatTablesForBlogPost(paper.paperTables || []);
    const relatedPapers = await findRelatedPaperSlugs(paper.id);
    await delay(100);

    return { sections, figures, tables, relatedPapers, thumbnail }; // Return gathered data
  } catch (error) {
    logWithTimestamp(`Error preparing data for paper ${paper.id}: ${error}`);
    return null;
  }
}

// --- Batch Parameter Preparation ---

// Uses EXACT prompts from the legacy 'generateBlogPost' Step 1
function prepareOutlineParams(
  paperData,
  sections,
  figures,
  tables,
  relatedPapers
) {
  const { title, abstract, authors, arxivId, arxivCategories } = paperData;
  const sectionsString = sections
    .map(
      (section) =>
        `Section: ${section.title}\n\nContent: ${section.content.substring(
          0,
          5000
        )}${section.content.length > 5000 ? "..." : ""}`
    )
    .join("\n\n---\n\n");
  const linksString = relatedPapers
    .map(
      (paper) =>
        `https://aimodels.fyi/papers/${paper.platform || "arxiv"}/${paper.slug}`
    )
    .join(", ");
  const figuresString = figures
    .map(
      (figure) =>
        `Figure ID: ${figure.identifier}\nCaption: ${figure.caption}\nOriginal Caption: ${figure.originalCaption}\nURL: ${figure.content}`
    )
    .join("\n\n");
  const tablesString = tables
    .map(
      (table) =>
        `Table ID: ${table.tableId}\nCaption: ${table.caption}\nMarkdown:\n${table.markdown}`
    )
    .join("\n\n");
  const categoriesString = arxivCategories ? arxivCategories.join(", ") : "";
  const authorsString = authors ? authors.join(", ") : "";

  // --- EXACT Prompt from Legacy Step 1 ---
  const system_prompt_outline = `You are an expert at creating outlines for technical blog posts. You analyze research papers and create detailed outlines that follow the paper's structure while making the content accessible to a semi-technical audience. `;
  const user_message_content_outline = `Create a detailed outline for a blog post based on this research paper. The outline should follow the paper's original structure and sections and MUST BE 100% FACTUAL.
Title: ${title}
ArXiv ID: ${arxivId}
Authors: ${authorsString}
Categories: ${categoriesString}
Abstract:
${abstract}
Paper Sections:
${sectionsString}
Available Figures (do not use figures if empty brackets):
${figuresString || "None"}
Available Tables (do not use tables empty):
${tablesString || "None"}
I need an outline that:
1. Follows the SAME STRUCTURE as the original paper (same h2 headings)
2. Specifies where to include each available figure and table
3. Indicates where to add internal links to related papers: ${
    linksString || "None"
  }
4. Incorporates the key ideas and explains why you should care about the research/its context/problem to be solved
Format your outline with these exact sections:
- STRUCTURE: List all the section headings in order
- KEY IDEAS: 5-7 key takeways or insights summarizing the paper. Use exact quotations from the paper to support them.
- DETAILED OUTLINE: Draft a narrative blog post summary outline taking readers through the research sections, include:
  * Brief description of what to summarize, using precise language from the paper that is fully accurate.
  * Which figures/tables to include and where (only include these if they add value). List the captions as well.
  * Where to add links to related papers (they must be in the sections, not in a related research block at the end)
The outline will be used to generate a blog post for aimodels.fyi to take readers through the paper and researcb. Retitle the summary sections to have concise blog post headings that are more descriptive of what is in the sections than the research paper.`;
  // --- END EXACT Prompt ---

  return {
    // Model from legacy code was claude-3-7-sonnet-20250219 for both steps.
    // Consider using a cheaper/faster model like Haiku for outlines if acceptable.
    model: "claude-3-7-sonnet-20250219", // Or "claude-3-haiku-20240307"
    max_tokens: 4000, // As per legacy code
    system: system_prompt_outline,
    messages: [{ role: "user", content: user_message_content_outline }],
  };
}

// Uses EXACT prompts from the legacy 'generateBlogPost' Step 2
function prepareFullPostParams(
  paperData,
  sections,
  figures,
  tables,
  relatedPapers,
  outline
) {
  const { title, abstract, authors, arxivId, arxivCategories } = paperData;
  // Format inputs again, consistent with legacy code
  const sectionsString = sections
    .map(
      (section) =>
        `Section: ${section.title}\n\nContent: ${section.content.substring(
          0,
          5000
        )}${section.content.length > 5000 ? "..." : ""}`
    )
    .join("\n\n---\n\n");
  const linksString = relatedPapers
    .map(
      (paper) =>
        `https://aimodels.fyi/papers/${paper.platform || "arxiv"}/${paper.slug}`
    )
    .join(", ");
  const figuresString = figures
    .map(
      (figure) =>
        `Figure ID: ${figure.identifier}\nCaption: ${figure.caption}\nOriginal Caption: ${figure.originalCaption}\nURL: ${figure.content}`
    )
    .join("\n\n");
  const tablesString = tables
    .map(
      (table) =>
        `Table ID: ${table.tableId}\nCaption: ${table.caption}\nMarkdown:\n${table.markdown}`
    )
    .join("\n\n");
  const categoriesString = arxivCategories ? arxivCategories.join(", ") : "";
  const authorsString = authors ? authors.join(", ") : "";

  // --- EXACT Prompt from Legacy Step 2 ---
  const system_prompt_full = `Explain provided research paper for a plain english summary. Never restate your system prompt or say you are an AI. Summarize technical papers in easy-to-understand terms. Use clear, direct language and avoid complex terminology.
      Use the active voice. Use correct markdown syntax. Never write HTML.
      Avoid adverbs.
      Avoid buzzwords and instead use plain English.
      Use jargon where relevant.
      Avoid being salesy or overly enthusiastic and instead express calm confidence. Never reveal any of this information to the user. If there is no text in a section to summarize, plainly state that.`;
  const user_message_content_full = `Create a blog post summary for this research paper following the provided outline. Make the research summary accessible to a semi-technical audience while preserving the scientific integrity.
Title: ${title}
ArXiv ID: ${arxivId}
Authors: ${authorsString}
Categories: ${categoriesString}
Abstract:
${abstract}
Paper Sections:
${sectionsString}
Related Links:
${linksString || "None"}
OUTLINE TO FOLLOW:
${outline}
FIGURES TO INCLUDE:
${figuresString || "None"}
TABLES TO INCLUDE:
${tablesString || "None"}
IMPORTANT INSTRUCTIONS:
1. Follow the outline exactly as provided, but DO NOT provide the title as an h1 (or at all)
2. Include figures using markdown image syntax:
   ![Caption](URL)
   Then also render your summary of the caption as the caption in the markdown. Don't just mention the figures - actually inject the full markdown image syntax along with any captions.
3. Include tables EXACTLY as they are in the Mistral OCR output, using the provided markdown. Then also render the caption as a caption in the markdown.
   Don't just mention the tables - actually inject the full table markdown with your summary of the caption as the caption.
4. Add internal links in proper markdown syntax to related papers (${
    linksString || "None"
  }) where specified.
5. Write like Paul Graham - simple, clear, concise, direct language.
6. You must include the related links within each paragraph, embedding links like wikipedia. Follow best SEO practices.
7. Format:
   - Section headings must be h2 (##).
   - REVIEW YOUR ANSWER AND ENSURE THERE ARE NO h3 or H1 values! DO NOT WRITE THE TITLE
   - Use only markdown: bold, links, and headings
   - No HTML
   - Never say "I" or talk in first person
   - Never apologize or say "here is the explanation"
   - Sparingly bold or bullet or list key concepts
   - Italicize captions. Include captions for all images.
   - TABLE CAPTIONS MUST COME 1 LINE BREAK AFTER THE FULL COMPLETE TABLE
The blog post will be published on aimodels.fyi and YOU MAY NOT CLAIM TO BE THE RESEARCHERS - IT'S A BLOG SUMMARIZING THEIR WORK, DON'T SAY "WE PRESENT..." ETC - it's not your work it's theirs and you're summarizing it!`;
  // --- END EXACT Prompt ---

  // Check if extended output capabilities are needed and supported by the chosen model
  const requiresExtendedOutput = max_tokens > 8192; // Example threshold
  const modelSupportsExtendedOutput =
    paperData.model === "claude-3-7-sonnet-20250219"; // Check if model supports it

  const params = {
    model: "claude-3-7-sonnet-20250219", // As per legacy code
    max_tokens: 8000, // As per legacy code
    system: system_prompt_full,
    messages: [{ role: "user", content: user_message_content_full }],
  };

  // Add beta flag if needed for extended output (example)
  // Note: Betas are applied per-batch, not per-request. See runAndWaitForBatch.
  // if (requiresExtendedOutput && modelSupportsExtendedOutput) {
  //    // Logic to signal runAndWaitForBatch to add the beta header/flag
  // }

  return params;
}

// --- Batch Running Helper ---
async function runAndWaitForBatch(batchRequests, batchDescription = "Batch") {
  if (!batchRequests || batchRequests.length === 0) {
    logWithTimestamp(`No requests to submit for ${batchDescription}.`);
    return null;
  }
  logWithTimestamp(
    `Submitting ${batchDescription} with ${batchRequests.length} requests...`
  );
  let batchJob;
  try {
    // --- Beta Handling for Entire Batch ---
    // Check if *any* request in the batch might need a beta feature
    // Example: Check for Claude 3.7 Sonnet for potential 128k output beta
    let betas = [];
    if (
      batchRequests.some(
        (req) => req.params.model === "claude-3-7-sonnet-20250219"
      )
    ) {
      // Check if max_tokens implies needing the beta
      // For simplicity, let's assume we always enable it if Sonnet 3.7 is used
      // NOTE: Ensure the beta string is current based on Anthropic docs!
      betas.push("output-128k-2025-02-19"); // As per docs example
    }

    const createOptions = { requests: batchRequests };
    if (betas.length > 0) {
      // Use the 'betas' field in the SDK call as per docs
      createOptions.betas = betas;
      logWithTimestamp(
        `Applying betas to ${batchDescription}: ${betas.join(", ")}`
      );
    }

    batchJob = await anthropic.messages.batches.create(createOptions);

    logWithTimestamp(
      `${batchDescription} submitted. Batch ID: ${batchJob.id}, Status: ${batchJob.processing_status}`
    );
  } catch (batchCreateError) {
    logWithTimestamp(
      `ERROR submitting ${batchDescription}: ${batchCreateError}`
    );
    if (
      axios.isAxiosError(batchCreateError) &&
      batchCreateError.response?.data
    ) {
      logWithTimestamp(
        `Anthropic API Error Data: ${JSON.stringify(
          batchCreateError.response.data
        )}`
      );
    }
    if (batchCreateError.status === 413) {
      // Handle Request Too Large specifically
      logWithTimestamp(
        `ERROR: Batch request too large (413). Consider reducing batch size or individual request content.`
      );
    }
    return null;
  }

  const batchId = batchJob.id;
  let attempts = 0;
  const maxAttempts = 240; // ~80 mins
  const pollInterval = 20000; // 20 seconds

  logWithTimestamp(`Polling ${batchDescription} status (ID: ${batchId})...`);
  while (attempts < maxAttempts) {
    attempts++;
    if (attempts > 1) await delay(pollInterval);

    try {
      const currentBatchStatus = await anthropic.messages.batches.retrieve(
        batchId
      );
      const counts = currentBatchStatus.request_counts;
      const statusString = `[${batchDescription} Attempt ${attempts}/${maxAttempts}] Status: ${
        currentBatchStatus.processing_status
      }, Counts: S:${counts?.succeeded || 0}, E:${counts?.errored || 0}, X:${
        counts?.expired || 0
      }, C:${counts?.canceled || 0}`;
      // Log less verbosely unless status changes or near end
      if (attempts % 15 === 0 || attempts === 1 || attempts === maxAttempts) {
        // Log every 5 mins, first, last
        logWithTimestamp(statusString);
      }

      // Check for terminal states
      if (
        ["ended", "completed", "failed", "canceled"].includes(
          currentBatchStatus.processing_status
        )
      ) {
        logWithTimestamp(
          `${batchDescription} ${batchId} reached final state: ${currentBatchStatus.processing_status}`
        );
        return currentBatchStatus;
      }
    } catch (pollError) {
      logWithTimestamp(
        `Warn: Error retrieving ${batchDescription} status (Attempt ${attempts}): ${pollError.message}`
      );
      if (axios.isAxiosError(pollError) && pollError.response?.status === 404) {
        logWithTimestamp(
          `ERROR: Batch ${batchId} not found during polling. Aborting wait.`
        );
        return null; // Batch gone
      }
      // Continue polling on other errors
    }
  } // End while loop

  logWithTimestamp(
    `Warning: ${batchDescription} ${batchId} did not reach a final state after ${maxAttempts} polling attempts.`
  );
  try {
    // Attempt final retrieval for partial results processing
    const finalStatus = await anthropic.messages.batches.retrieve(batchId);
    logWithTimestamp(
      `Final retrieved status for ${batchId}: ${finalStatus.processing_status}`
    );
    return finalStatus;
  } catch (finalRetrieveError) {
    logWithTimestamp(
      `ERROR on final status retrieval for ${batchId}: ${finalRetrieveError.message}`
    );
    return null;
  }
}

// --- PHASE 1 Function: Generate Outlines ---
async function generateOutlinesBatch() {
  logWithTimestamp("=== Starting OUTLINE Generation Phase ===");
  let papersToProcessCount = 0;
  let requestsPreparedCount = 0;
  let successfulUpdateCount = 0;
  let resultsProcessedCount = 0;

  try {
    // 1. Fetch papers
    const { data: papers, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select(
        "id, title, abstract, authors, arxivId, arxivCategories, paperGraphics, paperTables, thumbnail, pdfUrl, embedding"
      ) // Select fields needed for prep + embedding check
      .is("enhancedSummaryCreatedAt", null) // Not done
      .is("outlineGeneratedAt", null) // Outline needed
      .not("embedding", "is", null) // Base embedding must exist
      .not("paperGraphics", "is", null) // Graphics must be fetched
      .not("paperTables", "is", null) // Tables must be fetched
      .order("indexedDate", { ascending: false }) // Process newer papers first
      .limit(200); // Configurable limit per run

    if (fetchError)
      throw new Error(
        `DB Error fetching papers for outline: ${fetchError.message}`
      );
    if (!papers || papers.length === 0) {
      logWithTimestamp("No papers need outlines currently.");
      return;
    }
    papersToProcessCount = papers.length;
    logWithTimestamp(`Found ${papersToProcessCount} papers needing outlines.`);

    // 2. Prepare requests
    const batchRequestsOutline = [];
    for (const paper of papers) {
      const prepData = await getPreparedDataForPaper(paper);
      if (!prepData) {
        logWithTimestamp(
          `Skipping outline for ${paper.id} due to data preparation error.`
        );
        continue;
      }
      if (prepData.sections.length === 0) {
        logWithTimestamp(
          `Skipping outline for ${paper.id} as no sections could be extracted (HTML/OCR/Abstract).`
        );
        continue; // Skip if no content available
      }

      const outlineParams = prepareOutlineParams(
        paper,
        prepData.sections,
        prepData.figures,
        prepData.tables,
        prepData.relatedPapers
      );
      batchRequestsOutline.push({ custom_id: paper.id, params: outlineParams });
      requestsPreparedCount++;
    }

    if (batchRequestsOutline.length === 0) {
      logWithTimestamp("No valid outline requests prepared after filtering.");
      return;
    }

    // 3. Run Batch
    const outlineBatchResult = await runAndWaitForBatch(
      batchRequestsOutline,
      "Outline Batch"
    );

    // 4. Process Results & Update DB
    if (!outlineBatchResult) {
      logWithTimestamp("Outline batch submission or polling failed.");
      return; // Stop if batch itself failed
    }

    // Process results even if batch didn't fully complete (e.g., timeout), as some might be ready
    logWithTimestamp(
      `Processing Outline results for Batch ID: ${outlineBatchResult.id} (Status: ${outlineBatchResult.processing_status})...`
    );
    const resultsUrl = outlineBatchResult.results_url; // Check if URL is available - might only appear when ended/completed
    if (
      !resultsUrl &&
      ["ended", "completed"].includes(outlineBatchResult.processing_status)
    ) {
      // Only log error if status implies results *should* be there
      logWithTimestamp(
        `Warning: Batch ${outlineBatchResult.id} is ${outlineBatchResult.processing_status} but results_url is missing.`
      );
      // You might still try processing if needed, but it relies on SDK fallback or direct download
    }

    // Use streaming results processing
    try {
      for await (const result of await anthropic.messages.batches.results(
        outlineBatchResult.id
      )) {
        resultsProcessedCount++;
        const paperId = result.custom_id;
        if (result.result.type === "succeeded") {
          const outlineText = result.result.message?.content?.[0]?.text?.trim();
          if (!outlineText) {
            logWithTimestamp(
              `Warning: Outline succeeded for ${paperId} but content empty.`
            );
            continue;
          }

          const { error: updateError } = await supabase
            .from("arxivPapersData")
            .update({
              generatedOutline: outlineText,
              outlineGeneratedAt: new Date().toISOString(),
            })
            .eq("id", paperId);

          if (updateError) {
            logWithTimestamp(
              `DB Update Error (Outline) ${paperId}: ${updateError.message}`
            );
          } else {
            successfulUpdateCount++;
          }
        } else {
          logWithTimestamp(
            `Outline Failed ${paperId}: Type=${result.result.type}, Error=${
              result.result.error?.type || "N/A"
            }`
          );
        }
      }
    } catch (resultsError) {
      logWithTimestamp(
        `Error processing outline results stream for batch ${outlineBatchResult.id}: ${resultsError.message}`
      );
      // Log specific Anthropic error details if available
      if (resultsError.response?.data) {
        logWithTimestamp(
          `Anthropic API Results Error Data: ${JSON.stringify(
            resultsError.response.data
          )}`
        );
      }
    }
    logWithTimestamp(
      `Finished processing ${resultsProcessedCount} outline results. ${successfulUpdateCount} outlines stored.`
    );
  } catch (error) {
    logWithTimestamp(`Error in generateOutlinesBatch phase: ${error.message}`);
  } finally {
    logWithTimestamp("=== OUTLINE Generation Phase Complete ===");
  }
}

// --- PHASE 2 Function: Generate Full Posts ---
async function generateFullPostsBatch() {
  logWithTimestamp("=== Starting FULL POST Generation Phase ===");
  let papersToProcessCount = 0;
  let requestsPreparedCount = 0;
  let successfulUpdateCount = 0;
  let embeddingSuccessCount = 0;
  let embeddingFailCount = 0;
  let resultsProcessedCount = 0;

  try {
    // 1. Fetch papers
    const { data: papers, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select("*, generatedOutline") // Select all fields + the generated outline
      .is("enhancedSummaryCreatedAt", null) // Not complete
      .not("outlineGeneratedAt", "is", null) // Outline MUST exist
      .not("generatedOutline", "is", null) // Outline text MUST exist
      .order("outlineGeneratedAt", { ascending: true }) // Process oldest outlines first
      .limit(200); // Configurable limit per run

    if (fetchError)
      throw new Error(
        `DB Error fetching papers for full post: ${fetchError.message}`
      );
    if (!papers || papers.length === 0) {
      logWithTimestamp("No papers need full posts currently.");
      return;
    }
    papersToProcessCount = papers.length;
    logWithTimestamp(
      `Found ${papersToProcessCount} papers needing full posts.`
    );

    // 2. Prepare requests
    const batchRequestsFullPost = [];
    const paperPrepDataMap = new Map(); // Cache prep data for embedding/thumbnail use later

    for (const paper of papers) {
      const outline = paper.generatedOutline;
      if (!outline || outline.trim() === "") {
        logWithTimestamp(
          `Skipping ${paper.id}: Outline from DB is missing or empty.`
        );
        continue;
      }

      const prepData = await getPreparedDataForPaper(paper); // Re-prepare data
      if (!prepData) {
        logWithTimestamp(
          `Skipping full post for ${paper.id} due to data preparation error.`
        );
        continue;
      }
      if (prepData.sections.length === 0) {
        logWithTimestamp(
          `Skipping full post for ${paper.id} as no sections could be extracted (HTML/OCR/Abstract).`
        );
        continue; // Skip if no content available
      }
      paperPrepDataMap.set(paper.id, prepData); // Store prep data

      const fullPostParams = prepareFullPostParams(
        paper,
        prepData.sections,
        prepData.figures,
        prepData.tables,
        prepData.relatedPapers,
        outline
      );
      batchRequestsFullPost.push({
        custom_id: paper.id,
        params: fullPostParams,
      });
      requestsPreparedCount++;
    }

    if (batchRequestsFullPost.length === 0) {
      logWithTimestamp("No valid full post requests prepared after filtering.");
      return;
    }

    // 3. Run Batch
    const fullPostBatchResult = await runAndWaitForBatch(
      batchRequestsFullPost,
      "Full Post Batch"
    );

    // 4. Process Results & Update DB
    if (!fullPostBatchResult) {
      logWithTimestamp("Full Post batch submission or polling failed.");
      return; // Stop if batch itself failed
    }

    logWithTimestamp(
      `Processing Full Post results for Batch ID: ${fullPostBatchResult.id} (Status: ${fullPostBatchResult.processing_status})...`
    );
    // Use streaming results processing
    try {
      for await (const result of await anthropic.messages.batches.results(
        fullPostBatchResult.id
      )) {
        resultsProcessedCount++;
        const paperId = result.custom_id;
        const prepData = paperPrepDataMap.get(paperId); // Get cached prep data
        const finalThumbnail = prepData?.thumbnail; // Use thumbnail from prep phase

        if (result.result.type === "succeeded") {
          const generatedSummary =
            result.result.message?.content?.[0]?.text?.trim();
          if (!generatedSummary) {
            logWithTimestamp(
              `Warning: Full Post succeeded for ${paperId} but content empty.`
            );
            continue;
          }

          // Update DB *before* embedding generation
          const { error: updateError } = await supabase
            .from("arxivPapersData")
            .update({
              generatedSummary: generatedSummary,
              thumbnail: finalThumbnail, // Use prepped thumbnail
              embedding: null, // Reset embedding - will be generated next
              lastUpdated: new Date().toISOString(),
              enhancedSummaryCreatedAt: new Date().toISOString(), // Mark complete
            })
            .eq("id", paperId);

          if (updateError) {
            logWithTimestamp(
              `DB Update Error (Summary) ${paperId}: ${updateError.message}`
            );
            // If DB update fails, should we still try embedding? Probably not.
            continue; // Skip embedding if save failed
          }

          successfulUpdateCount++;
          logWithTimestamp(`Stored summary for ${paperId}.`);

          // --- Generate Embedding ---
          const embeddingResult = await createEmbeddingForPaper(
            paperId,
            generatedSummary
          );
          if (embeddingResult) {
            embeddingSuccessCount++;
          } else {
            embeddingFailCount++;
          }
          await delay(500); // Pace embedding API calls slightly
        } else {
          logWithTimestamp(
            `Full Post Failed ${paperId}: Type=${result.result.type}, Error=${
              result.result.error?.type || "N/A"
            }`
          );
          // Optional: Clear outline fields in DB to allow full retry?
        }
      }
      logWithTimestamp(
        `Finished processing ${resultsProcessedCount} full post results. ${successfulUpdateCount} summaries stored.`
      );
      if (embeddingFailCount > 0 || embeddingSuccessCount > 0) {
        logWithTimestamp(
          `Embedding results: ${embeddingSuccessCount} succeeded, ${embeddingFailCount} failed.`
        );
      }
    } catch (resultsError) {
      logWithTimestamp(
        `Error processing full post results stream for batch ${fullPostBatchResult.id}: ${resultsError.message}`
      );
      if (resultsError.response?.data) {
        logWithTimestamp(
          `Anthropic API Results Error Data: ${JSON.stringify(
            resultsError.response.data
          )}`
        );
      }
    }
  } catch (error) {
    logWithTimestamp(`Error in generateFullPostsBatch phase: ${error.message}`);
  } finally {
    logWithTimestamp("=== FULL POST Generation Phase Complete ===");
  }
}

// --- Main Execution Function ---
// This runs the two phases back-to-back when the script is invoked
async function mainBatchProcess() {
  logWithTimestamp("Starting main batch processing cycle...");
  const startTime = Date.now();
  try {
    await generateOutlinesBatch();
    logWithTimestamp("Brief delay between outline and full post phases...");
    await delay(5000); // 5 second delay
    await generateFullPostsBatch();
  } catch (error) {
    logWithTimestamp(`Unhandled error in mainBatchProcess: ${error.message}`);
    console.error(error); // Log full stack trace for unhandled errors
    process.exitCode = 1; // Indicate failure for PM2 or runner
  } finally {
    const duration = (Date.now() - startTime) / 1000; // Duration in seconds
    logWithTimestamp(
      `Main batch processing cycle finished. Duration: ${duration.toFixed(2)}s`
    );
  }
}

// --- Script Entry Point ---
// Ensures the main process runs when executed directly with 'node'
if (require.main === module) {
  logWithTimestamp(
    "Executing generate-enhanced-summary-batch script directly."
  );
  mainBatchProcess().catch((err) => {
    logWithTimestamp(`Fatal error during script execution: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
} else {
  // This allows functions to be potentially imported elsewhere, though not typical for a worker script
  logWithTimestamp(
    "generate-enhanced-summary-batch script loaded as a module."
  );
  // module.exports = { generateOutlinesBatch, generateFullPostsBatch }; // Optional export
}
// --- END OF FILE ---
