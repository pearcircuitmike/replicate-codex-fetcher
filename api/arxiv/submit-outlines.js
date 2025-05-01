// File: api/arxiv/submit-outlines.js
// Purpose: Finds papers needing outlines, submits an Anthropic batch job for them,
//          and records the batch job ID to the 'batch_jobs' table.
// To be run periodically (e.g., daily) by a scheduler like cron.

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import Anthropic from "@anthropic-ai/sdk";
import { Mistral } from "@mistralai/mistralai";
import OpenAI from "openai";

dotenv.config();

// --- Configuration ---
const BATCH_JOBS_TABLE = "batch_jobs";
const PAPERS_TABLE = "arxivPapersData";
const SUBMIT_BATCH_SIZE_LIMIT = 200;

// --- Initializations ---
const logWithTimestamp = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[SubmitOutlines ${timestamp}] ${message}`);
};

// Initialize Clients (Error handling included for robustness)
let supabase, anthropic, mistralClient, openai;
try {
  logWithTimestamp("Initializing clients...");
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey)
    throw new Error("Supabase URL or Key missing.");
  supabase = createClient(supabaseUrl, supabaseKey);

  const claudeApiKey = process.env.ANTHROPIC_PAPERS_GENERATE_SUMMARY_API_KEY;
  if (!claudeApiKey) throw new Error("Anthropic API Key missing.");
  anthropic = new Anthropic({ apiKey: claudeApiKey });

  const mistralApiKey = process.env.MISTRAL_API_KEY;
  mistralClient = mistralApiKey ? new Mistral({ apiKey: mistralApiKey }) : null;

  const openaiApiKey = process.env.OPENAI_SECRET_KEY;
  openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

  logWithTimestamp(
    `Clients Initialized - Supabase: OK, Anthropic: OK, Mistral: ${
      mistralClient ? "OK" : "N/A"
    }, OpenAI: ${openai ? "OK" : "N/A"}`
  );
} catch (error) {
  logWithTimestamp(`ERROR initializing clients: ${error.message}`);
  process.exit(1);
}

// --- Helper Functions (Copied/Adapted - Potential for Shared Utils Later) ---
// Includes: delay, fetchPaperHtml, extractSectionsFromHtml, extractFirstImage,
//           processWithMistralOCR, extractSectionsFromOCR, formatTablesForBlogPost,
//           findRelatedPaperSlugs, getPreparedDataForPaper, prepareOutlineParams,
//           submitBatchAndRecord
// NOTE: Only helpers needed for *outline submission* are strictly required here.

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fetchPaperHtml(arxivId) {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  try {
    const response = await axios.get(htmlUrl, { timeout: 15000 });
    return { html: response.data, url: htmlUrl };
  } catch (error) {
    if (!(error.response && error.response.status === 404)) {
      logWithTimestamp(
        `Warn: Error fetching HTML for ${arxivId}: ${error.message}`
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
    const sectionHeaders = document.querySelectorAll(
      "h1, h2, h3, .ltx_title_section, .section, .ltx_section"
    );
    if (sectionHeaders.length > 0) {
      for (let i = 0; i < sectionHeaders.length; i++) {
        const header = sectionHeaders[i];
        const title = header.textContent?.trim();
        if (
          !title ||
          title.length > 100 ||
          title.toLowerCase() === "references" ||
          title.toLowerCase() === "bibliography"
        )
          continue;
        let content = "";
        let currentNode = header.nextElementSibling;
        while (
          currentNode &&
          !["H1", "H2", "H3"].includes(currentNode.tagName) &&
          !currentNode.classList.contains("ltx_title_section") &&
          !currentNode.classList.contains("section") &&
          !currentNode.classList.contains("ltx_section") &&
          !(currentNode.textContent || "")
            .trim()
            .toLowerCase()
            .startsWith("references") &&
          !(currentNode.textContent || "")
            .trim()
            .toLowerCase()
            .startsWith("bibliography") &&
          !(currentNode.textContent || "")
            .trim()
            .toLowerCase()
            .startsWith("acknowledgements")
        ) {
          content += (currentNode.textContent || "").trim() + "\n";
          currentNode = currentNode.nextElementSibling;
          if (!currentNode) break;
        }
        content = content
          .replace(/\s{2,}/g, " ")
          .replace(/\n+/g, "\n")
          .trim();
        if (content) sections.push({ title, content });
      }
    }
    if (sections.length === 0) {
      const divs = document.querySelectorAll("div.ltx_section, div.section");
      for (const div of divs) {
        const titleElement = div.querySelector(".ltx_title, h1, h2, h3");
        if (titleElement) {
          const title = titleElement.textContent?.trim();
          if (
            title &&
            title.length < 100 &&
            title.toLowerCase() !== "references" &&
            title.toLowerCase() !== "bibliography"
          ) {
            let content = div.textContent?.replace(title, "").trim() || "";
            content = content
              .replace(/\s{2,}/g, " ")
              .replace(/\n+/g, "\n")
              .trim();
            if (content) sections.push({ title, content });
          }
        }
      }
    }
    if (sections.length === 0) {
      const abstractNode = document.querySelector(
        ".abstract, .ltx_abstract, #abstract"
      );
      if (abstractNode && abstractNode.textContent) {
        const abstractText = abstractNode.textContent
          .replace(/^Abstract\s*/i, "")
          .trim();
        if (abstractText) {
          sections.push({ title: "Abstract", content: abstractText });
        }
      }
    }
    return sections.filter((s) => s.content);
  } catch (parseError) {
    logWithTimestamp(`Error parsing HTML: ${parseError.message}`);
    return [];
  }
}
function extractFirstImage(htmlContent, htmlUrl) {
  if (!htmlContent || !htmlUrl) return null;
  try {
    const dom = new JSDOM(htmlContent);
    const img =
      dom.window.document.querySelector("figure img") ||
      dom.window.document.querySelector(
        "img:not([width='1'], [height='1'], [src*='icon'])"
      );
    if (img) {
      const src = img.getAttribute("src");
      if (src) {
        try {
          const base = htmlUrl.endsWith("/")
            ? htmlUrl
            : new URL(htmlUrl).origin +
              new URL(htmlUrl).pathname.substring(
                0,
                new URL(htmlUrl).pathname.lastIndexOf("/") + 1
              );
          const absoluteUrl = new URL(src, base);
          if (
            absoluteUrl.pathname.endsWith(".gif") ||
            absoluteUrl.pathname.includes("logo")
          ) {
            return null;
          }
          return absoluteUrl.href;
        } catch (urlError) {
          logWithTimestamp(
            `Warn: Invalid image URL construction (src: ${src}, base: ${htmlUrl}): ${urlError.message}`
          );
          if (src.startsWith("http://") || src.startsWith("https://")) {
            return src;
          }
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
  if (!mistralClient) {
    logWithTimestamp("Skipping OCR: Mistral client not initialized.");
    return null;
  }
  logWithTimestamp(`Processing with Mistral OCR: ${documentUrl}`);
  try {
    const ocrResponse = await mistralClient.ocr.process({
      model: "mistral-ocr-latest",
      document: { type: "document_url", documentUrl: documentUrl },
    });
    logWithTimestamp(`OCR OK: ${ocrResponse.pages?.length || 0} pages.`);
    return ocrResponse;
  } catch (error) {
    logWithTimestamp(`ERROR Mistral OCR: ${error.message}`);
    if (error.response?.data) {
      logWithTimestamp(
        `Mistral API Error Data: ${JSON.stringify(error.response.data)}`
      );
    }
    return null;
  }
}
function extractSectionsFromOCR(ocrResult) {
  if (!ocrResult || !ocrResult.pages || ocrResult.pages.length === 0) {
    logWithTimestamp("OCR result is empty or invalid.");
    return [];
  }
  logWithTimestamp("Extracting sections from OCR...");
  try {
    const sections = [];
    let currentSection = { title: "Unknown Section", content: "" };
    let titleFound = false;
    const sectionPatterns = [
      /^(?:[IVXLCDM\d\.]+\s+)?introduction/i,
      /^(?:[IVXLCDM\d\.]+\s+)?background/i,
      /^(?:[IVXLCDM\d\.]+\s+)?related\s+work/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:methodology|methods?|approach)/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:experiments?|experimental\s+setup|evaluation)/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:results?|findings)/i,
      /^(?:[IVXLCDM\d\.]+\s+)?discussion/i,
      /^(?:[IVXLCDM\d\.]+\s+)?analysis/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:conclusion|summary)/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:future\s+work|limitations)/i,
      /^(?:[IVXLCDM\d\.]+\s+)?references?|bibliography/i,
      /^(?:[IVXLCDM\d\.]+\s+)?abstract/i,
      /^(?:[IVXLCDM\d\.]+\s+)?acknowledg(?:e)?ments?/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:appendix|supplementary\s+(?:material|information))/i,
    ];
    const stopPatterns = [
      /^(?:[IVXLCDM\d\.]+\s+)?references?|bibliography/i,
      /^(?:[IVXLCDM\d\.]+\s+)?acknowledg(?:e)?ments?/i,
      /^(?:[IVXLCDM\d\.]+\s+)?(?:appendix|supplementary\s+(?:material|information))/i,
    ];
    for (const page of ocrResult.pages) {
      if (!page.markdown) continue;
      const lines = page.markdown.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        let isSectionHeader = false;
        let isStopSection = false;
        if (trimmedLine.length > 2 && trimmedLine.length < 100) {
          isSectionHeader = sectionPatterns.some((p) => p.test(trimmedLine));
          isStopSection = stopPatterns.some((p) => p.test(trimmedLine));
          if (
            !isSectionHeader &&
            trimmedLine.length > 5 &&
            trimmedLine === trimmedLine.toUpperCase() &&
            !trimmedLine.match(/[a-z]/) &&
            trimmedLine.split(" ").length < 7
          ) {
            isSectionHeader = true;
          }
        }
        if (isStopSection) {
          logWithTimestamp(
            `Detected stop section: "${trimmedLine}". Finishing extraction.`
          );
          if (currentSection.content.trim()) {
            const finalTitle = titleFound
              ? currentSection.title
              : "Preamble / Abstract";
            sections.push({
              title: finalTitle,
              content: currentSection.content.trim(),
            });
          }
          currentSection = { title: "Stopped", content: "" };
          break;
        }
        if (isSectionHeader) {
          if (currentSection.content.trim()) {
            const titleToUse = titleFound
              ? currentSection.title
              : "Preamble / Abstract";
            sections.push({
              title: titleToUse,
              content: currentSection.content.trim(),
            });
          }
          currentSection.title = trimmedLine;
          currentSection.content = "";
          titleFound = true;
        } else {
          currentSection.content += line + "\n";
        }
      }
      if (currentSection.title === "Stopped") break;
    }
    if (currentSection.title !== "Stopped" && currentSection.content.trim()) {
      const finalTitle = titleFound
        ? currentSection.title
        : "Preamble / Abstract";
      sections.push({
        title: finalTitle,
        content: currentSection.content.trim(),
      });
    }
    sections.forEach((section) => {
      section.content = section.content
        .replace(/\s{2,}/g, " ")
        .replace(/\n+/g, "\n")
        .trim();
    });
    logWithTimestamp(`Found ${sections.length} sections via OCR.`);
    return sections.filter((s) => s.content);
  } catch (e) {
    logWithTimestamp(`Error extracting sections from OCR: ${e.message}`);
    return [];
  }
}
function formatTablesForBlogPost(paperTables) {
  if (!paperTables || !Array.isArray(paperTables)) return [];
  try {
    return paperTables
      .map((table, index) => {
        if (!table || typeof table !== "object") return null;
        const markdown = (table.tableMarkdown || "").trim();
        if (!markdown) return null;
        return {
          tableId: table.identifier || `Table-${index + 1}`,
          caption: table.caption || `Table ${index + 1}`,
          markdown: markdown,
          pageNumber: table.pageNumber || null,
        };
      })
      .filter((t) => t !== null);
  } catch (e) {
    logWithTimestamp(`Error formatting tables: ${e.message}`);
    return [];
  }
}
async function findRelatedPaperSlugs(paperId) {
  if (!supabase || !openai) {
    logWithTimestamp(
      `Skipping related slugs for ${paperId}: Supabase or OpenAI client missing.`
    );
    return [];
  }
  logWithTimestamp(`Finding related slugs for paper ${paperId}...`);
  try {
    const { data: paper, error: paperError } = await supabase
      .from(PAPERS_TABLE)
      .select("embedding, id")
      .eq("id", paperId)
      .maybeSingle();
    if (paperError) {
      logWithTimestamp(
        `DB error fetching embedding for ${paperId}: ${paperError.message}`
      );
      return [];
    }
    if (!paper?.embedding) {
      logWithTimestamp(
        `Warn: Embedding not found for paper ${paperId}. Cannot find related.`
      );
      return [];
    }
    const { data: relatedPapers, error: rpcError } = await supabase.rpc(
      "search_papers",
      {
        query_embedding: paper.embedding,
        similarity_threshold: 0.5,
        match_count: 5 + 1,
      }
    );
    if (rpcError) {
      logWithTimestamp(
        `RPC error fetching related slugs for ${paperId}: ${rpcError.message}`
      );
      return [];
    }
    const slugs = (relatedPapers || [])
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        platform: p.platform || "arxiv",
        id: p.id,
      }))
      .filter((p) => p.slug && p.id !== paperId);
    logWithTimestamp(
      `Found ${slugs.length} related slugs for paper ${paperId}`
    );
    return slugs;
  } catch (error) {
    logWithTimestamp(
      `Error in findRelatedPaperSlugs for ${paperId}: ${error.message}`
    );
    return [];
  }
}
async function getPreparedDataForPaper(paper) {
  if (!paper || !paper.arxivId || !paper.id) {
    logWithTimestamp(
      "Error: Invalid paper object passed to getPreparedDataForPaper."
    );
    return null;
  }
  logWithTimestamp(
    `Preparing data for paper ${paper.id} (${paper.arxivId})...`
  );
  try {
    let sections = [];
    let thumbnail = paper.thumbnail;
    const { html, url: htmlUrl } = await fetchPaperHtml(paper.arxivId);
    await delay(50);
    if (html && htmlUrl) {
      if (!thumbnail) {
        thumbnail = extractFirstImage(html, htmlUrl);
      }
      sections = extractSectionsFromHtml(html);
    }
    if (sections.length === 0 && paper.pdfUrl && mistralClient) {
      const ocrResult = await processWithMistralOCR(paper.pdfUrl);
      await delay(200);
      if (ocrResult) {
        sections = extractSectionsFromOCR(ocrResult);
      }
    }
    if (sections.length === 0 && paper.abstract) {
      const abstractText = paper.abstract.replace(/^Abstract\s*/i, "").trim();
      if (abstractText) {
        sections = [{ title: "Abstract", content: abstractText }];
      }
    } else if (sections.length === 0) {
      logWithTimestamp(
        `Warning: No content sections could be found for paper ${paper.id}.`
      );
    }
    const figures = paper.paperGraphics || [];
    const tables = formatTablesForBlogPost(paper.paperTables || []);
    const relatedPapers =
      openai && paper.embedding ? await findRelatedPaperSlugs(paper.id) : [];
    await delay(50);
    logWithTimestamp(
      `Data preparation complete for ${paper.id}. Sections: ${sections.length}.`
    );
    if (sections.length === 0) {
      logWithTimestamp(
        `ERROR: No content sections could be prepared for paper ${paper.id}. Cannot proceed.`
      );
      return null;
    }
    return { sections, figures, tables, relatedPapers, thumbnail };
  } catch (error) {
    logWithTimestamp(
      `Error preparing data for paper ${paper.id}: ${error.message}`
    );
    console.error(error);
    return null;
  }
}

function prepareOutlineParams(
  paperData,
  sections,
  figures,
  tables,
  relatedPapers
) {
  const model = "claude-3-7-sonnet-20250219"; // Correct model
  logWithTimestamp(
    `Preparing outline params for paper ${paperData.id} using model ${model}`
  );
  const { title, abstract, authors, arxivId, arxivCategories } = paperData;
  // Full original prompt logic:
  const sectionsString = sections
    .map(
      (s) =>
        `Section: ${s.title}\n\nContent: ${s.content.substring(0, 5000)}${
          s.content.length > 5000 ? "..." : ""
        }`
    )
    .join("\n\n---\n\n");
  const linksString = (relatedPapers || [])
    .map(
      (p) => `https://aimodels.fyi/papers/${p.platform || "arxiv"}/${p.slug}`
    )
    .join(", ");
  const figuresString = (figures || [])
    .map(
      (f) =>
        `Figure ID: ${f.identifier}\nCaption: ${f.caption}\nOriginal Caption: ${f.originalCaption}\nURL: ${f.content}`
    )
    .join("\n\n");
  const tablesString = (tables || [])
    .map(
      (t) =>
        `Table ID: ${t.tableId}\nCaption: ${t.caption}\nMarkdown:\n${t.markdown}`
    )
    .join("\n\n");
  const categoriesString = Array.isArray(arxivCategories)
    ? arxivCategories.join(", ")
    : arxivCategories || "";
  const authorsString = Array.isArray(authors)
    ? authors.join(", ")
    : authors || "";
  const system_prompt_outline = `You are an expert at creating outlines for technical blog posts. You analyze research papers and create detailed outlines that follow the paper's structure while making the content accessible to a semi-technical audience. `;
  const user_message_content_outline = `Create a detailed outline for a blog post based on this research paper. The outline should follow the paper's original structure and sections and MUST BE 100% FACTUAL.\nTitle: ${
    title || "N/A"
  }\nArXiv ID: ${arxivId || "N/A"}\nAuthors: ${
    authorsString || "N/A"
  }\nCategories: ${categoriesString || "N/A"}\nAbstract:\n${
    abstract || "N/A"
  }\nPaper Sections:\n${
    sectionsString || "N/A"
  }\nAvailable Figures (do not use figures if empty brackets):\n${
    figuresString || "None"
  }\nAvailable Tables (do not use tables empty):\n${
    tablesString || "None"
  }\nI need an outline that:\n1. Follows the SAME STRUCTURE as the original paper (same h2 headings)\n2. Specifies where to include each available figure and table\n3. Indicates where to add internal links to related papers: ${
    linksString || "None"
  }\n4. Incorporates the key ideas and explains why you should care about the research/its context/problem to be solved\nFormat your outline with these exact sections:\n- STRUCTURE: List all the section headings in order\n- KEY IDEAS: 5-7 key takeways or insights summarizing the paper. Use exact quotations from the paper to support them.\n- DETAILED OUTLINE: Draft a narrative blog post summary outline taking readers through the research sections, include:\n  * Brief description of what to summarize, using precise language from the paper that is fully accurate.\n  * Which figures/tables to include and where (only include these if they add value). List the captions as well.\n  * Where to add links to related papers (they must be in the sections, not in a related research block at the end)\nThe outline will be used to generate a blog post for aimodels.fyi to take readers through the paper and researcb. Retitle the summary sections to have concise blog post headings that are more descriptive of what is in the sections than the research paper.`;
  return {
    model: model,
    max_tokens: 4000,
    system: system_prompt_outline,
    messages: [{ role: "user", content: user_message_content_outline }],
  };
}

// Note: prepareFullPostParams is NOT needed in *this* script, only in the submit-summaries script.

// Helper function to submit a batch and record its ID to the DB
async function submitBatchAndRecord(
  batchRequests,
  batchDescription = "Batch",
  batchType = "unknown"
) {
  if (!batchRequests || batchRequests.length === 0) {
    logWithTimestamp(`No requests provided for ${batchDescription}.`);
    return null;
  }
  logWithTimestamp(
    `Submitting ${batchDescription} (${batchType}) with ${batchRequests.length} requests...`
  );
  let batchJob;
  try {
    batchJob = await anthropic.messages.batches.create({
      requests: batchRequests,
    });
    if (!batchJob || !batchJob.id) {
      throw new Error(
        "Anthropic batch submission response did not include a valid job object or ID."
      );
    }
    logWithTimestamp(
      `${batchDescription} submitted. Batch ID: ${
        batchJob.id
      }, Initial Status: ${batchJob.processing_status || "unknown"}`
    );
    const { data: insertedData, error: insertError } = await supabase
      .from(BATCH_JOBS_TABLE)
      .insert({
        batch_id: batchJob.id,
        status: "submitted",
        batch_type: batchType,
        submitted_at: new Date().toISOString(),
        total_requests: batchRequests.length,
        succeeded_count: batchJob.request_counts?.succeeded || 0,
        failed_count:
          (batchJob.request_counts?.errored || 0) +
          (batchJob.request_counts?.expired || 0) +
          (batchJob.request_counts?.canceled || 0),
        metadata: { paper_ids: batchRequests.map((r) => r.custom_id) },
      })
      .select()
      .single();
    if (insertError) {
      logWithTimestamp(
        `CRITICAL DB ERROR: Failed to record Batch ID ${batchJob.id} to ${BATCH_JOBS_TABLE}: ${insertError.message}`
      );
      throw new Error(`Failed to record batch job ${batchJob.id} to database.`);
    } else {
      logWithTimestamp(
        `Successfully recorded Batch ID ${batchJob.id} (DB ID: ${insertedData?.id}) to ${BATCH_JOBS_TABLE}.`
      );
    }
    return batchJob.id;
  } catch (error) {
    logWithTimestamp(
      `ERROR during batch submission/recording for ${batchDescription}: ${
        error?.message || error
      }`
    );
    if (error.status === 400 && error.error?.error?.message) {
      logWithTimestamp(
        `Anthropic API Error Message: ${error.error.error.message}`
      );
    } else {
      console.error(error);
    }
    return null;
  }
}

// --- Main Outline Submission Function ---
async function submitOutlinesBatchOnly() {
  logWithTimestamp("=== Starting OUTLINE Batch Submission Phase ===");
  let submittedCount = 0;
  let skippedCount = 0;
  const phaseStartTime = Date.now();
  let submittedBatchId = null;
  try {
    // Fetch papers needing outlines
    const { data: papers, error: fetchError } = await supabase
      .from(PAPERS_TABLE)
      .select(
        "id, title, abstract, authors, arxivId, arxivCategories, paperGraphics, paperTables, thumbnail, pdfUrl, embedding"
      )
      .is("outlineGeneratedAt", null) // Check if outline has been successfully processed
      // TODO: Add check to ensure an 'outline' type job isn't already 'submitted' or 'polling' in batch_jobs for this paper ID
      .order("indexedDate", { ascending: false })
      .limit(SUBMIT_BATCH_SIZE_LIMIT);

    if (fetchError)
      throw new Error(
        `DB Error fetching papers for outline: ${fetchError.message}`
      );
    if (!papers || papers.length === 0) {
      logWithTimestamp("No papers found needing outline batch submission.");
      return;
    }
    logWithTimestamp(
      `Found ${papers.length} papers potentially needing outlines.`
    );

    const batchRequests = [];
    for (const paper of papers) {
      const prepData = await getPreparedDataForPaper(paper);
      await delay(50);
      if (!prepData) {
        logWithTimestamp(
          `Skipping outline prep for ${paper.id}: Failed to prepare data.`
        );
        skippedCount++;
        continue;
      }
      // Prepare params using the function specific to outlines
      const params = prepareOutlineParams(
        paper,
        prepData.sections,
        prepData.figures,
        prepData.tables,
        prepData.relatedPapers
      );
      batchRequests.push({ custom_id: paper.id.toString(), params: params });
    }

    if (batchRequests.length === 0) {
      logWithTimestamp(
        "No valid outline requests prepared after filtering/prep."
      );
      return;
    }

    submittedBatchId = await submitBatchAndRecord(
      batchRequests,
      "Outline Submit Batch",
      "outline"
    );

    if (submittedBatchId) {
      submittedCount = batchRequests.length;
    } else {
      logWithTimestamp(
        "Outline batch submission failed or did not return an ID. No batch recorded in DB."
      );
    }
  } catch (error) {
    logWithTimestamp(`Error in submitOutlinesBatchOnly: ${error.message}`);
    console.error(error);
    throw error;
  } finally {
    // Re-throw to be caught by main handler
    const duration = (Date.now() - phaseStartTime) / 1000;
    logWithTimestamp(
      `=== OUTLINE Batch Submission Phase Complete (${duration.toFixed(
        1
      )}s). Submitted ${submittedCount}, Skipped ${skippedCount}. Batch ID: ${
        submittedBatchId || "N/A"
      } ===`
    );
  }
}

// --- Script Entry Point ---
logWithTimestamp(
  `Executing Outline Submission Script: ${
    process.argv[1] || "submit-outlines.js"
  }`
);

submitOutlinesBatchOnly()
  .then(() => {
    logWithTimestamp("Outline submission process completed successfully.");
    process.exit(0);
  })
  .catch((err) => {
    logWithTimestamp(
      `Fatal error during outline submission script execution: ${err.message}`
    );
    console.error(err.stack);
    process.exit(1);
  });

// --- END OF FILE ---
