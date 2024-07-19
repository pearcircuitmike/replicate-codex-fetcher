import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const loopsApiKey = process.env.LOOPS_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const loopsApiUrl = "https://app.loops.so/api/v1/events/send";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getWeeklyDigestEmails(page, pageSize) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from("profiles")
    .select("email", { count: "exact" })
    .eq("papers_digest_preference", "weekly")
    .not("last_signin_at", "is", null)
    .range(from, to);

  if (error) {
    throw new Error(`Supabase query error: ${error.message}`);
  }

  return { emails: data.map((profile) => profile.email), totalCount: count };
}

async function sendLoopsEvent(email) {
  const eventData = {
    email,
    eventName: "Weekly papers update",
    eventProperties: {
      updateDate: new Date().toISOString(),
    },
  };

  const response = await fetch(loopsApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loopsApiKey}`,
    },
    body: JSON.stringify(eventData),
  });

  const responseData = await response.json();

  if (!responseData.success) {
    throw new Error(
      responseData.message || "Failed to trigger Weekly papers update event"
    );
  }

  return responseData;
}

async function fireWeeklyUpdate() {
  try {
    console.log("Fetching emails for weekly digest...");

    const pageSize = 1000; // Supabase default limit
    let page = 0;
    let processedCount = 0;
    let totalCount = 0;

    // Calculate delay to achieve 8 requests per second
    const delayMs = 1000 / 8; // 125ms between requests

    while (true) {
      const { emails, totalCount: count } = await getWeeklyDigestEmails(
        page,
        pageSize
      );

      if (page === 0) {
        totalCount = count;
        console.log(`Found ${totalCount} active users for weekly digest.`);
      }

      if (emails.length === 0) {
        console.log("No more emails to process.");
        break;
      }

      for (const email of emails) {
        try {
          console.log(`Triggering Weekly papers update event for ${email}...`);
          await sendLoopsEvent(email);
          console.log(`Successfully triggered event for ${email}`);
          processedCount++;

          // Add delay after each request
          await delay(delayMs);
        } catch (error) {
          console.error(`Error triggering event for ${email}:`, error.message);
        }
      }

      console.log(`Processed ${processedCount} out of ${totalCount} emails...`);

      if (processedCount >= totalCount) {
        console.log("All emails have been processed.");
        break;
      }

      page++;
    }

    console.log("Weekly update process completed.");
    console.log(`Total emails processed: ${processedCount}`);
  } catch (error) {
    console.error("Error in fireWeeklyUpdate:", error.message);
  }
}

fireWeeklyUpdate();
