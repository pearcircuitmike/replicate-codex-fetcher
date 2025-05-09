import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";
import Anthropic from "@anthropic-ai/sdk"; // for Claude

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const resend = new Resend(process.env.RESEND_API_KEY);

// Claude
const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

/**
 * Return the last 72-hour range for "daily" so that users get papers
 * indexed on Friday even if they're reading on the weekend.
 * The 'formatted' property has been removed as per user feedback.
 */
function getDailyDateRange() {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 72 * 60 * 60 * 1000);

  return {
    startDate,
    endDate,
  };
}

/**
 * Minimal block for no papers in a community.
 */
function renderEmptyCommunitySection(communityName) {
  return `
    <div style="margin: 20px 0; padding: 20px; border: 2px solid #eaeaea; border-radius: 5px;">
      <h2 style="font-size: 16px; margin: 0;">${communityName}</h2>
      <p style="color: #666; margin: 10px 0 0 0; font-style: italic;">No new papers found for this period.</p>
    </div>
  `;
}

/**
 * Renders up to 3 papers for a community, restricting authors to 3.
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
      const scoreText = `<span style="color: #999; font-size: 12px; margin-left: 6px;">&bull; Score: ${score}</span>`;

      return `
        <div style="margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #eaeaea;">
          <a href="${slugLink}" style="font-weight: bold; color: #0070f3; text-decoration: none;">${title}</a>
          ${scoreText}
          <div style="font-size: 14px; color: #666; margin-top: 5px;">${authorsString}</div>
          <p style="font-size: 14px; color: #444; margin-top: 8px; line-height: 1.4;">${shortAbstract}</p>
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
 * For each community, fetch tasks → top 3 papers → build HTML + gather paper objects.
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

  const communityHtml = renderCommunitySection(communityName, papers);
  return { communityHtml, papers: papers };
}

/**
 * Generates a subject line based on the lead paper (highest totalScore).
 */
async function generateSubjectLine(leadPaper) {
  if (!leadPaper || !leadPaper.title) {
    return "Your AIModels.fyi Daily Update";
  }

  const paperTitle = leadPaper.title;
  const paperAbstract =
    leadPaper.abstract || "No abstract available for context.";

  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 85,
      system: `You are an AI copywriter for AIModels.fyi. Your goal is to craft a compelling email subject line that drives opens by highlighting the *significance* of a key research paper.
      Output only one single sentence, ideally under 70 characters, max 85.
      Focus on the "signal" – what makes this paper important or impactful.
      Be factual but create intrigue. Avoid generic hype.
      DO NOT use quotation marks around the subject line itself.
      NO extra text or disclaimers.`,
      messages: [
        {
          role: "user",
          content: `Paper Title: "${paperTitle}"
          Paper Abstract (for context): "${paperAbstract.substring(0, 400)}..."
          Craft a subject line that makes an AI expert feel they *need* to know about this paper. For example: "[Key finding]" or "[Compelling aspect of Paper Title]" or "New: [Intriguing part of title]".`,
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
    console.error("Error generating subject line with Claude:", err);
  }

  return `Key AI Insight: ${paperTitle.substring(0, 50)}${
    paperTitle.length > 50 ? "..." : ""
  } | AIModels.fyi`;
}

async function sendDailyCommunityDigestEmail(
  userProfile,
  userCommunities,
  dateRange // dateRange object contains startDate and endDate for fetching
) {
  let allCommunitiesHtml = "";
  let allFetchedPapersForUser = [];

  for (const { community_id, community_name } of userCommunities) {
    // Use dateRange.startDate and dateRange.endDate for fetching
    const { communityHtml, papers } = await fetchPapersForCommunity(
      community_id,
      community_name,
      dateRange.startDate,
      dateRange.endDate
    );
    allCommunitiesHtml += communityHtml;
    if (papers && papers.length > 0) {
      allFetchedPapersForUser.push(...papers);
    }
  }

  let leadPaper = null;
  if (allFetchedPapersForUser.length > 0) {
    leadPaper = allFetchedPapersForUser.reduce((prev, current) => {
      return prev.totalScore > current.totalScore ? prev : current;
    });
  }

  const subjectLine = await generateSubjectLine(leadPaper);

  const emailHtml = `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subjectLine}</title>
    </head>
    <body>
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <div style="text-align: left; margin-bottom: 20px;">
          <h1 style="color: #0070f3; font-size: 20px; margin-bottom: 8px;">Research & Discussion Digest</h1>
        </div>
        <p style="font-size: 15px; margin: 0 0 15px 0;">Hello${
          userProfile.full_name ? " " + userProfile.full_name.split(" ")[0] : ""
        },</p>
        <p style="font-size: 15px; margin: 0 0 15px 0;">Here's what people are talking about in the AI/ML research world today:</p>
        <div style="margin-bottom: 30px;">
          <a href="https://www.aimodels.fyi/dashboard" style="display: inline-block; padding: 10px 20px; color: #0070f3; text-decoration: none; font-weight: bold; border: 2px solid #0070f3; border-radius: 4px;">View Dashboard &rarr;</a>
        </div>
        ${allCommunitiesHtml}
        <div style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">
          <hr style="border: none; border-top: 1px solid #eee;" />
          <p style="margin: 10px 0;"><a href="https://www.aimodels.fyi/account" style="color: #666; text-decoration: none;">Manage email preferences</a></p>
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
  console.log("Starting daily community digest job...");
  const now = new Date();
  // dateRange will now only contain startDate and endDate.
  const dateRange = getDailyDateRange();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const filterString = `last_communities_sent_at.is.null,last_communities_sent_at.lt.${startOfToday.toISOString()}`;
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
      .eq("papers_frequency", "daily")
      .or(filterString)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (rowErr) {
      console.error("Error fetching daily community digest users:", rowErr);
      break;
    }
    if (!pageRows || pageRows.length === 0) {
      console.log("No more daily users to process.");
      break;
    }
    console.log(
      `Processing page ${page}, found ${pageRows.length} user rows...`
    );
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
      const userCommunities = membershipArray.map((m) => ({
        community_id: m.community_id,
        community_name: m.communities.name,
      }));
      try {
        await sendDailyCommunityDigestEmail(
          row.profiles,
          userCommunities,
          dateRange // Pass the dateRange object (containing startDate and endDate)
        );
        const { error: updateErr } = await supabase
          .from("digest_subscriptions")
          .update({ last_communities_sent_at: new Date().toISOString() })
          .eq("user_id", row.user_id);
        if (updateErr) {
          console.error(
            `Error updating last_communities_sent_at for user ${row.user_id}:`,
            updateErr
          );
        } else {
          console.log(
            `Sent daily community digest to user ${row.user_id} (${userEmail})`
          );
        }
      } catch (err) {
        console.error(
          `Error sending daily digest to user ${row.user_id} (${userEmail}):`,
          err
        );
      }
    }
    if (pageRows.length < pageSize) {
      break;
    }
    page++;
  }
  console.log("Daily community digest job complete.");
}

main().catch((err) => {
  console.error("Unhandled error in daily community digest:", err);
  process.exit(1);
});
