// File: api/arxiv/generate-enhanced-summary-batch.js

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import Anthropic from "@anthropic-ai/sdk";
import { Mistral } from "@mistralai/mistralai";
import OpenAI from "openai";
import { fileURLToPath } from "url"; // <-- Added for ESM check
import { resolve } from "path"; // <-- Added for ESM check

dotenv.config();

// --- START Initializations with Error Checks ---
const logWithTimestamp = (message) => {
  const timestamp = new Date().toLocaleString();
  // Add identifier for this specific script's logs
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
    const response = await axios.get(htmlUrl, { timeout: 15000 }); // Add timeout
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
  // Using the implementation from the legacy code provided
  if (!htmlContent) return [];
  // logWithTimestamp("Extracting sections from HTML content..."); // Reduce noise

  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  const sections = [];

  const sectionHeaders = document.querySelectorAll(
    "h1, h2, h3, .ltx_title_section, .section, .ltx_section" // Selectors from legacy code
  );

  if (sectionHeaders.length > 0) {
    for (let i = 0; i < sectionHeaders.length; i++) {
      const header = sectionHeaders[i];
      const title = header.textContent?.trim();

      // Skip logic from legacy code
      if (!title || title.length > 100) continue;

      let content = "";
      let currentNode = header.nextElementSibling;
      while (
        currentNode &&
        !["H1", "H2", "H3"].includes(currentNode.tagName) &&
        !currentNode.classList.contains("ltx_title_section") &&
        !currentNode.classList.contains("section") &&
        !currentNode.classList.contains("ltx_section")
      ) {
        content += (currentNode.textContent || "") + "\n";
        currentNode = currentNode.nextElementSibling;
        if (!currentNode) break; // Added break condition
      }
      content = content.replace(/\s{2,}/g, " ").trim(); // Basic cleanup
      if (content) sections.push({ title, content });
    }
  }

  // Fallback logic from legacy code
  if (sections.length === 0) {
    const divs = document.querySelectorAll("div.ltx_section, div.section");
    for (const div of divs) {
      const titleElement = div.querySelector(".ltx_title, h1, h2, h3");
      if (titleElement) {
        const title = titleElement.textContent?.trim();
        if (title) {
          let content = div.textContent?.replace(title, "").trim() || "";
          content = content.replace(/\s{2,}/g, " ").trim();
          if (content) sections.push({ title, content });
        }
      }
    }
  }

  // Final fallback logic from legacy code
  if (sections.length === 0) {
    const abstractNode = document.querySelector(".abstract, .ltx_abstract");
    if (abstractNode && abstractNode.textContent) {
      sections.push({
        title: "Abstract",
        content: abstractNode.textContent.trim(),
      });
    }
  }

  // logWithTimestamp(`Found ${sections.length} sections in the HTML content`);
  return sections.filter((s) => s.content); // Ensure content exists
}

function extractFirstImage(htmlContent, htmlUrl) {
  // Using implementation from legacy code
  if (!htmlContent) return null;
  try {
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;
    const img = document.querySelector("figure img"); // Selector from legacy code
    if (img) {
      const src = img.getAttribute("src");
      if (src) {
        // Handle relative vs absolute URLs (assume relative based on legacy code)
        try {
          // Ensure proper URL construction
          const base = htmlUrl.endsWith("/") ? htmlUrl : htmlUrl + "/";
          const absoluteUrl = new URL(src, base);
          return absoluteUrl.href;
        } catch (urlError) {
          logWithTimestamp(
            `Error constructing image URL for src "${src}" relative to "${htmlUrl}": ${urlError.message}`
          );
          return null;
        }
      }
    }
  } catch (parseError) {
    logWithTimestamp(`Error parsing HTML for image: ${parseError.message}`);
  }
  return null;
}

async function processWithMistralOCR(documentUrl) {
  // Using implementation from legacy code
  if (!mistralClient) {
    logWithTimestamp("Mistral client not initialized, skipping OCR.");
    return null;
  }
  logWithTimestamp(`Processing document with Mistral OCR: ${documentUrl}`);
  try {
    // Legacy code requested includeImageBase64: true - keeping that.
    const ocrResponse = await mistralClient.ocr.process({
      model: "mistral-ocr-latest",
      document: { type: "document_url", documentUrl: documentUrl },
      includeImageBase64: true,
    });
    logWithTimestamp(
      `OCR processing complete with ${ocrResponse.pages?.length || 0} pages`
    );
    return ocrResponse;
  } catch (error) {
    logWithTimestamp(`Error processing document with Mistral OCR: ${error}`);
    if (error.response?.data) {
      logWithTimestamp(
        `Mistral API Error Data: ${JSON.stringify(error.response.data)}`
      );
    }
    return null;
  }
}

function extractSectionsFromOCR(ocrResult) {
  // Using implementation from legacy code
  if (!ocrResult || !ocrResult.pages) return [];
  logWithTimestamp("Extracting sections from OCR result (legacy method)...");
  const sections = [];
  const currentSection = { title: "Introduction", content: "" }; // Default start section
  const sectionPatterns = [
    /^introduction/i,
    /^background/i,
    /^related\s+work/i,
    /^methodology/i,
    /^method/i,
    /^approach/i,
    /^experiments?/i,
    /^experimental\s+results/i,
    /^evaluation/i,
    /^results?/i,
    /^discussion/i,
    /^analysis/i,
    /^conclusion/i,
    /^future\s+work/i,
    /^limitations/i,
    /^references/i,
    // Added common headers potentially missed
    /^abstract/i,
    /^acknowledg(?:e)?ments/i,
    /^appendix|supplementary/i,
  ];
  let firstSectionIdentified = false; // Track if we've found the first header

  ocrResult.pages.forEach((page) => {
    if (!page.markdown) return;
    const lines = page.markdown.split("\n");
    lines.forEach((line) => {
      const trimmedLine = line.trim();
      let isSectionHeader = false;
      if (trimmedLine.length > 0 && trimmedLine.length < 100) {
        // Basic sanity checks
        isSectionHeader = sectionPatterns.some((pattern) =>
          pattern.test(trimmedLine.toLowerCase())
        );
      }

      if (isSectionHeader) {
        // Save previous section's content if it exists
        if (currentSection.content.trim()) {
          // Use previous title, or a default if it's the very first block
          const titleToUse = firstSectionIdentified
            ? currentSection.title
            : "Preamble / Abstract";
          sections.push({
            title: titleToUse,
            content: currentSection.content.trim(),
          });
        }
        // Start new section
        currentSection.title = trimmedLine; // Use the matched line as title
        currentSection.content = "";
        firstSectionIdentified = true;
      } else {
        currentSection.content += line + "\n"; // Append content
      }
    });
  });
  // Add the last section
  if (currentSection.content.trim()) {
    sections.push({ ...currentSection });
  }

  logWithTimestamp(`Found ${sections.length} sections via legacy OCR method.`);
  return sections.filter((s) => s.content.trim()); // Filter empty sections
}

function formatTablesForBlogPost(paperTables) {
  // Using implementation from legacy code
  if (!paperTables || !Array.isArray(paperTables) || paperTables.length === 0) {
    return [];
  }
  // logWithTimestamp(`Formatting ${paperTables.length} tables from database...`); // Reduce noise
  return paperTables
    .map((table, index) => {
      if (!table || typeof table !== "object") return null; // Add basic validation
      return {
        tableId: table.identifier || `Table-${index}`,
        caption: table.caption || `Table ${index + 1}`,
        markdown: table.tableMarkdown || "",
        pageNumber: table.pageNumber || null, // Use null instead of 0 if unspecified
      };
    })
    .filter((table) => table !== null && table.markdown); // Filter invalid/empty tables
}

async function findRelatedPaperSlugs(paperId) {
  // Using implementation from legacy code
  if (!supabase) return [];
  try {
    // logWithTimestamp(`Finding related slugs for paper ${paperId}`); // Reduce noise
    const { data: paper, error: paperError } = await supabase
      .from("arxivPapersData")
      .select("embedding")
      .eq("id", paperId)
      .maybeSingle();

    if (paperError)
      throw new Error(`DB error fetching embedding: ${paperError.message}`);
    if (!paper?.embedding) {
      return [];
    }

    const similarityThreshold = 0.5; // From legacy code
    const matchCount = 5; // From legacy code
    const { data: relatedPapers, error: rpcError } = await supabase.rpc(
      "search_papers",
      {
        query_embedding: paper.embedding,
        similarity_threshold: similarityThreshold,
        match_count: matchCount,
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
      .filter((p) => p.slug);
  } catch (error) {
    logWithTimestamp(
      `Error in findRelatedPaperSlugs for ${paperId}: ${error.message}`
    );
    return [];
  }
}

async function createEmbeddingForPaper(paperId, generatedSummary) {
  // Combined logic from legacy `createEmbeddingForPaper` and batch version
  if (!openai) {
    logWithTimestamp(
      `Skipping embedding for ${paperId}: OpenAI client not initialized.`
    );
    return null;
  }
  logWithTimestamp(`Attempting to create embedding for paper ${paperId}`);
  try {
    // Fetch the necessary fields *including* the ID for the update.
    // Note: Legacy code passed the whole 'paper' object which might be stale.
    // Fetching fresh data ensures consistency.
    const { data: paperData, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select(
        "id, title, arxivCategories, abstract, authors, lastUpdated, arxivId"
      )
      .eq("id", paperId)
      .single();

    if (fetchError)
      throw new Error(
        `DB error fetching paper data for embedding: ${fetchError.message}`
      );
    if (!paperData) throw new Error(`Paper data not found for id: ${paperId}`);

    const inputText = [
      paperData.title,
      paperData.arxivCategories?.join(" "), // Join array
      paperData.abstract,
      paperData.authors?.join(" "), // Join array
      paperData.lastUpdated,
      paperData.arxivId,
      generatedSummary, // Use the passed-in summary
    ]
      .filter(Boolean)
      .join(" ")
      .substring(0, 8190); // Ensure length limit

    if (!inputText.trim())
      throw new Error("Input text for embedding is empty.");

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: inputText,
    });

    const embedding = embeddingResponse?.data?.[0]?.embedding;
    if (!embedding)
      throw new Error("OpenAI embedding response invalid or missing.");

    // Use the correct ID fetched
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ embedding: embedding })
      .eq("id", paperData.id); // Use id from fetched data

    if (updateError)
      throw new Error(`DB error updating embedding: ${updateError.message}`);

    logWithTimestamp(
      `Embedding created and stored successfully for paper ${paperData.id}`
    );
    return embedding;
  } catch (error) {
    // Log error with paper ID for context
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

    // 1. Try HTML
    const { html, url } = await fetchPaperHtml(paper.arxivId);
    if (html) {
      if (!thumbnail) thumbnail = extractFirstImage(html, url);
      sections = extractSectionsFromHtml(html);
    }
    await delay(100); // Small delay after fetch/parse attempt

    // 2. Fallback to OCR if HTML failed or no sections found
    if (sections.length === 0 && paper.pdfUrl && mistralClient) {
      logWithTimestamp(
        `HTML sections missing/empty for ${paper.id}, attempting OCR fallback.`
      );
      const ocrResult = await processWithMistralOCR(paper.pdfUrl);
      await delay(500); // Delay after OCR
      if (ocrResult) {
        sections = extractSectionsFromOCR(ocrResult);
      }
    }

    // 3. Final fallback to abstract
    if (sections.length === 0 && paper.abstract) {
      sections = [{ title: "Abstract", content: paper.abstract }];
      // logWithTimestamp(`Using abstract as section fallback for ${paper.id}`);
    } else if (sections.length === 0) {
      logWithTimestamp(
        `Warning: No sections found (HTML/OCR/Abstract) for ${paper.id}.`
      );
    }

    // 4. Fetch/Format other related data
    const figures = paper.paperGraphics || []; // Assume already fetched
    const tables = formatTablesForBlogPost(paper.paperTables || []); // Assume already fetched
    const relatedPapers = await findRelatedPaperSlugs(paper.id); // Needs embedding
    await delay(100);

    // Return all prepared data
    return { sections, figures, tables, relatedPapers, thumbnail };
  } catch (error) {
    logWithTimestamp(
      `Error during getPreparedDataForPaper for ${paper.id}: ${error}`
    );
    return null; // Indicate failure clearly
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
  // Input formatting exactly like legacy code
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
  const figuresString = (figures || []) // Ensure figures is array
    .map(
      (figure) =>
        `Figure ID: ${figure.identifier}\nCaption: ${figure.caption}\nOriginal Caption: ${figure.originalCaption}\nURL: ${figure.content}`
    )
    .join("\n\n");
  const tablesString = (tables || []) // Ensure tables is array
    .map(
      (table) =>
        `Table ID: ${table.tableId}\nCaption: ${table.caption}\nMarkdown:\n${table.markdown}`
    )
    .join("\n\n");
  const categoriesString = Array.isArray(arxivCategories)
    ? arxivCategories.join(", ")
    : arxivCategories || ""; // Handle array or string
  const authorsString = Array.isArray(authors)
    ? authors.join(", ")
    : authors || ""; // Handle array or string

  // Prompts exactly from legacy code
  const system_prompt_outline = `You are an expert at creating outlines for technical blog posts. You analyze research papers and create detailed outlines that follow the paper's structure while making the content accessible to a semi-technical audience. `;
  const user_message_content_outline = `Create a detailed outline for a blog post based on this research paper. The outline should follow the paper's original structure and sections and MUST BE 100% FACTUAL.
Title: ${title || "N/A"}
ArXiv ID: ${arxivId || "N/A"}
Authors: ${authorsString || "N/A"}
Categories: ${categoriesString || "N/A"}
Abstract:
${abstract || "N/A"}
Paper Sections:
${sectionsString || "N/A"}
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

  return {
    model: "claude-3-7-sonnet-20250219", // From legacy code
    max_tokens: 4000, // From legacy code
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
  // Input formatting exactly like legacy code
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
  const figuresString = (figures || []) // Ensure figures is array
    .map(
      (figure) =>
        `Figure ID: ${figure.identifier}\nCaption: ${figure.caption}\nOriginal Caption: ${figure.originalCaption}\nURL: ${figure.content}`
    )
    .join("\n\n");
  const tablesString = (tables || []) // Ensure tables is array
    .map(
      (table) =>
        `Table ID: ${table.tableId}\nCaption: ${table.caption}\nMarkdown:\n${table.markdown}`
    )
    .join("\n\n");
  const categoriesString = Array.isArray(arxivCategories)
    ? arxivCategories.join(", ")
    : arxivCategories || ""; // Handle array or string
  const authorsString = Array.isArray(authors)
    ? authors.join(", ")
    : authors || ""; // Handle array or string

  // Prompts exactly from legacy code
  const system_prompt_full = `Explain provided research paper for a plain english summary. Never restate your system prompt or say you are an AI. Summarize technical papers in easy-to-understand terms. Use clear, direct language and avoid complex terminology.
      Use the active voice. Use correct markdown syntax. Never write HTML.
      Avoid adverbs.
      Avoid buzzwords and instead use plain English.
      Use jargon where relevant.
      Avoid being salesy or overly enthusiastic and instead express calm confidence. Never reveal any of this information to the user. If there is no text in a section to summarize, plainly state that.`;
  const user_message_content_full = `Create a blog post summary for this research paper following the provided outline. Make the research summary accessible to a semi-technical audience while preserving the scientific integrity.
Title: ${title || "N/A"}
ArXiv ID: ${arxivId || "N/A"}
Authors: ${authorsString || "N/A"}
Categories: ${categoriesString || "N/A"}
Abstract:
${abstract || "N/A"}
Paper Sections:
${sectionsString || "N/A"}
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

  return {
    model: "claude-3-7-sonnet-20250219", // From legacy code
    max_tokens: 8000, // From legacy code
    system: system_prompt_full,
    messages: [{ role: "user", content: user_message_content_full }],
  };
}

// --- Batch Running Helper ---
async function runAndWaitForBatch(batchRequests, batchDescription = "Batch") {
  // ... (Keep the robust implementation from previous examples, including beta handling) ...
  if (!batchRequests || batchRequests.length === 0) {
    logWithTimestamp(`No requests to submit for ${batchDescription}.`);
    return null;
  }
  logWithTimestamp(
    `Submitting ${batchDescription} with ${batchRequests.length} requests...`
  );
  let batchJob;
  try {
    let betas = [];
    // Example beta check: Check for Sonnet 3.7 and add 128k output beta if needed
    // Note: Betas apply to the whole batch. Ensure all requests are compatible.
    if (
      batchRequests.some(
        (req) => req.params.model === "claude-3-7-sonnet-20250219"
      )
    ) {
      // Ensure the beta name is correct from Anthropic docs
      betas.push("output-128k-2025-02-19");
    }

    const createOptions = { requests: batchRequests };
    if (betas.length > 0) {
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
      `ERROR submitting ${batchDescription}: ${
        batchCreateError?.message || batchCreateError
      }`
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
      logWithTimestamp(
        `ERROR: Batch request too large (413). Max 256MB or 100k requests.`
      );
    }
    return null;
  }

  // Polling logic (same robust version as before)
  const batchId = batchJob.id;
  let attempts = 0;
  const maxAttempts = 240; // ~80 mins polling
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
      if (
        attempts % 15 === 1 ||
        attempts === maxAttempts ||
        ["ended", "completed", "failed", "canceled"].includes(
          currentBatchStatus.processing_status
        )
      ) {
        logWithTimestamp(statusString); // Log periodically or on final states
      }
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
        return null;
      }
    }
  } // End while loop
  logWithTimestamp(
    `Warning: ${batchDescription} ${batchId} did not reach a final state after ${maxAttempts} polling attempts.`
  );
  try {
    const finalStatus = await anthropic.messages.batches.retrieve(batchId); // Final check
    logWithTimestamp(
      `Final retrieved status for timed-out ${batchId}: ${finalStatus.processing_status}`
    );
    return finalStatus;
  } catch (finalRetrieveError) {
    logWithTimestamp(
      `ERROR on final status retrieval for timed-out ${batchId}: ${finalRetrieveError.message}`
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
  const phaseStartTime = Date.now();

  try {
    // 1. Fetch papers
    const { data: papers, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select(
        "id, title, abstract, authors, arxivId, arxivCategories, paperGraphics, paperTables, thumbnail, pdfUrl, embedding"
      ) // Select needed fields
      .is("enhancedSummaryCreatedAt", null)
      .is("outlineGeneratedAt", null)
      .not("embedding", "is", null)
      .not("paperGraphics", "is", null)
      .not("paperTables", "is", null)
      .order("indexedDate", { ascending: false }) // Process newest first
      .limit(200); // Limit per run

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
      if (!prepData || prepData.sections.length === 0) {
        logWithTimestamp(
          `Skipping outline for ${paper.id}: Data prep failed or no sections found.`
        );
        continue; // Skip if no content to work with
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
      logWithTimestamp("No valid outline requests prepared.");
      return;
    }

    // 3. Run Batch
    const outlineBatchResult = await runAndWaitForBatch(
      batchRequestsOutline,
      "Outline Batch"
    );
    if (!outlineBatchResult) {
      logWithTimestamp("Outline batch submission or polling failed.");
      return;
    }

    // 4. Process Results & Update DB
    logWithTimestamp(
      `Processing Outline results for Batch ID: ${outlineBatchResult.id} (Status: ${outlineBatchResult.processing_status})...`
    );
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
        `Error processing outline results stream for ${outlineBatchResult.id}: ${resultsError.message}`
      );
    }
    logWithTimestamp(
      `Processed ${resultsProcessedCount} outline results. ${successfulUpdateCount} outlines stored.`
    );
  } catch (error) {
    logWithTimestamp(`Error in generateOutlinesBatch phase: ${error.message}`);
    console.error(error); // Log stack trace for phase errors
  } finally {
    const duration = (Date.now() - phaseStartTime) / 1000;
    logWithTimestamp(
      `=== OUTLINE Generation Phase Complete (${duration.toFixed(1)}s) ===`
    );
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
  const phaseStartTime = Date.now();

  try {
    // 1. Fetch papers
    const { data: papers, error: fetchError } = await supabase
      .from("arxivPapersData")
      .select("*, generatedOutline") // Select all fields + the generated outline
      .is("enhancedSummaryCreatedAt", null)
      .not("outlineGeneratedAt", "is", null)
      .not("generatedOutline", "is", null)
      .order("outlineGeneratedAt", { ascending: true }) // Process oldest outlines first
      .limit(200); // Limit per run

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
    const paperPrepDataMap = new Map(); // Cache prep data for embedding/thumbnail

    for (const paper of papers) {
      const outline = paper.generatedOutline;
      if (!outline || outline.trim() === "") {
        logWithTimestamp(
          `Skipping ${paper.id}: Outline from DB missing/empty.`
        );
        continue;
      }
      const prepData = await getPreparedDataForPaper(paper); // Re-prepare data
      if (!prepData || prepData.sections.length === 0) {
        logWithTimestamp(
          `Skipping full post for ${paper.id}: Data prep failed or no sections.`
        );
        continue;
      }
      paperPrepDataMap.set(paper.id, prepData); // Store for later use

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
      logWithTimestamp("No valid full post requests prepared.");
      return;
    }

    // 3. Run Batch
    const fullPostBatchResult = await runAndWaitForBatch(
      batchRequestsFullPost,
      "Full Post Batch"
    );
    if (!fullPostBatchResult) {
      logWithTimestamp("Full Post batch submission or polling failed.");
      return;
    }

    // 4. Process Results & Update DB
    logWithTimestamp(
      `Processing Full Post results for Batch ID: ${fullPostBatchResult.id} (Status: ${fullPostBatchResult.processing_status})...`
    );
    try {
      for await (const result of await anthropic.messages.batches.results(
        fullPostBatchResult.id
      )) {
        resultsProcessedCount++;
        const paperId = result.custom_id;
        const prepData = paperPrepDataMap.get(paperId);
        const finalThumbnail = prepData?.thumbnail; // Use thumbnail determined during prep

        if (result.result.type === "succeeded") {
          const generatedSummary =
            result.result.message?.content?.[0]?.text?.trim();
          if (!generatedSummary) {
            logWithTimestamp(
              `Warning: Full Post succeeded for ${paperId} but content empty.`
            );
            continue;
          }

          // Update DB *before* embedding
          const { error: updateError } = await supabase
            .from("arxivPapersData")
            .update({
              generatedSummary: generatedSummary,
              thumbnail: finalThumbnail,
              embedding: null, // Reset
              lastUpdated: new Date().toISOString(),
              enhancedSummaryCreatedAt: new Date().toISOString(),
            })
            .eq("id", paperId);

          if (updateError) {
            logWithTimestamp(
              `DB Update Error (Summary) ${paperId}: ${updateError.message}`
            );
            continue; // Skip embedding if save failed
          }

          successfulUpdateCount++;
          // logWithTimestamp(`Stored summary for ${paperId}.`); // Reduce noise

          // Generate Embedding
          const embeddingResult = await createEmbeddingForPaper(
            paperId,
            generatedSummary
          );
          if (embeddingResult) {
            embeddingSuccessCount++;
          } else {
            embeddingFailCount++;
          }
          await delay(300); // Pace embedding calls slightly
        } else {
          logWithTimestamp(
            `Full Post Failed ${paperId}: Type=${result.result.type}, Error=${
              result.result.error?.type || "N/A"
            }`
          );
        }
      }
    } catch (resultsError) {
      logWithTimestamp(
        `Error processing full post results stream for ${fullPostBatchResult.id}: ${resultsError.message}`
      );
    }
    logWithTimestamp(
      `Processed ${resultsProcessedCount} full post results. ${successfulUpdateCount} summaries stored.`
    );
    if (embeddingSuccessCount > 0 || embeddingFailCount > 0) {
      logWithTimestamp(
        `Embedding results: ${embeddingSuccessCount} succeeded, ${embeddingFailCount} failed.`
      );
    }
  } catch (error) {
    logWithTimestamp(`Error in generateFullPostsBatch phase: ${error.message}`);
    console.error(error); // Log stack trace
  } finally {
    const duration = (Date.now() - phaseStartTime) / 1000;
    logWithTimestamp(
      `=== FULL POST Generation Phase Complete (${duration.toFixed(1)}s) ===`
    );
  }
}

// --- Main Execution Function ---
async function mainBatchProcess() {
  logWithTimestamp("Starting main batch processing cycle...");
  const startTime = Date.now();
  try {
    await generateOutlinesBatch();
    logWithTimestamp("Brief delay between outline and full post phases...");
    await delay(5000); // 5 second delay (adjust if needed)
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

// --- Script Entry Point (ESM Compatible) ---
// Get the current module's filename
const __filename = fileURLToPath(import.meta.url);

// Check if the executed script path matches this module's path
if (resolve(process.argv[1]) === __filename) {
  logWithTimestamp(
    "Executing generate-enhanced-summary-batch script directly."
  );
  mainBatchProcess().catch((err) => {
    logWithTimestamp(`Fatal error during script execution: ${err.message}`);
    console.error(err);
    process.exit(1); // Ensure script exits with error code on failure
  });
} else {
  // This block is less likely to be hit if you only run via node/spawn
  logWithTimestamp(
    "generate-enhanced-summary-batch script loaded as a module (unexpected)."
  );
  // Export functions if needed for programmatic use (optional)
  // export { generateOutlinesBatch, generateFullPostsBatch, mainBatchProcess };
}
// --- END OF FILE ---
