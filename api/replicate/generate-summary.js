import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { JSDOM } from "jsdom";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const openai = new OpenAI({ apiKey: openaiApiKey });

async function fetchModelSchemas(creator, modelName) {
  const modelUrl = `https://api.replicate.com/v1/models/${creator}/${modelName}`;
  const modelResponse = await fetch(modelUrl, {
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
    },
  });
  const modelData = await modelResponse.json();
  const versionId = modelData.latest_version?.id;

  const versionUrl = `https://api.replicate.com/v1/models/${creator}/${modelName}/versions/${versionId}`;
  const response = await fetch(versionUrl, {
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
    },
  });
  const responseData = await response.json();

  const openAPIInputSchema = responseData.openapi_schema?.components?.schemas
    ?.Input?.properties
    ? JSON.stringify(
        responseData.openapi_schema.components.schemas.Input.properties
      )
    : "";
  const openAPIOutputSchema = responseData.openapi_schema?.components?.schemas
    ?.Output
    ? JSON.stringify(responseData.openapi_schema.components.schemas.Output)
    : "";

  return { openAPIInputSchema, openAPIOutputSchema };
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
    const { modelName, creator, description, paperUrl, githubUrl } = model;
    let abstractText = "";
    let githubDescription = "";

    const { openAPIInputSchema, openAPIOutputSchema } = await fetchModelSchemas(
      creator,
      modelName
    );

    if (paperUrl) {
      try {
        const response = await axios.get(paperUrl);
        const dom = new JSDOM(response.data);
        const abstractElement = dom.window.document.evaluate(
          "/html/body/div[2]/main/div/div/div[1]/div[3]/div/blockquote/text()",
          dom.window.document,
          null,
          dom.window.XPathResult.STRING_TYPE,
          null
        );
        if (abstractElement) {
          abstractText = abstractElement.stringValue.trim();
          console.log("Abstract:", abstractText);
        }
      } catch (error) {
        console.error("Error fetching abstract from paperUrl:", error);
      }
    }

    if (githubUrl) {
      try {
        let readmeUrl = githubUrl
          .replace("https://github.com/", "https://raw.githubusercontent.com/")
          .concat("/main/README.md");
        console.log("Fetching GitHub README from:", readmeUrl);

        try {
          const response = await axios.get(readmeUrl);
          githubDescription = response.data;
          console.log("GitHub README content:", githubDescription);
        } catch (error) {
          if (error.response && error.response.status === 404) {
            console.log("README not found at /main/, trying /master/");
            readmeUrl = githubUrl
              .replace(
                "https://github.com/",
                "https://raw.githubusercontent.com/"
              )
              .concat("/master/README.md");
            console.log("Fetching GitHub README from:", readmeUrl);
            const response = await axios.get(readmeUrl);
            githubDescription = response.data;
            console.log("GitHub README content:", githubDescription);
          } else {
            throw error;
          }
        }
      } catch (error) {
        console.error("Error fetching README from GitHub:", error);
      }
    }

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
    and potential use cases. Use the maintainer's description, the research paper abstract (if available), 
    and the schema and README (if available) to inform your explanation. 
    Incorporate the related AI models and research papers as internal links where relevant for SEO purposes.
    </task>
    
    <modelName>${modelName}</modelName>
    
    <maintainer>${creator}</maintainer>
    <maintainerProfile>https://aimodels.fyi/creators/${platform}/${creator}</maintainerProfile>
    
    <description>
    ${truncatedDescription}
    </description>
    
    <abstract>
    ${abstractText}
    </abstract>
    
    <readme>
    ${githubDescription}
    </readme>
    
    <openAPIInputSchema>
    ${openAPIInputSchema}
    </openAPIInputSchema>
    
    <openAPIOutputSchema>
    ${openAPIOutputSchema}
    </openAPIOutputSchema>

    <requirements>
    - Use clear, direct language and avoid complex terminology
    - Write in the active voice and use proper Markdown syntax. Links must be of the form [linked text](linkurl). Do not include any special characters in the linked text.
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
       DO NOT SAY HERE'S A BLOG POST OR ANYTHING LIKE THAT - NO PREMABLE, JUST THE GENERATED RESULT IN THE PROPER FORMAT.    `;

    console.log("Prompt:", prompt);

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
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
    replicateScore,
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
    replicateScore || ""
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

async function generateSummary() {
  const { data: models, error } = await supabase
    .from("modelsData")
    .select("*")
    .eq("platform", "replicate")
    .is("generatedSummary", null)
    .not("embedding", "is", null);

  if (error) {
    console.error("Error fetching models:", error);
    return;
  }

  for (const model of models) {
    const { slug, embedding } = model;

    try {
      const relatedModels = await findRelatedModels(embedding);
      const relatedResearchLinks = await findRelatedResearchLinks(embedding);
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
}

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { generateSummary };

generateSummary();
