import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const loopsApiKey = process.env.LOOPS_API_KEY;
const loopsApiBaseUrl = "https://app.loops.so/api/v1";

const supabase = createClient(supabaseUrl, supabaseKey);

// Simplified rate limiter
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rateLimiter = async () => {
  await sleep(20); // Ensures 50 requests per second
};

async function updateLoopsContacts() {
  try {
    console.log("Fetching all profiles...");

    let allProfiles = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error, count } = await supabase
        .from("profiles")
        .select("*", { count: "exact" })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        console.error("Supabase query error:", error);
        return;
      }

      allProfiles = allProfiles.concat(data);

      if (data.length < pageSize) {
        hasMore = false;
      }

      page++;
    }

    const validatedProfiles = allProfiles.filter(
      (profile) => profile.last_signin_at !== null
    );
    const unvalidatedProfiles = allProfiles.filter(
      (profile) => profile.last_signin_at === null
    );

    console.log(`Total profiles: ${allProfiles.length}`);
    console.log(`Validated profiles: ${validatedProfiles.length}`);
    console.log(`Unvalidated profiles: ${unvalidatedProfiles.length}`);

    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const profile of validatedProfiles) {
      try {
        await rateLimiter();

        const findResponse = await fetch(
          `${loopsApiBaseUrl}/contacts/find?email=${encodeURIComponent(
            profile.email
          )}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${loopsApiKey}` },
          }
        );

        if (!findResponse.ok) {
          throw new Error(`Loops API error: ${findResponse.statusText}`);
        }

        const findData = await findResponse.json();

        if (Array.isArray(findData) && findData.length === 0) {
          // Contact doesn't exist in Loops, add new contact
          const newContact = {
            email: profile.email,
            userId: profile.id,
            firstName: profile.full_name?.split(" ")[0] || "",
            lastName: profile.full_name?.split(" ").slice(1).join(" ") || "",
            userGroup: ["Group 7", "Group 7", "Group 7"][
              Math.floor(Math.random() * 3)
            ],
            stripe_subscription_status:
              profile.stripe_subscription_status || null,
          };

          const createResponse = await fetch(
            `${loopsApiBaseUrl}/contacts/create`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${loopsApiKey}`,
              },
              body: JSON.stringify(newContact),
            }
          );

          if (!createResponse.ok) {
            throw new Error(
              `Failed to add contact: ${createResponse.statusText}`
            );
          }

          const createData = await createResponse.json();

          if (createData.success) {
            console.log(`Added new contact: ${profile.email} to Loops`);
            addedCount++;

            // Update added_to_loops timestamp
            const { error: updateError } = await supabase
              .from("profiles")
              .update({ added_to_loops: new Date().toISOString() })
              .eq("id", profile.id);

            if (updateError) {
              console.error(
                `Failed to update added_to_loops for ${profile.email}:`,
                updateError
              );
            }
          } else {
            throw new Error(
              createData.message || "Failed to add contact to Loops"
            );
          }
        } else {
          // Contact exists, check if we need to update stripe_subscription_status
          const existingContact = findData[0];
          const loopsStatus =
            existingContact.stripe_subscription_status === undefined
              ? null
              : existingContact.stripe_subscription_status;
          if (loopsStatus !== profile.stripe_subscription_status) {
            const updatePayload = {
              email: profile.email,
              stripe_subscription_status:
                profile.stripe_subscription_status || null,
            };

            const updateResponse = await fetch(
              `${loopsApiBaseUrl}/contacts/update`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${loopsApiKey}`,
                },
                body: JSON.stringify(updatePayload),
              }
            );

            if (!updateResponse.ok) {
              throw new Error(
                `Failed to update contact: ${updateResponse.statusText}`
              );
            }

            const updateResult = await updateResponse.json();

            if (updateResult.success) {
              console.log(
                `Updated stripe_subscription_status for ${profile.email} in Loops`
              );
              updatedCount++;
            } else {
              throw new Error(
                updateResult.message || "Failed to update contact in Loops"
              );
            }
          } else {
            console.log(`No update needed for ${profile.email}`);
            skippedCount++;
          }
        }
      } catch (error) {
        console.error(`Error processing profile ${profile.id}:`, error.message);
        errorCount++;
      }
    }

    console.log("\nProcess completed");
    console.log(`Validated profiles processed: ${validatedProfiles.length}`);
    console.log(`Unvalidated profiles skipped: ${unvalidatedProfiles.length}`);
    console.log(`Added to Loops: ${addedCount}`);
    console.log(`Updated in Loops: ${updatedCount}`);
    console.log(`No action needed: ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
  } catch (error) {
    console.error("Script failed:", error.message);
  }
}

updateLoopsContacts();
