import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const claudeApiKey = process.env.CLAUDE_API_KEY;
const anthropic = new Anthropic({ apiKey: claudeApiKey });

const client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function generateShitpost(summary, abstract, title, slug) {
  const maxTokens = 1000;
  const promptPercentage = 0.8;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);

  // Twitter counts all URLs (regardless of length) as 23 characters
  // Plus we have two newlines (2 chars) before the URL
  const urlLength = 25;
  const suffix = `\n\nhttps://aimodels.fyi/papers/arxiv/${slug}`;
  const maxContentLength = 280 - urlLength;

  try {
    const inputText = `Title: ${title}\n\n${summary || abstract}`;
    let truncatedText = inputText;
    if (inputText.length > maxPromptLength) {
      truncatedText = inputText.substring(0, maxPromptLength);
    }

    const message = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `You run a tech/ML account that comments on AI research papers with a mix of 
          genuine insight and playful commentary. Your tone is authentic, clever, 
          and occasionally irreverent - but never forced or "trying too hard to be funny." 
          You're like a witty researcher at a conference after-party.

Write a tweet that points out something genuinely interesting, amusing, or mildly absurd about this paper. Use a natural internet voice with occasional emojis, but avoid hashtags or overly-memed language. The goal is to be engaging and relatable while still being somewhat intellectual.

Rules:
- Do not use quotation marks in your response
- Keep it UNDER ${
            maxContentLength - 20
          } characters (this is crucial - the tweet will be cut off if too long)
- No hashtags
- Write the tweet directly without any extra text
- Must be complete sentences/thoughts - nothing cut off

<example>
Examples of good tone (but don't copy these exactly):
love how this paper is basically what if we tried the obvious thing but 
REALLY REALLY well and it actually worked better than all the fancy approaches
</example>
<example>
researchers will literally train 8 million neural 
networks instead of going to therapy
</example>
<example>
this reminds me of one of those papers where they spent $500k 
to prove that [simple obvious thing] works pretty well actually
</example>
<example>
"tHiS lOw VoLuMe"
i dont think you dont understand how early i found these
</example>
<example>
we launched a new relevancy model and conversion rate doubled for all clients

platform can now ingest your product catalog, find all the keywords related to it, automatically build out collection pages based on your skus, and do conversion rate optimization of those pages based on clickstream data in perpetuity 

check it out
</example>
<example>
"bro will you upvote me on producthunt"

"bro we're about to launch will you engage"

"bro will you post this video for me at the exact time i ask for it"

me

never talked to them before

them

asking for something

relationships drive the world 

get in more relationships
</example>

Here's the paper to comment on:

${truncatedText}

Respond with just the tweet text - no quotes, no explanation, no extra text.`,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let tweetText = message.content[0].text.trim();
      // Remove any quotation marks that might have been added
      tweetText = tweetText.replace(/['"]/g, "");

      // If still too long, truncate with a clean cutoff
      if (tweetText.length > maxContentLength) {
        // Find the last space before the limit
        const lastSpace = tweetText.lastIndexOf(" ", maxContentLength - 4);
        tweetText = tweetText.substring(0, lastSpace) + "...";
      }

      tweetText = `${tweetText}${suffix}`;
      console.log("Tweet generated:", tweetText);
      return tweetText;
    } else {
      console.log("No tweet generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating tweet:", error);
    return "";
  }
}

async function postTweet(tweetText) {
  try {
    const tweet = await client.v2.tweet(tweetText);
    console.log(`Tweet posted with ID ${tweet.data.id}`);
    return tweet.data.id;
  } catch (error) {
    console.error(`Failed to post tweet: ${error}`);
    return null;
  }
}

async function processPapers() {
  const { data: papers, error } = await supabase
    .from("arxivPapersData")
    .select("*")
    .gte(
      "publishedDate",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    )
    .is("twitterPublishedDate", null)
    .order("totalScore", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  if (papers.length === 0) {
    console.log("No papers found to process");
    return;
  }

  const paper = papers[0];
  const { id, generatedSummary, abstract, title, slug } = paper;

  const tweetText = await generateShitpost(
    generatedSummary,
    abstract,
    title,
    slug
  );

  if (!tweetText) {
    console.log(`Unable to generate tweet for paper ${id}`);
    return;
  }

  const tweetId = await postTweet(tweetText);

  if (tweetId) {
    const { error: updateError } = await supabase
      .from("arxivPapersData")
      .update({ twitterPublishedDate: new Date().toISOString() })
      .eq("id", id);

    if (updateError) {
      console.error(
        `Error updating twitterPublishedDate for paper ${id}:`,
        updateError
      );
    } else {
      console.log(`Updated twitterPublishedDate for paper ${id}`);
    }
  }
}

processPapers();
