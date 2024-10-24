// choose-paper-tasks.js

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client
const openaiApiKey = process.env.OPENAI_SECRET_KEY;
const openai = new OpenAI({
  apiKey: openaiApiKey,
  organization: process.env.OPENAI_ORG_ID, // Optional: if you have an organization ID
});

// Utility function to introduce delays (to prevent rate limiting)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch all tasks from the tasks table.
 * @returns {Promise<Array>} Array of task objects with id and task name.
 */
async function fetchTasks() {
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, task");

  if (error) {
    console.error("Error fetching tasks:", error.message);
    return [];
  }

  return tasks;
}

/**
 * Categorize a paper using OpenAI's GPT model based on the generated summary.
 * @param {Object} paper - The paper object containing title and generatedSummary.
 * @param {Array} tasksList - Array of task names.
 * @returns {Promise<Array>} Array of relevant task names.
 */
async function categorizePaper(paper, tasksList) {
  const { title, abstract, generatedSummary } = paper;

  const prompt = `
You are an expert AI/ML research assistant that categorizes research papers into predefined tasks.

**Paper Details:**
Title: ${title}
Abstract: ${abstract}

Summary: ${generatedSummary}

**Available Tasks:**
${tasksList.join("\n")}

**Instructions:**
Based on the title and summary and astract, list all relevant tasks from the above list that apply to this paper. Provide only the task names, each on a new line.

**Response Format:**
- Task Name 1
- Task Name 2
- ...
`;

  // Log the prompt for debugging
  console.log(
    "=== Categorization Prompt ===\n",
    prompt,
    "\n============================\n"
  );

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.3,
    });

    // Log the entire response for debugging
    console.log(
      "=== OpenAI Response ===\n",
      JSON.stringify(response, null, 2),
      "\n=======================\n"
    );

    const taskNamesText = response.choices[0].message.content.trim();
    const taskNames = taskNamesText
      .split("\n")
      .map((line) => line.replace(/^-?\s*/, "").trim())
      .filter((name) => name.length > 0);

    return taskNames;
  } catch (error) {
    console.error("Error categorizing paper:", error.message);
    return [];
  }
}

/**
 * Map task names to their corresponding UUIDs.
 * @param {Array} taskNames - Array of task names.
 * @param {Array} allTasks - Array of all task objects with id and task name.
 * @returns {Array} Array of task UUIDs.
 */
function mapTaskNamesToIds(taskNames, allTasks) {
  const taskIdMap = new Map();
  allTasks.forEach((task) => {
    taskIdMap.set(task.task.toLowerCase(), task.id);
  });

  const taskIds = taskNames
    .map((name) => taskIdMap.get(name.toLowerCase()))
    .filter((id) => id !== undefined);

  return taskIds;
}

/**
 * Assign task_ids to each paper in the arxivPapersData table based on the generatedSummary.
 */
async function assignTasksToPapers() {
  // Fetch all tasks once
  const allTasks = await fetchTasks();
  if (allTasks.length === 0) {
    console.error("No tasks available to assign.");
    return;
  }

  // Extract task names for categorization
  const tasksList = allTasks.map((task) => task.task);

  // Fetch papers that need task assignment
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("id, title, abstract, generatedSummary, task_ids")
    .is("task_ids", null)
    .not("generatedSummary", "is", null) // Ensure summary exists
    .order("indexedDate", { ascending: false }); // Order by indexedDate descending

  if (error) {
    console.error("Error fetching papers:", error.message);
    return;
  }

  console.log(`Found ${papers.length} papers to process.`);

  for (const paper of papers) {
    const { id, title, generatedSummary } = paper;

    // Skip papers without title or generatedSummary
    if (!title || !generatedSummary) {
      console.log(`Skipping paper ${id} due to missing title or summary.`);
      continue;
    }

    // Categorize the paper
    const taskNames = await categorizePaper(paper, tasksList);
    if (taskNames.length === 0) {
      console.log(`No relevant tasks found for paper ${id}.`);
      continue;
    }

    // Map task names to UUIDs
    const taskIds = mapTaskNamesToIds(taskNames, allTasks);
    if (taskIds.length === 0) {
      console.log(`No valid task IDs found for paper ${id}.`);
      continue;
    }

    // Update the paper with the task_ids
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ task_ids: taskIds })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating tasks for paper ${id}:`,
        updateError.message
      );
    } else {
      console.log(`Successfully updated tasks for paper ${id}.`);
    }

    // Delay to prevent rate limiting
    await delay(1000);
  }

  console.log("Task assignment process completed.");
}

// Execute the task assignment
assignTasksToPapers().catch((error) => {
  console.error("Unexpected error:", error);
});
