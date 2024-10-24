import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

async function getModelsOfTheWeek() {
  const today = new Date();
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: models, error } = await supabase
    .from("modelsData")
    .select("*")
    .gte("indexedDate", oneWeekAgo.toISOString())
    .lte("indexedDate", today.toISOString())
    .order("totalScore", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching models:", error);
    return;
  }

  let markdownContent = "";

  for (const model of models) {
    markdownContent += `**${model.modelName}**\n\n`;
    markdownContent += `[https://aimodels.fyi/models/${model.platform}/${model.slug}](https://aimodels.fyi/models/${model.platform}/${model.slug})\n\n`;

    let summaryContent = "";
    let contentForSummary = model.description;

    if (model.generatedSummary) {
      contentForSummary += "\n\n" + model.generatedSummary;
    }

    summaryContent = await generateSummary(model.modelName, contentForSummary);

    markdownContent += `${summaryContent}\n\n`;
  }

  console.log(markdownContent);

  // Store the markdown content in the database
  const { data, error: insertError } = await supabase
    .from("weekly_summaries_models")
    .insert({ weekly_summary: markdownContent });

  if (insertError) {
    console.error("Error inserting weekly model summary:", insertError);
  } else {
    console.log("Weekly model summary stored successfully in the database.");
  }
}

async function generateSummary(name, content) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Summarize the following AI model in an extremely concise, tight, short summary of 1-2 sentences. Focus on the key capabilities and implications. Do not restate or mention the prompt, just provide the summary:
          Name: ${name}
          Content:
          ${content}`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      return message.content[0].text.trim();
    } else {
      return "Unable to generate summary.";
    }
  } catch (error) {
    console.error("Error generating summary:", error);
    return "Error generating summary.";
  }
}

getModelsOfTheWeek().catch(console.error);
