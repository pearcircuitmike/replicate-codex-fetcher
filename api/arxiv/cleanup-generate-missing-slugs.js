import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import slugify from "slugify";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function generateSlug(title) {
  const articleRegex = /\b(a|an|the|of|for|in|on|and|with)\b/gi;
  const slug = slugify(title, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@]/g,
  })
    .replace(articleRegex, "")
    .replace(/[-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.split("-").slice(0, 7).join("-");
}
async function updatePaperSlugs() {
  try {
    console.log("Fetching papers with null slug...");

    const { data: papers, error } = await supabase
      .from("arxivPapersData")
      .select("id, title")
      .is("slug", null);

    if (error) {
      throw error;
    }

    console.log(`Found ${papers.length} papers with null slug`);

    for (const paper of papers) {
      const slug = generateSlug(paper.title);

      const { error: updateError } = await supabase
        .from("arxivPapersData")
        .update({ slug })
        .eq("id", paper.id);

      if (updateError) {
        console.error(
          `Failed to update slug for paper with ID ${paper.id}:`,
          updateError
        );
      } else {
        console.log(`Updated slug for paper with ID ${paper.id}`);
      }
    }

    console.log("Finished updating paper slugs");
  } catch (error) {
    console.error("Error updating paper slugs:", error);
  }
}

updatePaperSlugs();
