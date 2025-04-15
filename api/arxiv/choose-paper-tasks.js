import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Gemini
const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Constants
const RATE_LIMIT_DELAY = 200; // 200ms between API calls
const BATCH_SIZE = 1000; // Process 1000 papers at a time

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function categorizePaper(paper, tasksList) {
  const { title, abstract } = paper;

  try {
    const prompt = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are an expert AI/ML research assistant that categorizes research papers into predefined tasks.

**Paper Details:**
Title: ${title}
Abstract: ${abstract}

**Available Tasks:**
${tasksList.join("\n")}

**Instructions:**
Based on the title, summary and abstract, list up to the three MOST relevant tasks from the above list that apply to this paper. Provide only the task names, each on a new line.

**Response Format:**
- Task Name 1
- Task Name 2
- ...`,
            },
          ],
        },
      ],
    };

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const taskNamesText = response.text().trim();

    // Apply rate limiting
    await delay(RATE_LIMIT_DELAY);

    const taskNames = taskNamesText
      .split("\n")
      .map((line) => line.replace(/^-?\s*/, "").trim())
      .filter((name) => name.length > 0);

    return taskNames;
  } catch (error) {
    console.error("Error categorizing paper:", error);
    return [];
  }
}

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

function mapTaskNamesToIds(taskNames, allTasks) {
  const taskIdMap = new Map();
  allTasks.forEach((task) => {
    taskIdMap.set(task.task.toLowerCase(), task.id);
  });

  // Create a map for logging task name to ID
  const mappedTasks = [];
  const taskIds = [];

  taskNames.forEach((name) => {
    const id = taskIdMap.get(name.toLowerCase());
    if (id !== undefined) {
      taskIds.push(id);
      mappedTasks.push({ name, id });
    }
  });

  return { taskIds, mappedTasks };
}

async function processPaperBatch(papers, tasksList, allTasks) {
  for (const paper of papers) {
    try {
      console.log(`\n----- Processing Paper -----`);
      console.log(`ID: ${paper.id}`);
      console.log(`Title: ${paper.title}`);
      console.log(
        `Abstract (first 100 chars): ${paper.abstract?.substring(0, 100)}...`
      );

      const taskNames = await categorizePaper(paper, tasksList);
      if (taskNames.length === 0) {
        console.log(`No relevant tasks found for paper ${paper.id}.`);
        continue;
      }

      console.log(`Chosen Tasks: ${taskNames.join(", ")}`);

      const { taskIds, mappedTasks } = mapTaskNamesToIds(taskNames, allTasks);
      if (taskIds.length === 0) {
        console.log(`No valid task IDs found for paper ${paper.id}.`);
        continue;
      }

      console.log(`Mapped Tasks:`);
      mappedTasks.forEach((task) => {
        console.log(`  - ${task.name} (ID: ${task.id})`);
      });

      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ task_ids: taskIds })
        .eq("id", paper.id);

      if (updateError) {
        console.error(
          `Error updating tasks for paper ${paper.id}:`,
          updateError.message
        );
      } else {
        console.log(`Successfully updated tasks for paper ${paper.id}.`);
      }

      // Apply rate limiting between papers
      await delay(RATE_LIMIT_DELAY);
    } catch (error) {
      console.error(`Error processing paper ${paper.id}:`, error);
    }
  }
}

async function assignTasksToPapers() {
  const allTasks = await fetchTasks();
  if (allTasks.length === 0) {
    console.error("No tasks available to assign.");
    return;
  }

  console.log(`Loaded ${allTasks.length} tasks from database`);
  const tasksList = allTasks.map((task) => task.task);

  let processedCount = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      .select("id, title, abstract, generatedSummary, task_ids")
      .is("task_ids", null)
      .not("generatedSummary", "is", null)
      .range(processedCount, processedCount + BATCH_SIZE - 1);

    if (error) {
      console.error("Error fetching papers:", error.message);
      return;
    }

    if (!papers || papers.length === 0) {
      console.log("No more papers to process");
      hasMore = false;
      break;
    }

    console.log(
      `Processing batch of ${papers.length} papers starting at index ${processedCount}`
    );
    await processPaperBatch(papers, tasksList, allTasks);

    processedCount += papers.length;

    // If we got fewer papers than the batch size, we've reached the end
    if (papers.length < BATCH_SIZE) {
      hasMore = false;
    }

    // Apply rate limiting between batches
    await delay(RATE_LIMIT_DELAY);
  }

  console.log(
    `Task assignment process completed. Processed ${processedCount} papers total.`
  );
}

// Execute the task assignment
assignTasksToPapers().catch((error) => {
  console.error("Unexpected error:", error);
});
