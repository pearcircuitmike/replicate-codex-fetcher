import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const resend = new Resend(process.env.RESEND_API_KEY);
const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

/**
 * Build a 7-day date range for the weekly email content.
 */
function getWeeklyDateRange() {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 6 * 24 * 60 * 60 * 1000);

  function formatDate(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return {
    startDate,
    endDate,
    formatted: `${formatDate(startDate)} - ${formatDate(endDate)}`, // Used in email body
  };
}

/**
 * Render an "empty community" HTML block.
 */
function renderEmptyCommunitySection(communityName) {
  return `
    <div style="margin: 20px 0; padding: 20px; border: 2px solid #eaeaea; border-radius: 5px;">
      <h2 style="font-size: 16px; margin: 0;">${communityName}</h2>
      <p style="color: #666; margin: 10px 0 0 0; font-style: italic;">
        No new papers found.
      </p>
    </div>
  `;
}

/**
 * Render up to 3 papers for a community.
 */
function renderCommunitySection(communityName, papers) {
  const papersHtml = papers
    .map((paper) => {
      const title = paper.title || "Untitled Paper";
      let authorsArr = [];

      if (Array.isArray(paper.paperAuthors) && paper.paperAuthors.length > 0) {
        const sortedPaperAuthors = paper.paperAuthors.sort(
          (a, b) => a.author_order - b.author_order
        );
        authorsArr = sortedPaperAuthors
          .map((pa) => pa.authors?.canonical_name)
          .filter((name) => typeof name === "string" && name.length > 0);
      }

      let authorsString = "";
      if (authorsArr.length === 0) {
        authorsString = "Unknown author";
      } else if (authorsArr.length > 3) {
        authorsString = authorsArr.slice(0, 3).join(", ") + ", et al.";
      } else {
        authorsString = authorsArr.join(", ");
      }

      const shortAbstract = paper.abstract
        ? paper.abstract.split(" ").slice(0, 30).join(" ") + "..."
        : "No abstract";
      const slugLink = paper.slug
        ? `https://aimodels.fyi/papers/arxiv/${paper.slug}`
        : "#";
      const score = paper.totalScore ? Math.round(Number(paper.totalScore)) : 0;
      const scoreText = `<span style="color: #999; font-size: 12px; margin-left: 6px;">• ${score} pts</span>`;
      return `
        <div style="margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #eaeaea;">
          <a href="${slugLink}" style="font-weight: bold; color: #0070f3; text-decoration: none;">
            ${title}
          </a>
          ${scoreText}
          <div style="font-size: 14px; color: #666; margin-top: 5px;">
            ${authorsString}
          </div>
          <p style="font-size: 14px; color: #444; margin-top: 8px; line-height: 1.4;">
            ${shortAbstract}
          </p>
        </div>
      `;
    })
    .join("");
  return `
    <div style="margin: 20px 0; padding: 20px; border: 2px solid #eaeaea; border-radius: 5px;">
      <h2 style="font-size: 16px; margin: 0;">${communityName}</h2>
      ${papersHtml}
    </div>
  `;
}

/**
 * For a given community, fetch tasks then the top 3 papers (by totalScore)
 * and their full details within the provided date range.
 */
async function fetchPapersForCommunity(
  communityId,
  communityName,
  startDate,
  endDate
) {
  const { data: tasks, error: tasksErr } = await supabase
    .from("community_tasks")
    .select("task_id")
    .eq("community_id", communityId);

  if (tasksErr) {
    console.error(
      `Error fetching tasks for community ${communityId}:`,
      tasksErr
    );
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      papers: [],
    };
  }
  if (!tasks || tasks.length === 0) {
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      papers: [],
    };
  }

  const taskIds = tasks.map((t) => t.task_id);
  const { data: papers, error: papersErr } = await supabase
    .from("arxivPapersData")
    .select(
      `
      id, 
      title, 
      abstract, 
      slug, 
      totalScore,
      paperAuthors!inner (  
        author_order,
        authors!inner (      
          canonical_name
        )
      )
    `
    )
    .gte("indexedDate", startDate.toISOString())
    .lte("indexedDate", endDate.toISOString())
    .overlaps("task_ids", taskIds)
    .order("totalScore", { ascending: false })
    .limit(3);

  if (papersErr) {
    console.error("Error fetching top papers:", papersErr);
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      papers: [],
    };
  }
  if (!papers || papers.length === 0) {
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      papers: [],
    };
  }

  const html = renderCommunitySection(communityName, papers);
  return { communityHtml: html, papers: papers }; // Return full paper objects
}

/**
 * Generates a subject line based on the lead paper.
 */
async function generateSubjectLine(leadPaper) {
  if (!leadPaper || !leadPaper.title) {
    return "Your AIModels.fyi Weekly Update";
  }

  const paperTitle = leadPaper.title;
  const paperAbstract =
    leadPaper.abstract || "No abstract available for context.";

  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620", // Using latest available Sonnet model
      max_tokens: 85,
      system: `You are an AI copywriter for AIModels.fyi. Your goal is to craft a compelling email subject line for a WEEKLY research digest that drives opens by highlighting the *significance* of a key research paper.
Output only one single sentence, ideally under 70 characters, max 85.
Focus on the "signal" – what makes this paper important or impactful for an AI expert audience.
Be factual but create intrigue. Avoid generic hype.
DO NOT use quotation marks around the subject line itself.
NO extra text or disclaimers.`,
      messages: [
        {
          role: "user",
          content: `Paper Title: "${paperTitle}"
Paper Abstract (for context): "${paperAbstract.substring(0, 400)}..."
Craft a subject line for a WEEKLY digest that makes an AI expert feel they *need* to know about this paper. Examples: "[Key finding]" or "This Week: [Compelling aspect of Paper Title]" or "New: [Intriguing part of title]".`,
        },
      ],
    });

    if (
      claudeResponse &&
      claudeResponse.content &&
      claudeResponse.content.length > 0
    ) {
      let subject = claudeResponse.content[0].text.trim();
      subject = subject.replace(/^["']|["']$/g, "");
      return subject;
    }
  } catch (err) {
    console.error(
      "Error generating subject line with Claude for weekly digest:",
      err
    );
  }

  return `Key Weekly AI Insight: ${paperTitle.substring(0, 45)}${
    paperTitle.length > 45 ? "..." : ""
  } | AIModels.fyi`;
}

async function sendWeeklyCommunityDigestEmail(
  userProfile,
  userCommunities,
  dateRange
) {
  let allHtml = "";
  let allFetchedPapersForUser = [];

  for (const { community_id, community_name } of userCommunities) {
    const { communityHtml, papers } = await fetchPapersForCommunity(
      // `papers` now holds full objects
      community_id,
      community_name,
      dateRange.startDate,
      dateRange.endDate
    );
    allHtml += communityHtml;
    if (papers && papers.length > 0) {
      allFetchedPapersForUser.push(...papers);
    }
  }

  let leadPaper = null;
  if (allFetchedPapersForUser.length > 0) {
    // Ensure unique papers before finding lead paper, in case of overlaps between communities
    const uniquePapersMap = new Map();
    allFetchedPapersForUser.forEach((paper) => {
      // Add paper if it's not in map, or if it is but current one has higher score
      if (
        !uniquePapersMap.has(paper.id) ||
        (uniquePapersMap.has(paper.id) &&
          paper.totalScore > uniquePapersMap.get(paper.id).totalScore)
      ) {
        uniquePapersMap.set(paper.id, paper);
      }
    });
    const uniquePapers = Array.from(uniquePapersMap.values());

    if (uniquePapers.length > 0) {
      leadPaper = uniquePapers.reduce((prev, current) => {
        return prev.totalScore > current.totalScore ? prev : current;
      });
    }
  }

  const subjectLine = await generateSubjectLine(leadPaper); // Pass the single leadPaper

  const emailHtml = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subjectLine}</title> 
    </head>
    <body>
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <div style="text-align: left; margin-bottom: 20px;">
        <h1 style="color: #0070f3; font-size: 20px; margin-bottom: 8px;">
          Research & Discussion Digest
        </h1>
      </div>
      <p style="font-size: 15px; margin: 0 0 15px 0;">
        Hello${
          userProfile.full_name ? " " + userProfile.full_name.split(" ")[0] : ""
        }! Here's a quick recap of activity on AImodels.fyi for the week of ${
    dateRange.formatted
  }:
      </p>
      <div style="margin-bottom: 30px;">
        <a
          href="https://www.aimodels.fyi/dashboard"
          style="
            display: inline-block;
            padding: 10px 20px;
            color: #0070f3;
            text-decoration: none;
            font-weight: bold;
            border: 2px solid #0070f3;
            border-radius: 4px;
          "
        >
          View Dashboard &rarr;
        </a>
      </div>
      ${allHtml}
      <div style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">
        <hr style="border: none; border-top: 1px solid #eee;" />
        <p style="margin: 10px 0;">
          <a href="https://www.aimodels.fyi/account" style="color: #666; text-decoration: none;">
            Manage email preferences
          </a>
        </p>
        <p style="margin: 0;">© ${new Date().getFullYear()} AIModels.fyi</p>
      </div>
    </div>
    </body>
  </html>
  `;
  return resend.emails.send({
    from: "Mike Young <mike@mail.aimodels.fyi>",
    replyTo: ["mike@aimodels.fyi"],
    to: [userProfile.email],
    subject: subjectLine,
    html: emailHtml,
  });
}

async function main() {
  console.log("Starting weekly community digest job...");
  const dateRange = getWeeklyDateRange();
  const now = new Date();

  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - 6);

  const filterString = `last_communities_sent_at.is.null,last_communities_sent_at.lt.${cutoff.toISOString()}`;

  const pageSize = 1000;
  let page = 0;

  while (true) {
    const { data: pageRows, error: rowErr } = await supabase
      .from("digest_subscriptions")
      .select(
        `
          user_id,
          last_communities_sent_at,
          profiles!inner (
            email,
            full_name,
            community_members!inner (
              community_id,
              communities!inner(name)
            )
          )
        `
      )
      .eq("papers_frequency", "weekly")
      .or(filterString)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (rowErr) {
      console.error("Error fetching weekly community digest users:", rowErr);
      break;
    }
    if (!pageRows || pageRows.length === 0) {
      console.log("No more weekly users to process.");
      break;
    }

    console.log(`Processing page ${page}, found ${pageRows.length} user(s)...`);

    for (const row of pageRows) {
      const userEmail = row.profiles?.email;
      if (!userEmail) {
        console.log(`User ${row.user_id} has no email, skipping...`);
        continue;
      }
      const membershipArray = row.profiles.community_members || [];
      if (membershipArray.length === 0) {
        console.log(`User ${row.user_id} has no communities, skipping...`);
        continue;
      }
      try {
        const userCommunities = membershipArray.map((m) => ({
          community_id: m.community_id,
          community_name: m.communities.name,
        }));
        await sendWeeklyCommunityDigestEmail(
          row.profiles,
          userCommunities,
          dateRange
        );
        const { error: updateErr } = await supabase
          .from("digest_subscriptions")
          .update({ last_communities_sent_at: now.toISOString() })
          .eq("user_id", row.user_id);
        if (updateErr) {
          console.error(
            `Error updating last_communities_sent_at for user ${row.user_id}:`,
            updateErr
          );
        } else {
          console.log(
            `Sent weekly community digest to user ${row.user_id} <${userEmail}>`
          );
        }
      } catch (err) {
        console.error(
          `Error sending weekly digest to user ${row.user_id} <${userEmail}>:`,
          err
        );
      }
    }

    if (pageRows.length < pageSize) {
      break;
    }
    page++;
  }

  console.log("Weekly community digest job complete.");
}

main().catch((err) => {
  console.error("Unhandled error in weekly community digest:", err);
  process.exit(1);
});
