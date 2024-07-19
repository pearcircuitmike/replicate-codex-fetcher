import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({ apiKey: openaiApiKey });

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

async function findRelatedModels(embedding) {
  const similarityThreshold = 0.5;
  const matchCount = 5;

  const { data: relatedModels, error } = await supabase.rpc(
    "find_related_models",
    {
      query_embedding: embedding,
      similarity_threshold: similarityThreshold,
      match_count: matchCount,
    }
  );

  if (error) {
    console.error("Error fetching related models:", error);
    return [];
  }

  return relatedModels;
}

async function findRelatedResearchLinks(embedding) {
  const similarityThreshold = 0.9;
  const matchCount = 5;

  try {
    console.log("Embedding passed to findRelatedResearchLinks");

    if (!embedding || embedding.length === 0) {
      console.log("No embedding provided or empty embedding.");
      return [];
    }

    const { data: relatedPapers, error } = await supabase.rpc("search_papers", {
      query_embedding: embedding,
      similarity_threshold: similarityThreshold,
      match_count: matchCount,
    });

    if (error) {
      console.error("Error fetching related research links:", error);
      return [];
    }

    console.log("Related papers:", relatedPapers);

    if (relatedPapers.length === 0) {
      console.log("No related papers found for the given embedding.");
      return [];
    }

    return relatedPapers.map(
      (paper) => `https://aimodels.fyi/papers/arxiv/${paper.slug}`
    );
  } catch (error) {
    console.error("Error in findRelatedResearchLinks:", error);
    return [];
  }
}

async function summarizeText(
  model,
  relatedModels,
  relatedResearchLinks,
  platform
) {
  const maxTokens = 4096;
  const promptPercentage = 0.7;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);

  try {
    const { modelName, creator, description, tags } = model;

    const truncatedDescription =
      description && description.length > maxPromptLength
        ? description.substring(0, maxPromptLength)
        : description || "";

    const relatedModelsString = relatedModels
      .map(
        (relatedModel) => `
          <similarModel>
            <name>${relatedModel.modelName}</name>
            <url>https://aimodels.fyi/models/${platform}/${
          relatedModel.slug
        }</url>
            <description>${relatedModel.description || ""}</description>
            <creator>${relatedModel.creator}</creator>
          </similarModel>
        `
      )
      .join("");

    const researchLinksString = relatedResearchLinks
      .map((link) => `[${link.split("/").pop()}](${link})`)
      .join(", ");

    const prompt = `
    <task>
    Generate a concise blog post in Markdown format explaining the provided AI model, including an overview, capabilities, 
    and potential use cases. Use the maintainer's description to inform your explanation. 
    Incorporate the related AI models and research papers as internal links where relevant for SEO purposes.
    </task>
    
    <modelName>${modelName}</modelName>
    
    <maintainer>${creator}</maintainer>
    <maintainerProfile>https://aimodels.fyi/creators/${platform}/${creator}</maintainerProfile>
    
    <description>
    ${truncatedDescription}
    </description>
    
    <tags>
    ${tags}
    </tags>

    <requirements>
    - Use clear, direct language and avoid complex terminology
    - Write in the active voice and use proper Markdown syntax
    - Avoid adverbs and buzzwords, opting for plain English instead
    - Use relevant jargon sparingly
    - Do not speculate or make false claims
    - If a section has no content, simply omit it
    - Do not write a title or include any HTML
    - Do not link to external sites
    - ModelName should always be in backticks in markdown
    - Write in paragraph form with occasional bullets only as needed
    - CRITICAL: Include ONLY THOSE LINKS EXPLICITLY PROVIDED links embedded for SEO purposes when relevant and no others. Do not be repetive with the model name as this is terrible for SEO.
    </requirements>
    
    <similarModels>
    ${relatedModelsString}
    </similarModels>
    
    <relatedPapers>
    ${researchLinksString}
    </relatedPapers>
    
    <output>
    ## Model overview
    Paragraph with specific examples and comparison/contrast of similar models (with provided embedded internal links to ONLY THOSE EXPLICITLY PROVIDED IN <similarModels> and <maintainerProfile>)...

    ## Model inputs and outputs
    Paragraph with a summary and overview of the model inputs and outputs at a high level, including any interesting highlights.

    ### Inputs
    - **Bulleted list of inputs** with descriptions

    ### Outputs
    - **Bulleted list of outputs** with descriptions
    
    ## Capabilities
    Do not restate the model name. Paragraph with specific examples.
    
    ## What can I use it for?
    Paragraph with specific examples and ideas for projects or how to monetize with a company (with provided embedded internal links to ONLY THOSE EXPLICITLY PROVIDED)...
    

    ## Things to try
    Paragraph with specific examples and ideas for what to try with the model, that capture a key nuance or insight about the model. Do not restate the model name.


    </output>

    Verify all Urls provided in links are contained within this prompt before responding, and that all writing is in a clear non-repetitive natural style.
    `;

    console.log("Prompt:", prompt);

    const message = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: maxTokens,
      system: `You are an AI assistant tasked with generating concise blog posts explaining AI models based on provided information. Write without adverbs. Follow the <requirements> specified in the prompt. Never make up links or you will have failed completely, only use those explicitly provided`,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      const summary = message.content[0].text.trim();
      console.log("Summary received:", summary);
      return summary;
    } else {
      console.log("No summary content received");
      return null;
    }
  } catch (error) {
    console.error("Error summarizing text:", error);
    return null;
  }
}

async function createEmbeddingForModel(model) {
  const {
    id,
    creator,
    modelName,
    tags,
    runs,
    lastUpdated,
    platform,
    description,
    example,
    modelUrl,
    githubUrl,
    paperUrl,
    licenseUrl,
    indexedDate,
    slug,
    generatedSummary,
  } = model;

  const inputText = `${creator || ""} ${modelName || ""} ${tags || ""} ${
    runs || ""
  } ${lastUpdated || ""} ${platform || ""} ${description || ""} ${
    example || ""
  } ${modelUrl || ""} ${githubUrl || ""} ${paperUrl || ""} ${
    licenseUrl || ""
  } ${indexedDate || ""} ${slug || ""} ${generatedSummary || ""} `;

  try {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: inputText,
    });

    const [{ embedding }] = embeddingResponse.data;

    await supabase
      .from("modelsData")
      .update({ embedding: embedding })
      .eq("id", id);

    console.log(`Embedding created and inserted for model with id: ${id}`);
  } catch (error) {
    console.error(
      `Failed to create and insert embedding for model with id: ${id}. Error:`,
      error.message
    );
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateSummary() {
  let start = 0;
  const limit = 1000;
  let hasMoreData = true;

  while (hasMoreData) {
    const { data: models, error } = await supabase
      .from("modelsData")
      .select("*")
      .is("generatedSummary", null)
      .eq("platform", "huggingFace")
      .not("embedding", "is", null)
      .range(start, start + limit - 1);

    if (error) {
      console.error("Error fetching models:", error);
      return;
    }

    if (models.length === 0) {
      console.log("No models without generated summary were found");
      hasMoreData = false;
    } else {
      console.log(`Processing models ${start + 1} to ${start + models.length}`);

      for (const model of models) {
        const { slug, embedding } = model;

        try {
          const relatedModels = await findRelatedModels(embedding);
          const relatedResearchLinks = await findRelatedResearchLinks(
            embedding
          );
          const summaryMarkdown = await summarizeText(
            model,
            relatedModels,
            relatedResearchLinks,
            model.platform
          );

          if (summaryMarkdown) {
            const { error: updateError } = await supabase
              .from("modelsData")
              .update({
                generatedSummary: summaryMarkdown,
                embedding: null,
                lastUpdated: new Date().toISOString(),
              })
              .eq("slug", slug);

            if (updateError) {
              console.error(
                `Error updating summary for model ${slug}:`,
                updateError
              );
            } else {
              console.log(`Updated summary for model ${slug}`);
              await createEmbeddingForModel(model);
            }
          } else {
            console.log(`No summary generated for model ${slug}`);
          }
        } catch (error) {
          console.error(`Error generating summary for model ${slug}:`, error);
        }

        await delay(2000);
      }

      start += limit;
      console.log(`Processed models up to ${start}`);
    }
  }

  console.log("Job completed");
}

generateSummary();
