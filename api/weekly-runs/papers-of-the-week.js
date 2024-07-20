import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

async function getPapersOfTheWeek() {
  const today = new Date();
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .gte("indexedDate", oneWeekAgo.toISOString())
    .lte("indexedDate", today.toISOString())
    .order("totalScore", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  let markdownContent = "";

  for (const paper of papers) {
    markdownContent += `**${paper.title}**\n\n`;
    markdownContent += `[https://aimodels.fyi/papers/arxiv/${paper.slug}](https://aimodels.fyi/papers/arxiv/${paper.slug})\n\n`;

    let summaryContent = "";
    let contentForSummary = paper.abstract; // Always include the abstract

    if (paper.generatedSummary) {
      const overviewSection = extractSection(
        paper.generatedSummary,
        "Overview",
        "Plain English Explanation"
      );

      if (overviewSection) {
        contentForSummary += "\n\n" + overviewSection; // Append the overview if available
      }
    }

    summaryContent = await generateSummary(paper.title, contentForSummary);

    markdownContent += `${summaryContent}\n\n`;
  }

  console.log(markdownContent);

  // Store the markdown content in the database
  const { data, error: insertError } = await supabase
    .from("weekly_summaries")
    .insert({ weekly_summary: markdownContent });

  if (insertError) {
    console.error("Error inserting weekly summary:", insertError);
  } else {
    console.log("Weekly summary stored successfully in the database.");
  }
}

async function generateSummary(title, content) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Summarize the following research paper in an extremely concise, tight, short summary of 1-2 sentences. Focus on the key contributions and implications:

          Title: ${title}

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

function extractSection(text, startMarker, endMarker) {
  const startIndex = text.indexOf(`## ${startMarker}`);
  const endIndex = text.indexOf(`## ${endMarker}`);

  if (startIndex === -1 || endIndex === -1) {
    return null;
  }

  return text.substring(startIndex + startMarker.length + 3, endIndex).trim();
}

getPapersOfTheWeek().catch(console.error);
