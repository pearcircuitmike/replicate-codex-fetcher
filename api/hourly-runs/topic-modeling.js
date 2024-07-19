import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import lda from "lda";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

async function fetchRecentPapers() {
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("id, title, abstract, generatedSummary")
    .gte("publishedDate", fourteenDaysAgo)
    .gt("totalScore", 0);

  if (error) {
    console.error("Error fetching papers:", error);
    return [];
  }
  return papers;
}

function performLDA(papers, numTopics = 20, numTerms = 10) {
  const documents = papers.map(
    (paper) => `${paper.title} ${paper.abstract} ${paper.generatedSummary}`
  );

  return lda(documents, numTopics, numTerms);
}

async function getTopicNamesFromClaude(topics) {
  const prompt = `As an expert in scientific research and topic modeling, your task is to provide precise and informative names for each of the following topics based on their associated keywords. Each topic name should be no more than 5 words long and should capture the specific focus or theme of the research area represented by the keywords. Avoid generic names and ensure the names are meaningful and specific to the field of study. Here are the topics:

${topics
  .map(
    (topic, index) =>
      `Topic ${index + 1}: ${topic
        .map((term) => `${term.term} (${(term.probability * 100).toFixed(2)}%)`)
        .join(", ")}`
  )
  .join("\n")}

Please respond with a numbered list of topic names, like this:
1. [Specific Topic 1 Name]
2. [Specific Topic 2 Name]
...and so on.

Ensure each topic has a specific name, even if some keywords seem general. Use your expertise to interpret the overall theme based on the combination of keywords.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      const topicNames = message.content[0].text
        .split("\n")
        .filter((line) => line.match(/^\d+\./))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());

      return topicNames;
    } else {
      console.log("No topic names generated");
      return topics.map((_, index) => `Topic ${index + 1}`);
    }
  } catch (error) {
    console.error("Error calling Claude API:", error);
    return topics.map((_, index) => `Topic ${index + 1}`);
  }
}

function assignPapersToTopics(papers, ldaResult) {
  return ldaResult.map((topic) => {
    const relevantPapers = papers
      .map((paper) => {
        const documentText =
          `${paper.title} ${paper.abstract} ${paper.generatedSummary}`.toLowerCase();
        const topicStrength = topic.reduce(
          (sum, term) =>
            sum + (documentText.split(term.term).length - 1) * term.probability,
          0
        );
        return { ...paper, topicStrength };
      })
      .filter((paper) => paper.topicStrength > 0)
      .sort((a, b) => b.topicStrength - a.topicStrength);

    return { topic, papers: relevantPapers };
  });
}

async function insertTopicModelingResults(topicsWithPapers, topicNames) {
  const results = topicsWithPapers.map((topic, index) => ({
    topic_name: topicNames[index],
    keywords: topic.topic.map((t) => t.term),
    keyword_probabilities: topic.topic.map((t) => t.probability),
    paper_ids: topic.papers.map((paper) => paper.id),
  }));

  const { error } = await supabase
    .from("topic_modeling_results")
    .insert(results);

  if (error) {
    console.error("Error inserting topic modeling results:", error);
  } else {
    console.log("Successfully inserted topic modeling results");
  }
}

async function runTopicModeling() {
  console.log("Starting topic modeling...");

  const papers = await fetchRecentPapers();
  if (papers.length === 0) {
    console.log("No papers found in the last 7 days with totalScore > 0.1");
    return;
  }

  console.log(`Processing ${papers.length} papers...`);

  const ldaResult = performLDA(papers);
  const topicNames = await getTopicNamesFromClaude(ldaResult);
  const topicsWithPapers = assignPapersToTopics(papers, ldaResult);

  // Insert results into the database
  await insertTopicModelingResults(topicsWithPapers, topicNames);

  console.log("\nTopic Modeling Results:");
  topicsWithPapers.forEach((topic, index) => {
    console.log(`Topic: ${topicNames[index]}`);
    console.log("Keywords:");
    topic.topic.forEach((term) => {
      console.log(`  ${term.term} (${(term.probability * 100).toFixed(2)}%)`);
    });
    console.log("Papers:");
    topic.papers.slice(0, 5).forEach((paper) => {
      console.log(`  - ${paper.title} (ID: ${paper.id})`);
    });
    if (topic.papers.length > 5) {
      console.log(`    ... and ${topic.papers.length - 5} more papers.`);
    }
    console.log();
  });

  console.log("Topic modeling completed and results stored in the database.");
}

// Main execution
runTopicModeling().catch(console.error);
