import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const loopsApiKey = process.env.LOOPS_API_KEY;
const loopsApiBaseUrl = "https://app.loops.so/api/v1";

const createRateLimiter = (maxRequests, interval) => {
  const queue = [];
  return async (fn) => {
    const now = Date.now();
    if (queue.length >= maxRequests) {
      const oldestRequest = queue.shift();
      const delay = Math.max(0, interval - (now - oldestRequest));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    queue.push(now);
    return fn();
  };
};

const limiter = createRateLimiter(10, 1000); // 10 requests per second

async function updateLoopsContacts() {
  try {
    console.log("Starting contact update process...");
    let start = 0;
    const limit = 1000;
    let totalProfiles = 0;
    let validatedProfiles = 0;
    let unvalidatedProfiles = 0;
    let addedCount = 0;
    let updatedCount = 0;
    let noActionCount = 0;
    let errorCount = 0;

    // Get the total count
    const { count, error: countError } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    if (countError) {
      console.error("Error fetching total count:", countError);
      return;
    }

    totalProfiles = count;
    console.log(`Total profiles: ${totalProfiles}`);

    // Process all profiles in batches of 1000
    while (start < totalProfiles) {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("*")
        .range(start, start + limit - 1);

      if (error) {
        console.error("Error fetching profiles:", error);
        return;
      }

      for (const profile of profiles) {
        if (profile.validated) {
          validatedProfiles++;
          if (
            profile.stripe_subscription_status === null ||
            (profile.stripe_subscription_status !== "active" &&
              profile.stripe_subscription_status !== "substack" &&
              profile.stripe_subscription_status !== "inactive")
          ) {
            if (
              profile.added_to_loops === null &&
              profile.last_signin_at !== null
            ) {
              try {
                await limiter(async () => {
                  const findResponse = await fetch(
                    `${loopsApiBaseUrl}/contacts/find?email=${encodeURIComponent(
                      profile.email
                    )}`,
                    {
                      method: "GET",
                      headers: {
                        Authorization: `Bearer ${loopsApiKey}`,
                      },
                    }
                  );

                  const findData = await findResponse.json();

                  let loopsData = {
                    email: profile.email,
                    userId: profile.id,
                    firstName: profile.full_name?.split(" ")[0] || "",
                    lastName:
                      profile.full_name?.split(" ").slice(1).join(" ") || "",
                    stripe_subscription_status:
                      profile.stripe_subscription_status || null,
                  };

                  let apiUrl, method;
                  if (Array.isArray(findData) && findData.length === 0) {
                    apiUrl = `${loopsApiBaseUrl}/contacts/create`;
                    method = "POST";
                    loopsData.userGroup =
                      Math.random() < 0.5 ? "Group 3" : "Group 2";
                  } else {
                    apiUrl = `${loopsApiBaseUrl}/contacts/update`;
                    method = "PUT";
                  }

                  const response = await fetch(apiUrl, {
                    method: method,
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${loopsApiKey}`,
                    },
                    body: JSON.stringify(loopsData),
                  });

                  const responseData = await response.json();

                  if (responseData.success) {
                    if (method === "POST") {
                      addedCount++;
                    } else {
                      updatedCount++;
                    }
                    await supabase
                      .from("profiles")
                      .update({ added_to_loops: new Date().toISOString() })
                      .eq("id", profile.id);
                  } else {
                    throw new Error(
                      responseData.message ||
                        "Failed to update/add contact to Loops"
                    );
                  }
                });
              } catch (error) {
                console.error(
                  `Error processing profile ${profile.id}:`,
                  error.message
                );
                errorCount++;
              }
            } else {
              noActionCount++;
            }
          } else {
            noActionCount++;
          }
        } else {
          unvalidatedProfiles++;
        }
      }
      start += profiles.length;
      console.log(`Processed ${start} out of ${totalProfiles} profiles`);
    }

    console.log("\nProcess completed");
    console.log(`Total profiles: ${totalProfiles}`);
    console.log(`Validated profiles: ${validatedProfiles}`);
    console.log(`Unvalidated profiles: ${unvalidatedProfiles}`);
    console.log(`Added to Loops: ${addedCount}`);
    console.log(`Updated in Loops: ${updatedCount}`);
    console.log(`No action needed: ${noActionCount}`);
    console.log(`Errors: ${errorCount}`);
  } catch (error) {
    console.error("Script failed:", error.message);
  }
}

updateLoopsContacts();
