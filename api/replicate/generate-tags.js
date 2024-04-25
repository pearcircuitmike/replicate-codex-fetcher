import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const claudeApiKey = process.env.CLAUDE_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const types = ["Text", "Image", "Audio", "Video"];
const classificationCategories = types.flatMap((fromType) =>
  types.map((toType) => `${fromType}-to-${toType}`)
);

export async function generateTags() {
  const { data: models, error: fetchError } = await supabase
    .from("replicateModelsData_NEW")
    .select("*")
    .or("tags.eq.,tags.is.null");

  console.log(models);

  if (fetchError) {
    console.error(fetchError);
    return;
  }

  for (const model of models) {
    const modelUrl = `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}`;
    const modelResponse = await fetch(modelUrl, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
      },
    });
    const modelData = await modelResponse.json();
    const versionId = modelData.latest_version?.id;

    const versionUrl = `https://api.replicate.com/v1/models/${model.creator}/${model.modelName}/versions/${versionId}`;
    const response = await fetch(versionUrl, {
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
      },
    });
    const responseData = await response.json();

    const openAPIInputSchema = responseData.openapi_schema?.components?.schemas
      ?.Input.properties
      ? JSON.stringify(
          responseData.openapi_schema.components.schemas.Input.properties
        )
      : "";
    const openAPIOutputSchema = responseData.openapi_schema?.components?.schemas
      ?.Output
      ? JSON.stringify(responseData.openapi_schema.components.schemas.Output)
      : "";

    console.log(openAPIInputSchema);

    const description = model.description ?? "No description provided.";
    const prompt = `
    <task>
    Classify the following model into one of the specified categories based on the inputs and outputs. 
    You must respond exactly with the category and no other words. 
    For example, you can respond "Image-to-Image", "Text-to-Image", etc - you SHOULD NOT REPLY WITH ANYTHING ELSE.
    </task>
    
    <rules>
    - Response must be of the form: Input-to-Output
    - You must first read the description. If the answer is in the description, provide it. Otherwise use the schema to determine it.
    </rules>
    
    <categories>
    ${classificationCategories.join(", ")}
    </categories>
    
    <note>You may not choose any other categories besides those listed.</note>
    
    <model>${model.modelName}</model>
    
    <description>${description}</description>
    
    <inputSchema>${openAPIInputSchema}</inputSchema>
    
    <outputSchema>${openAPIOutputSchema}</outputSchema>
    
    <category>`;

    console.log(`Prompt: ${prompt}`); // Log the prompt for debugging purposes

    try {
      const response = await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 20,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const category = response.content[0].text.replace(/[^\w\s-]/g, "").trim();
      console.log(`Claude Response: ${category}`);

      if (classificationCategories.includes(category)) {
        const { error: updateError } = await supabase
          .from("replicateModelsData_NEW")
          .update({ tags: category })
          .match({ id: model.id });

        if (updateError) {
          console.error(`Failed to update model ID ${model.id}:`, updateError);
        } else {
          console.log(
            `Updated model ID ${model.id} with category: ${category}`
          );
        }
      } else {
        console.log(`Invalid category: ${category}`);
      }
    } catch (err) {
      console.error(err);
    }
  }
}

generateTags();
