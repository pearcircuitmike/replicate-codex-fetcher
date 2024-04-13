import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const hashnodeApiKey = process.env.HASHNODE_API_KEY;

async function publishArticleToHashnode(article) {
  const { id, title, generatedSummary, thumbnail, slug } = article;

  const introMessage = `*This is a Plain English Papers summary of a research paper called [${title}](https://aimodels.fyi/papers/arxiv/${slug}). If you like these kinds of analysis, you should subscribe to the [AImodels.fyi newsletter](https://aimodels.substack.com) or follow me on [Twitter](https://twitter.com/mikeyoung44).*\n\n`;
  const outroMessage = `\n\n**If you enjoyed this summary, consider subscribing to the [AImodels.fyi newsletter](https://aimodels.substack.com) or following me on [Twitter](https://twitter.com/mikeyoung44) for more AI and machine learning content.**`;

  const modifiedSummary = introMessage + generatedSummary + outroMessage;

  const query = `
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post {
          id
          url
        }
      }
    }
  `;

  const variables = {
    input: {
      title,
      contentMarkdown: modifiedSummary,
      tags: [
        {
          slug: "beginners",
          name: "Beginner Developers",
        },
        {
          slug: "software-engineering",
          name: "Software Engineering",
        },
        {
          slug: "programming",
          name: "Programming",
        },
        {
          slug: "machine-learning",
          name: "Machine learning",
        },
        {
          slug: "data-science",
          name: "Data Science",
        },
      ],
      publicationId: "642375e09d72cf905288ffed",
      originalArticleURL: `https://aimodels.fyi/papers/arxiv/${slug}`,
      coverImageOptions: {
        coverImageURL: thumbnail,
      },
    },
  };

  try {
    const response = await axios.post(
      "https://gql.hashnode.com/",
      {
        query,
        variables,
      },
      {
        headers: {
          Authorization: hashnodeApiKey,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.errors) {
      console.error("Hashnode API returned errors:", response.data.errors);
      throw new Error("Failed to publish article to Hashnode");
    }

    const { data } = response.data;
    console.log(`Article "${title}" published to Hashnode`);

    // Update the hashnodePublishedDate column in the database
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ hashnodePublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating hashnodePublishedDate for article "${title}":`,
        updateError
      );
    }
  } catch (error) {
    console.error(
      `Error publishing article "${title}" to Hashnode:`,
      error.message
    );
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
      console.error("Response headers:", error.response.headers);
    }
    console.error("Request data:", {
      query,
      variables,
    });
  }
}

async function publishArticlesToHashnode() {
  const { data: articles, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .not("generatedSummary", "is", null)
    .is("hashnodePublishedDate", null)
    .gt("totalScore", 1);

  if (error) {
    console.error("Error fetching articles:", error);
    return;
  }

  const rateLimitDelay = 2000; // Delay of 2 seconds between each post (adjust as needed)

  for (const article of articles) {
    await publishArticleToHashnode(article);
    await delay(rateLimitDelay);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

publishArticlesToHashnode();
