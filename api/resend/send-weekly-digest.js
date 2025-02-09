import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * For the email content, we gather papers from the last 7 days.
 * This does NOT control which users get emailed (that's the day-based logic below).
 */
function getDateRange() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 7); // last 7 days for content

  return {
    formatted: `${formatDate(startDate)} - ${formatDate(endDate)}`,
    startDate,
    endDate,
  };

  function formatDate(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

async function fetchPaperDetails(paperIds) {
  const { data, error } = await supabase
    .from("arxivPapersData")
    .select("id, title, authors, abstract, slug")
    .in("id", paperIds);

  if (error) {
    throw new Error(`Error fetching paper details: ${error.message}`);
  }

  return data.reduce((acc, paper) => {
    acc[paper.id] = paper;
    return acc;
  }, {});
}

async function fetchPaperCountForPeriod(startDate, endDate) {
  const { count, error } = await supabase
    .from("arxivPapersData")
    .select("id", { count: "exact" })
    .gte("indexedDate", startDate.toISOString())
    .lte("indexedDate", endDate.toISOString());

  if (error) {
    throw new Error(`Error fetching paper count: ${error.message}`);
  }

  return count;
}

/**
 * Sends the weekly digest email to one user.
 */
async function sendDigestEmail(user, tasks, dateRange, papersProcessedCount) {
  const paperIds = new Set();
  tasks.forEach((task) => {
    if (task.top_paper_1) paperIds.add(task.top_paper_1);
    if (task.top_paper_2) paperIds.add(task.top_paper_2);
    if (task.top_paper_3) paperIds.add(task.top_paper_3);
  });

  const paperDetails = await fetchPaperDetails([...paperIds]);
  const includedPaperCount = Object.keys(paperDetails).length;

  const tasksListHtml = tasks
    .map(
      (task, index) =>
        `<li style="margin-bottom: 10px; color: #000000">
          ${index + 1}. ${task.task_name || "Unknown Task"}
        </li>`
    )
    .join("");

  const tasksHtml = tasks
    .map((task) => {
      const papers = [
        paperDetails[task.top_paper_1],
        paperDetails[task.top_paper_2],
        paperDetails[task.top_paper_3],
      ].filter(Boolean);

      if (papers.length === 0) {
        return `
          <div style="margin: 20px 0; padding: 20px 25px; border: 2px solid #eaeaea; border-radius: 5px;">
            <h2 style="color: #000000; font-size: 16px; font-weight: bold; margin: 0;">
              ${task.task_name || "Unknown Task"}
            </h2>
            <p style="color: #666666; margin: 10px 0 0 0; font-style: italic;">
              No papers available for this task.
            </p>
          </div>
        `;
      }

      const papersHtml = papers
        .map((paper) => {
          const title = paper.title || "Untitled Paper";
          const slug = paper.slug || "#";
          const authors = Array.isArray(paper.authors)
            ? paper.authors.join(", ")
            : "Unknown author";
          const abstract = paper.abstract
            ? paper.abstract.split(" ").slice(0, 30).join(" ") + "..."
            : "No abstract available";

          return `
            <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eaeaea;">
              <a href="https://aimodels.fyi/papers/arxiv/${slug}" 
                 style="color: #0070f3; text-decoration: none; font-weight: bold; font-size: 14px;">
                ${title}
              </a>
              <div style="color: #666666; font-size: 14px; margin: 5px 0;">
                ${authors}
              </div>
              <div style="color: #454545; font-size: 14px; margin-top: 10px; line-height: 1.4;">
                ${abstract}
                ${
                  slug !== "#"
                    ? `<div style="margin-top: 10px;">
                        <a href="https://aimodels.fyi/papers/arxiv/${slug}"
                           style="color: #0070f3; text-decoration: none; font-size: 14px;">
                          Read more →
                        </a>
                       </div>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <div style="margin: 20px 0; padding: 20px 25px; border: 2px solid #eaeaea; border-radius: 5px;">
          <h2 style="color: #000000; font-size: 16px; font-weight: bold; margin: 0;">
            ${task.task_name || "Unknown Task"}
          </h2>
          <div style="margin-top: 15px;">${papersHtml}</div>
        </div>
      `;
    })
    .join("");

  // The overall HTML
  const emailHtml = `
    <div style="font-family: 'Geist', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff;">
      <div style="padding: 20px 25px; margin-bottom: 20px; background-color: #ffebee; border-radius: 5px;">
        <p style="color: #d32f2f; margin: 0; font-size: 14px; line-height: 1.5;">
          ⚠️ This is an experimental email digest. I'd love your feedback to make it better! 
          Please send your feedback to me at <a href="mailto:mike@aimodels.fyi" style="color: #d32f2f;">mike@aimodels.fyi</a> (cc'd).
        </p>
      </div>

      <div style="padding: 20px 25px 10px 25px;">
        <div style="text-align: left;">
          <h1 style="color: #000000; font-size: 16px; margin: 0;">
            Your AI Research Update (${dateRange.formatted})
          </h1>
        </div>
      </div>

      <div style="margin: 20px 25px; padding: 20px 25px; border: 2px solid #eaeaea; border-radius: 5px;">
        <div style="font-size: 16px; color: #000000;">
          <p style="margin: 0 0 15px 0;">
            AImodels.fyi is here to keep you up to date with the research you care about!
            Here's what we've processed:
          </p>
          <ul style="margin: 0; padding: 0 0 0 20px; color: #000000;">
            <li style="margin-bottom: 10px;">
              We reviewed <strong>${papersProcessedCount}</strong> papers in the last week
            </li>
            <li style="margin-bottom: 10px;">
              You're following <strong>${tasks.length}</strong> tasks
            </li>
            <li style="margin-bottom: 10px;">
              Based on your interests, there are <strong>${includedPaperCount}</strong> summaries you should check out.
            </li>
          </ul>
        </div>
      </div>

      <div style="padding: 0 25px;">
        <div style="margin: 20px 0;">
          <p style="font-size: 16px; color: #000000; margin: 0 0 15px 0;">
            <strong>You're currently following these topics:</strong>
          </p>
          <ul style="margin: 0; padding: 0 0 0 20px;">
            ${tasksListHtml}
          </ul>
        </div>
        <p style="color: #000000;">
          You can adjust your tasks in your 
          <a href="https://www.aimodels.fyi/dashboard" style="color: #0070f3; text-decoration: none;">
            dashboard
          </a>.
        </p>
      </div>

      ${tasksHtml}

      <div style="padding: 20px 25px; text-align: center; font-size: 12px; color: #454545; margin-top: 20px; border-top: 1px solid #eaeaea;">
        <p style="margin: 0 0 10px 0;">
          <a href="https://www.aimodels.fyi/account" style="color: #454545; text-decoration: none;">
            Manage email preferences
          </a> | 
        </p>
        <p style="margin: 0;">
          AIModels.FYI • Copyright © 2024
        </p>
      </div>
    </div>
  `;

  // Send via Resend
  return resend.emails.send({
    from: "Mike Young <mike@mail.aimodels.fyi>",
    replyTo: ["mike@aimodels.fyi"],
    to: [user.email],
    cc: ["mike@aimodels.fyi"],
    subject: `Your AI Research Update (${dateRange.formatted})`,
    html: emailHtml,
  });
}

async function main() {
  console.log("Starting weekly digest job...");
  const now = new Date();

  // Instead of "older than 7 days in hours," we do a day-based check:
  // We'll compare last_papers_sent_at to the start of (today minus 7 days).
  // So if last_papers_sent_at < that date (or is NULL), the user is eligible.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0); // midnight today
  startOfToday.setDate(startOfToday.getDate() - 7); // go back 7 days

  try {
    // Step 1: fetch tasks
    const { data: followedTaskUsers, error: taskUsersError } = await supabase
      .from("live_user_tasks_with_top_papers")
      .select("*");
    if (taskUsersError) {
      throw new Error(`Error fetching task users: ${taskUsersError.message}`);
    }

    // Gather all user_ids who have tasks
    const followedUserIds = [
      ...new Set(followedTaskUsers.map((row) => row.user_id)),
    ];

    // Step 2: find users whose papers_frequency=weekly
    // and last_papers_sent_at < startOfToday or is null
    const { data: users, error: userError } = await supabase
      .from("digest_subscriptions")
      .select(
        `
        user_id,
        papers_frequency,
        last_papers_sent_at,
        profiles!inner(email, stripe_subscription_status)
      `
      )
      .eq("papers_frequency", "weekly")
      .in("user_id", followedUserIds)
      .in("profiles.stripe_subscription_status", [
        "active",
        "trialing",
        "substack",
      ])
      .or(
        `last_papers_sent_at.is.null,last_papers_sent_at.lt.${startOfToday.toISOString()}`
      );

    if (userError) {
      throw new Error(`Error fetching users: ${userError.message}`);
    }

    console.log(`Found ${users.length} users eligible for weekly digest.`);

    for (const user of users) {
      console.log(`\nProcessing user ${user.user_id}...`);

      if (!user.profiles.email) {
        console.log(`No email found for user ${user.user_id}`);
        continue;
      }

      // For the email content itself, we fetch papers from the last 7 days
      const dateRange = getDateRange();
      const papersProcessedCount = await fetchPaperCountForPeriod(
        dateRange.startDate,
        dateRange.endDate
      );

      // Filter tasks for this user
      const tasks = followedTaskUsers.filter(
        (task) => task.user_id === user.user_id
      );

      // Send the email
      await sendDigestEmail(
        user.profiles,
        tasks,
        dateRange,
        papersProcessedCount
      );

      // Update last_papers_sent_at so we don't send again this week
      const { error: updateError } = await supabase
        .from("digest_subscriptions")
        .update({ last_papers_sent_at: now.toISOString() })
        .eq("user_id", user.user_id);

      if (updateError) {
        console.error(
          `Error updating last_papers_sent_at for user ${user.user_id}: ${updateError.message}`
        );
      } else {
        console.log(`Updated last_papers_sent_at for user ${user.user_id}`);
      }
    }

    console.log("Weekly digest job completed successfully.");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Execute main function
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
