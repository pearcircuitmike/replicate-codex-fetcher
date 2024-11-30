import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const BLOG_TOKEN = process.env.HUGGINGFACE_BLOGPOSTER_BROWSER_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function createBlogPost({ title, content, slug, isDraft = false }) {
  console.log(`Creating blog post: ${title}`);

  // Ensure slug is no longer than 50 chars
  const truncatedSlug = slug.slice(0, 50);

  const response = await fetch(`https://huggingface.co/api/blog/mikelabs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `token=${BLOG_TOKEN}`,
      Origin: "https://huggingface.co",
      Referer: "https://huggingface.co/new-blog",
    },
    body: JSON.stringify({
      content,
      title,
      isDraft,
      slug: truncatedSlug,
      coauthors: [],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    console.error(`Failed to create blog post: ${JSON.stringify(error)}`);
    return;
  }

  const result = await response.json();
  console.log(
    `Successfully created blog post: ${title} with slug: ${truncatedSlug}`
  );
  return result;
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 60 * 1000;
}

export async function publishRecentPapers() {
  try {
    const fiveDaysAgo = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      .select("*")
      .gt("totalScore", 0.5)
      .gte("indexedDate", fiveDaysAgo)
      .is("huggingFacePublishedDate", null)
      .not("generatedSummary", "is", null) // Exclude papers with null generatedSummary
      .order("totalScore", { ascending: false });

    if (error) {
      console.error("Error fetching papers:", error);
      return;
    }

    console.log(
      `Found ${papers.length} papers with summaries to publish from the last 5 days`
    );

    for (const paper of papers) {
      const content = `# ${paper.title}\n\n![${paper.title}](${paper.thumbnail})\n\n${paper.generatedSummary}`;

      try {
        const result = await createBlogPost({
          title: paper.title,
          content: content,
          slug: paper.slug,
          isDraft: false,
        });

        if (result) {
          const { error: updateError } = await supabase
            .from("arxivPapersData")
            .update({ huggingFacePublishedDate: new Date().toISOString() })
            .eq("id", paper.id);

          if (updateError) {
            console.error(
              `Error updating huggingFacePublishedDate for paper ${paper.title}:`,
              updateError
            );
          } else {
            console.log(
              `Updated huggingFacePublishedDate for paper ${paper.title}`
            );
          }

          const delay = getRandomDelay(2, 5);
          console.log(`Waiting ${delay / 60000} minutes before next post...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`Error publishing paper ${paper.title}:`, error);
        continue;
      }
    }

    console.log("Finished publishing all papers");
  } catch (error) {
    console.error("Error in publishRecentPapers:", error);
  }
}

publishRecentPapers();
