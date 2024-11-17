import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import { JSDOM } from "jsdom";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-002" });

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const openai = new OpenAI({ apiKey: openaiApiKey });

async function fetchPaperHtml(arxivId) {
  const htmlUrl = `https://arxiv.org/html/${arxivId}v1`;

  try {
    const response = await axios.get(htmlUrl);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`HTML version not found for paper ${arxivId}`);
    } else {
      console.error(`Error fetching HTML for paper ${arxivId}:`, error);
    }
    return null;
  }
}

async function summarizeText(text, relatedSlugs, platform) {
  const maxTokens = 3900;
  const promptPercentage = 0.7;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);

  try {
    let truncatedText = text;
    if (text.length > maxPromptLength) {
      truncatedText = text.substring(0, maxPromptLength);
    }

    const linksString = relatedSlugs
      .map((slug) => `https://aimodels.fyi/papers/${platform}/${slug}`)
      .join(", ");
    console.log("Links string:", linksString);

    const prompt = `${truncatedText}\n\n

    You are a highly skilled AI research assistant tasked with summarizing academic papers for researchers. Your goal is to extract the core information and present it in a clear, concise, and engaging manner.

    <requirements>
    A blog post in proper markdown explaining the provided paper in plain english with
    sections. Ensure your response embeds these internal links in the flow of the text for SEO purposes only where the text is relevant to the keyword and use correct markdown or you will have totally failed:

    Overview • Short sentences in bullet point form in markdown

    Plain English Explanation
    • First, Condense the paper's main contribution into a single, eye-catching sentence with less than 200 characters. This should be easily understandable and pique the reader's interest.
    • Then, Provide a comprehensive summary of the paper in paragraphs. Should be highly readable and accessible to researchers from various backgrounds, even if they are not experts in the specific field. Focus on clarity and avoid technical jargon as much as possible. Explain key concepts, methods, and findings in a way that is easy to grasp. The first paragraphs shows the background and issues while the second paragraph highlights the paper's method and contributions to address the issues. Each paragraph should be written in 500 characters. 
    • add internal links in proper markdown syntax for SEO purposes only where the text is relevant to the keyword
    • Focus on the core ideas and their significance 
    • Use analogies, examples, or metaphors to make complex concepts more accessible to a general audience

    Key Findings
    • add internal links in proper markdown syntax for SEO purposes only where the text is relevant to the keyword
    • State the key findings of the paper, using only results explicitly provided in the paper
     
    Technical Explanation
    • The summary should be written with a thoughtful and in-depth approach to uncover valuable insights.
    • Cover the key elements of the paper, including experiment design, architecture, and insights.
    • The summary should be written in a multiple paragraph form, and it should be detailed yet clear.
    • Implications for the Field: How do these findings advance the current state of knowledge or technology?

    Critical Analysis
    • Discuss any caveats, limitations, or areas for further research mentioned in the paper 
    • Raise any additional concerns or potential issues with the research that were not addressed in the paper 
    • Challenge or question aspects of the research where appropriate, maintaining a respectful and objective tone 
    • add internal links in proper markdown syntax for SEO purposes only where the text is relevant to the keyword
    • Encourage readers to think critically about the research and form their own opinions

    Conclusion
    • add internal links in proper markdown syntax for SEO purposes only where the text is relevant to the keyword
    • Summarize the main takeaways and their potential implications for the field and society at large

    Each section will have several paragraphs of several detailed sentences each in markdown.

    </requirements>

    <relatedlinks>
    You must work in these related links as in-line markdown links naturally throughout the text for SEO purposes.
    ${linksString}
    </relatedlinks>

    Never say I or talk in first person. Never apologize or assess your work.
    Never write a title. 
    All sections headings must be h2.
    
    Sparingly bold key concepts. Be concise and readable, yet detailed. Don't make your paragraphs too long. Be efficient and clear with your words.
    You may only use markdown of types bold, links, and the headings. 
    No other kinds of markdown - no figcaption, etc. Don't try to provide any formulae or math. Never write HTML, only markdown.
    Never say something like "here is the explanation," just provide it no matter what. Your response is written in correct markdown syntax without HTML elements.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    if (response && response.length > 0) {
      console.log("Summary received:", response);
      return response.trim();
    } else {
      console.log("No summary content received");
      return "";
    }
  } catch (error) {
    console.error("Error summarizing text:", error);
    return "";
  }
}

function extractFirstImage(htmlContent, htmlUrl) {
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;

  const img = document.querySelector("figure img");
  if (img) {
    const source = `${htmlUrl}/${img.getAttribute("src")}`;
    return source;
  }

  return null;
}

async function generateSummaryMarkdown(
  htmlContent,
  abstract,
  relatedSlugs,
  platform
) {
  let summaryMarkdown = "";

  if (!htmlContent) {
    // If no HTML content is available, summarize the abstract
    const abstractSummary = await summarizeText(
      abstract,
      relatedSlugs,
      platform
    );
    summaryMarkdown = `${abstractSummary}\n\n`;
  } else {
    const summarizedText = await summarizeText(
      htmlContent,
      relatedSlugs,
      platform
    );
    summaryMarkdown = `${summarizedText}\n\n`;
  }

  return summaryMarkdown.trim();
}

async function createEmbeddingForPaper(paper) {
  const {
    id,
    title,
    arxivCategories,
    abstract,
    authors,
    lastUpdated,
    arxivId,
    generatedSummary,
  } = paper;

  const inputText = `${title || ""} ${arxivCategories || ""} ${
    abstract || ""
  } ${authors || ""} ${lastUpdated || ""} ${arxivId || ""} ${
    generatedSummary || ""
  } `;

  try {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: inputText,
    });

    const [{ embedding }] = embeddingResponse.data;

    await supabase
      .from("arxivPapersData")
      .update({ embedding: embedding })
      .eq("id", id);

    console.log(`Embedding created and inserted for paper with id: ${id}`);
  } catch (error) {
    console.error(
      `Failed to create and insert embedding for paper with id: ${id}. Error:`,
      error.message
    );
  }
}

async function processPapers() {
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .is("generatedSummary", null)
    .not("embedding", "is", null);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { arxivId, abstract, embedding } = paper;

    let htmlContent = await fetchPaperHtml(arxivId);

    if (!htmlContent && !abstract) {
      console.log(`Unable to fetch HTML or abstract for paper ${arxivId}`);
      await delay(1000);
      continue;
    }

    const htmlUrl = `https://arxiv.org/html/${arxivId}v1`;
    const thumbnail = htmlContent
      ? extractFirstImage(htmlContent, htmlUrl)
      : null;

    try {
      const relatedSlugs = await findRelatedPaperSlugs(embedding);
      const summaryMarkdown = await generateSummaryMarkdown(
        htmlContent,
        abstract,
        relatedSlugs,
        "arxiv"
      );

      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({
          generatedSummary: summaryMarkdown,
          thumbnail,
          embedding: null,
          lastUpdated: new Date().toISOString(),
        })
        .eq("arxivId", arxivId);

      if (updateError) {
        console.error(
          `Error updating summary for paper ${arxivId}:`,
          updateError
        );
      } else {
        console.log(`Updated summary for paper ${arxivId}`);
        // Generate the embedding for the paper after updating the summary
        await createEmbeddingForPaper(paper);
      }
    } catch (error) {
      console.error(`Error generating summary for paper ${arxivId}:`, error);
    }

    await delay(2000);
  }
}

async function findRelatedPaperSlugs(embedding) {
  const similarityThreshold = 0.5; // Adjust the similarity threshold as needed
  const matchCount = 5; // Number of related papers to retrieve

  const { data: relatedPapers, error } = await supabase.rpc("search_papers", {
    query_embedding: embedding,
    similarity_threshold: similarityThreshold,
    match_count: matchCount,
  });

  if (error) {
    console.error("Error fetching related paper slugs:", error);
    return [];
  }

  return relatedPapers.map((paper) => paper.slug);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

processPapers();
