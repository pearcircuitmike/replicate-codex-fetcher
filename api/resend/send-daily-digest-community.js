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
 * Return the last 24-hour range for "daily".
 */
function getDailyDateRange() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 1);

  function formatDate(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return {
    startDate,
    endDate,
    formatted: `${formatDate(startDate)} - ${formatDate(endDate)}`,
  };
}

/**
 * Minimal block for no papers in a community.
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
 * Renders top 3 papers for a community, **restricting authors to 3**.
 */
function renderCommunitySection(communityName, papers) {
  const papersHtml = papers
    .map((paper) => {
      const title = paper.title || "Untitled Paper";
      const authorsArr = Array.isArray(paper.authors) ? paper.authors : [];
      let authorsString = "";
      if (authorsArr.length > 3) {
        // first 3 and "and others"
        authorsString = authorsArr.slice(0, 3).join(", ") + ", and others";
      } else {
        authorsString = authorsArr.join(", ") || "Unknown author";
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
 * For each community, fetch tasks => top 3 papers => build HTML + gather paper IDs
 */
async function fetchPapersForCommunity(
  communityId,
  communityName,
  startDate,
  endDate
) {
  // tasks
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
      paperIds: [],
    };
  }
  if (!tasks || tasks.length === 0) {
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      paperIds: [],
    };
  }

  const taskIds = tasks.map((t) => t.task_id);

  // top 3 papers
  const { data: papers, error: papersErr } = await supabase
    .from("arxivPapersData")
    .select("id, title, abstract, authors, slug, totalScore")
    .gte("indexedDate", startDate.toISOString())
    .lte("indexedDate", endDate.toISOString())
    .overlaps("task_ids", taskIds)
    .order("totalScore", { ascending: false })
    .limit(3);

  if (papersErr) {
    console.error("Error fetching top papers:", papersErr);
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      paperIds: [],
    };
  }
  if (!papers || papers.length === 0) {
    return {
      communityHtml: renderEmptyCommunitySection(communityName),
      paperIds: [],
    };
  }

  const communityHtml = renderCommunitySection(communityName, papers);
  return { communityHtml, paperIds: papers.map((p) => p.id) };
}

/**
 * For the subject line, we pick a random paper from the big set of paperIds.
 */
async function fetchPaperDetails(paperIds) {
  if (!paperIds || paperIds.length === 0) return {};

  const { data, error } = await supabase
    .from("arxivPapersData")
    .select("id, title, authors, abstract, slug")
    .in("id", paperIds);

  if (error) {
    throw new Error(`Error fetching paper details: ${error.message}`);
  }

  const details = {};
  for (const p of data || []) {
    details[p.id] = p;
  }
  return details;
}

async function generateSubjectLine(paperDetails, dateRange) {
  const papersArray = Object.values(paperDetails);
  if (papersArray.length === 0) {
    return `Your Community Digest (${dateRange.formatted})`;
  }

  const randomIndex = Math.floor(Math.random() * papersArray.length);
  const randomPaper = papersArray[randomIndex];
  const paperTitle = randomPaper?.title || "Unknown Paper";

  try {
    const claudeResponse = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 60,
      system: `You are an AI that writes a single short subject line for a research digest email.
Never add extra text or disclaimers.
Avoid exclamations, adverbs, or buzzwords.
Output only one sentence under 90 characters.
Maintain a calm, clear tone. Be factual.`,
      messages: [
        {
          role: "user",
          content: `Paper title: "${paperTitle}"
You are an AI that writes a single short subject line for a research digest email.
No exclamations or extra fluff.`,
        },
      ],
    });

    if (
      claudeResponse &&
      claudeResponse.content &&
      claudeResponse.content.length > 0
    ) {
      return claudeResponse.content[0].text.trim();
    }
  } catch (err) {
    console.error("Error generating subject line with Claude:", err);
  }

  return `Research Paper Review: ${paperTitle} (${dateRange.formatted})`;
}

/**
 * Build & send the daily digest email for a single user, across all their communities
 */
async function sendDailyCommunityDigestEmail(
  userProfile,
  userCommunities,
  dateRange
) {
  let allCommunitiesHtml = "";
  let allPaperIds = [];

  for (const { community_id, community_name } of userCommunities) {
    const { communityHtml, paperIds } = await fetchPapersForCommunity(
      community_id,
      community_name,
      dateRange.startDate,
      dateRange.endDate
    );
    allCommunitiesHtml += communityHtml;
    allPaperIds.push(...paperIds);
  }

  // subject line from random paper
  const paperDetails = await fetchPaperDetails([...new Set(allPaperIds)]);
  const subjectLine = await generateSubjectLine(paperDetails, dateRange);

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <div style="text-align: left; margin-bottom: 20px;">
        <h1 style="color: #0070f3; font-size: 20px; margin-bottom: 8px;">
          Research & Discussion Digest
        </h1>
      </div>

      <p style="font-size: 15px; margin: 0 0 15px 0;">
        Hello! Here's a quick recap of activity on AImodels.fyi today:
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

      ${allCommunitiesHtml}

      <div style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">
        <hr style="border: none; border-top: 1px solid #eee;" />
        <p style="margin: 10px 0;">
          <a href="https://www.aimodels.fyi/account" style="color: #666; text-decoration: none;">
            Manage email preferences
          </a>
        </p>
        <p style="margin: 0;">© 2025 AImodels.fyi</p>
      </div>
    </div>
  `;

  // Send via Resend
  return resend.emails.send({
    from: "Mike Young <mike@mail.aimodels.fyi>",
    replyTo: ["mike@aimodels.fyi"],
    to: [userProfile.email],
    subject: subjectLine,
    html: emailHtml,
  });
}

/**
 * Main daily job.
 * Notice the .select(...) structure that goes digest_subscriptions -> profiles -> community_members -> communities
 */
async function main() {
  console.log("Starting daily community digest job...");
  const now = new Date();
  const dateRange = getDailyDateRange();

  // Updated to use exact 24-hour comparison
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

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
      .or(
        `last_communities_sent_at.is.null,last_communities_sent_at.lt.${oneDayAgo.toISOString()}`
      )
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
          console.log(`Sent daily community digest to user ${row.user_id}`);
        }
      } catch (err) {
        console.error(
          `Error sending daily digest to user ${row.user_id}:`,
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
