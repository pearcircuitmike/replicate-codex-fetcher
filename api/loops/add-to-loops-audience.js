import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const loopsApiKey = process.env.LOOPS_API_KEY;
const loopsApiUrl = "https://app.loops.so/api/v1/contacts/create";

async function addToLoopsAudience() {
  try {
    console.log("Fetching profiles...");
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("*")
      .or(
        "stripe_subscription_status.is.null,and(stripe_subscription_status.neq.active,stripe_subscription_status.neq.substack,stripe_subscription_status.neq.inactive)"
      )
      .is("added_to_loops", null)
      .not("last_signin_at", "is", null);

    if (error) {
      console.error("Supabase query error:", error);
      throw error;
    }

    console.log(`Found ${profiles?.length || 0} profiles to process`);

    let addedCount = 0;
    let alreadyInLoopsCount = 0;
    let errorCount = 0;

    for (const profile of profiles) {
      try {
        console.log(`Processing profile: ${profile.id}`);

        const loopsData = {
          email: profile.email,
          userId: profile.id,
          firstName: profile.full_name?.split(" ")[0] || "",
          lastName: profile.full_name?.split(" ").slice(1).join(" ") || "",
          subscribed: true,
          userGroup: profile.stripe_subscription_status || "Unknown",
        };

        const response = await fetch(loopsApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${loopsApiKey}`,
          },
          body: JSON.stringify(loopsData),
        });

        const responseData = await response.json();

        if (responseData.success) {
          console.log(`Added ${profile.email} to Loops`);
          await supabase
            .from("profiles")
            .update({ added_to_loops: new Date().toISOString() })
            .eq("id", profile.id);
          addedCount++;
        } else if (responseData.message?.includes("already on list")) {
          console.log(`${profile.email} is already in Loops`);
          alreadyInLoopsCount++;
        } else {
          throw new Error(
            responseData.message || "Failed to add contact to Loops"
          );
        }
      } catch (error) {
        console.error(`Error processing profile ${profile.id}:`, error.message);
        errorCount++;
      }
    }

    console.log("\nProcess completed");
    console.log(`Added to Loops: ${addedCount}`);
    console.log(`Already in Loops: ${alreadyInLoopsCount}`);
    console.log(`Errors: ${errorCount}`);
  } catch (error) {
    console.error("Script failed:", error.message);
  }
}

addToLoopsAudience();
