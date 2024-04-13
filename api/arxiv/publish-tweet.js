import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import puppeteer from "puppeteer";
import sharp from "sharp";

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

async function generateTweetText(summary, abstract, platform, slug) {
  const maxTokens = 1000;
  const promptPercentage = 0.8;
  const maxPromptLength = Math.floor(maxTokens * promptPercentage);
  const prefix = "🔥 Trending paper: ";
  const suffix = `\n\nMore info: https://aimodels.fyi/papers/${platform}/${slug}`;
  const maxTweetLength = 280 - prefix.length - suffix.length;

  try {
    const inputText = summary || abstract;
    let truncatedText = inputText;
    if (inputText.length > maxPromptLength) {
      truncatedText = inputText.substring(0, maxPromptLength);
    }

    const message = await anthropic.messages.create({
      model: "claude-3-opus-20240229",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `Summarize the following research paper in one clear, twitter concise phrase:
  
            ${truncatedText}
            `,
        },
      ],
    });

    if (message && message.content && message.content.length > 0) {
      let tweetText = message.content[0].text.trim();
      if (tweetText.length > maxTweetLength) {
        tweetText = tweetText.substring(0, maxTweetLength);
      }
      tweetText = `${prefix}${tweetText}${suffix}`;
      console.log("Tweet text generated:", tweetText);
      return tweetText;
    } else {
      console.log("No tweet text generated");
      return "";
    }
  } catch (error) {
    console.error("Error generating tweet text:", error);
    return "";
  }
}

async function captureScreenshot(url) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: "networkidle2" });
  const screenshotBuffer = await page.screenshot({ fullPage: false });
  await browser.close();
  return screenshotBuffer;
}

async function processImage(imageBuffer) {
  // Get image metadata to check dimensions
  const metadata = await sharp(imageBuffer).metadata();

  // Set the initial top and calculate maximum possible height
  const top = 230;
  let height = 640; // Initial desired height

  // Adjust height if necessary to fit within the image dimensions
  if (metadata.height < top + height) {
    height = metadata.height - top; // Adjust height so that top + height does not exceed the image height
  }

  // Proceed with cropping if dimensions are adequate
  const croppedImage = await sharp(imageBuffer)
    .extract({ left: 0, top: top, width: 1280, height: height })
    .toBuffer();

  // Resize the cropped image to the desired final dimensions
  const resizedImage = await sharp(croppedImage)
    .resize({ width: 1200, height: 675, fit: "cover" })
    .toFormat("png")
    .toBuffer();

  return resizedImage;
}

async function postTweetWithImage(tweetText, imageBuffer) {
  try {
    const mediaId = await client.v1.uploadMedia(imageBuffer, {
      mimeType: "image/png",
    });
    const tweet = await client.v2.tweet(tweetText, {
      media: { media_ids: [mediaId] },
    });
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
      new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    )
    .is("twitterPublishedDate", null)
    .order("totalScore", { ascending: false }) // Assuming 'score' is the column name and you want the highest scores first
    .limit(1);

  if (error) {
    console.error("Error fetching papers:", error);
    return;
  }

  for (const paper of papers) {
    const { id, generatedSummary, abstract, platform, slug } = paper;

    const tweetText = await generateTweetText(
      generatedSummary,
      abstract,
      platform,
      slug
    );

    if (!tweetText) {
      console.log(`Unable to generate tweet text for paper ${id}`);
      continue;
    }

    const screenshotUrl = `https://aimodels.fyi/papers/${platform}/${slug}`;
    const screenshotBuffer = await captureScreenshot(screenshotUrl);
    const processedImageBuffer = await processImage(screenshotBuffer);

    const tweetId = await postTweetWithImage(tweetText, processedImageBuffer);

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

    await delay(30000); // 30-second delay to avoid rate limits
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

processPapers();
