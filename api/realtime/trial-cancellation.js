import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// =============== Helpers ===============

async function alreadyLoggedEmail(userId, subscriptionId, eventType) {
  const { data, error } = await supabase
    .from("subscription_event_emails")
    .select("id")
    .eq("user_id", userId)
    .eq("subscription_id", subscriptionId)
    .eq("event_type", eventType)
    .limit(1);

  if (error) {
    console.error("Error checking subscription_event_emails:", error);
    return true; // default to 'true' so we don't spam
  }

  return data.length > 0;
}

async function logEmailSent(userId, subscriptionId, eventType) {
  const { error } = await supabase.from("subscription_event_emails").insert([
    {
      user_id: userId,
      subscription_id: subscriptionId,
      event_type: eventType,
    },
  ]);

  if (error) {
    console.error("Error logging subscription_event_emails:", error);
  }
}

async function sendTrialCancellationEmail(userEmail, firstName) {
  const greetingName = firstName || "there";

  await resend.emails.send({
    from: "Mike Young <mike@mail.aimodels.fyi>",
    replyTo: "mike@aimodels.fyi",
    to: [userEmail],
    subject: "What went wrong?",
    html: `
      <p>Hi ${greetingName},</p>
      <p>
        I'm Mike Young, the founder of aimodels.fyi. I noticed you recently canceled your trial,
        and I wanted to check in. If we fell short for you, I want to learn why and make it right.
      </p>
      <p>
        Could you share a sentence or two on what you disliked about aimodels.fyi?
        Or perhaps a screenshot of where it performed poorly?
        This will help us improve the product for future users. If the issue is cost, let me know and I can get you a discount.
      </p>
      <p>
        I'd be very grateful to understand your candid thoughts.
        I'm listening and eager to fix our experience for you.
        Wishing you the best in any case!
      </p>
      <p>
        Best,<br>
        Mike<br>
        <a href="https://aimodels.fyi" target="_blank" style="color: #0070f3;">aimodels.fyi</a>
      </p>
    `,
  });

  console.log(`Sent trial cancellation email to ${userEmail}`);
}

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", userId)
    .limit(1);

  if (error) {
    console.error("Error fetching user profile:", error);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  return data[0];
}

// =============== Main Logic ===============

async function handleTrialCancellation(userId, subscriptionId) {
  const profile = await getUserProfile(userId);
  if (!profile || !profile.email) {
    console.log(
      `No valid email for user ${userId}. Skipping trial cancellation email.`
    );
    return;
  }

  const firstName = profile.full_name
    ? profile.full_name.trim().split(" ")[0]
    : null;

  const eventType = "trial_cancellation";
  const alreadySent = await alreadyLoggedEmail(
    userId,
    subscriptionId,
    eventType
  );
  if (alreadySent) {
    console.log(
      `Already sent a ${eventType} email to user ${userId} for subscription ${subscriptionId}.`
    );
    return;
  }

  await sendTrialCancellationEmail(profile.email, firstName);
  await logEmailSent(userId, subscriptionId, eventType);
}

function startRealtimeListener() {
  console.log("Starting Realtime listener for trial cancellations...");

  supabase
    .channel("subscriptions-trial-changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "subscriptions" },
      async (payload) => {
        const newRow = payload.new;
        console.log("DEBUG: Received update event (trial cancellations)");
        console.log("newRow:", newRow);

        // Condition: newRow must be 'trialing' + cancel_at_period_end = true
        if (
          newRow.status === "trialing" &&
          newRow.cancel_at_period_end === true
        ) {
          console.log(
            `Detected trial cancellation: sub ${newRow.id}, user ${newRow.user_id}`
          );
          await handleTrialCancellation(newRow.user_id, newRow.id);
        } else {
          console.log(
            `Condition not met (trial) for sub ${newRow.id}, user ${newRow.user_id}.
             status: ${newRow.status}, cancel_at_period_end: ${newRow.cancel_at_period_end}`
          );
        }
      }
    )
    .subscribe();
}

startRealtimeListener();
