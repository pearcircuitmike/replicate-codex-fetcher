import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

// Initialize clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const resend = new Resend(process.env.RESEND_API_KEY);

function getDateRange() {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7);

  // Format as "MMM D"
  const formatDate = (date) => {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

async function main() {
  console.log("Starting email notification service...");

  // Get date range for subject line
  const dateRange = getDateRange();
  const emailSubject = `AI Research Update (${dateRange})`;
  console.log(`Email subject: ${emailSubject}`);

  try {
    console.log("Fetching task entries from materialized view...");
    const { data: taskEntries, error: taskError } = await supabase.from(
      "user_followed_tasks_with_top_papers"
    ).select(`
        user_id,
        task_name,
        top_paper_1,
        top_paper_2,
        top_paper_3,
        profiles!inner (
          email
        )
      `);

    if (taskError) {
      throw new Error(`Error fetching tasks: ${taskError.message}`);
    }

    const userTaskMap = taskEntries.reduce((acc, entry) => {
      const userId = entry.user_id;
      if (!acc[userId]) {
        acc[userId] = {
          email: entry.profiles.email,
          tasks: [],
        };
      }
      acc[userId].tasks.push(entry);
      return acc;
    }, {});

    console.log(`Found ${Object.keys(userTaskMap).length} users with tasks`);

    for (const [userId, userData] of Object.entries(userTaskMap)) {
      console.log(`\nProcessing user ${userId}...`);

      try {
        if (!userData.email) {
          console.log(`No email found for user ${userId}`);
          continue;
        }

        console.log(`Processing ${userData.tasks.length} tasks for user`);

        const processedTasks = [];
        for (const task of userData.tasks) {
          const paperIds = [
            task.top_paper_1,
            task.top_paper_2,
            task.top_paper_3,
          ].filter((id) => id !== null);

          if (paperIds.length === 0) continue;

          console.log(
            `Fetching ${paperIds.length} papers for task "${task.task_name}"`
          );

          const { data: papers, error: paperError } = await supabase
            .from("arxivPapersData")
            .select(
              `
              title,
              paperUrl,
              publishedDate,
              totalScore,
              arxivCategories
            `
            )
            .in("id", paperIds);

          if (paperError) {
            console.error(
              `Error fetching papers for task ${task.task_name}:`,
              paperError
            );
            continue;
          }

          if (papers && papers.length > 0) {
            processedTasks.push({
              task_name: task.task_name,
              papers: papers,
            });
          }
        }

        if (processedTasks.length > 0) {
          console.log(`Generating email for user ${userId}`);
          const emailHtml = `
            <h1>Your Weekly AI Research Update (${dateRange})</h1>
            <p>Here are the top papers from your followed research areas:</p>
            ${processedTasks
              .map(
                (task) => `
              <div>
                <h2>${task.task_name}</h2>
                <ul>
                  ${task.papers
                    .map(
                      (paper) => `
                    <li>
                      <a href="${paper.paperUrl}">${paper.title}</a>
                      <div>Published: ${new Date(
                        paper.publishedDate
                      ).toLocaleDateString()}</div>
                      <div>Categories: ${paper.arxivCategories.join(", ")}</div>
                    </li>
                  `
                    )
                    .join("")}
                </ul>
              </div>
            `
              )
              .join("")}
            <p>
              You're receiving this email because you've subscribed to updates from AI Models.
              <br>
              <a href="[Unsubscribe_Link]">Unsubscribe</a>
            </p>
          `;

          console.log(`Sending email to ${userData.email}`);
          await resend.emails.send({
            from: "Mike Young <mike@mail.aimodels.fyi>",
            to: [userData.email],
            subject: emailSubject,
            html: emailHtml,
          });

          console.log(`Email sent successfully to ${userData.email}`);
        } else {
          console.log(`No papers to send for user ${userId}`);
        }
      } catch (error) {
        console.error(`Error processing user ${userId}:`, error);
        continue;
      }
    }

    console.log("\nEmail notification service completed");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Run the main function
console.log("Initializing email notification service...");
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
