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
    return true; // default to true if error, to avoid spamming
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

async function sendDelinquencyEmail(userEmail, firstName) {
  const greetingName = firstName || "there";

  await resend.emails.send({
    from: "Mike Young <mike@mail.aimodels.fyi>",
    replyTo: "mike@aimodels.fyi",
    to: [userEmail],
    subject: "Account will be deleted",
    html: `
      <p>Hey ${greetingName},</p>
      <p>
        We tried to charge your card for your aimodels.fyi subscription, but the payment failed.
        Your account is now scheduled to be canceled.
      </p>
      <p>
        If you want to keep your account, please update your billing information at
        <a href="https://www.aimodels.fyi/account" target="_blank" style="color: #0070f3;">Manage Subscription</a>.
        You can also get there by logging in and clicking the "account" dropdown in the top right.
        We'll delete your account if we can't charge your card.
      </p>
      <p>
        Feel free to reply to this email if you have any questions.
      </p>
      <p>
        Best,<br>
        Mike<br>
        <a href="https://aimodels.fyi" target="_blank" style="color: #0070f3;">aimodels.fyi</a>
      </p>
    `,
  });

  console.log(`Sent delinquency email to ${userEmail}`);
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

async function handleDelinquency(userId, subscriptionId) {
  const profile = await getUserProfile(userId);
  if (!profile || !profile.email) {
    console.log(
      `No valid email for user ${userId}. Skipping delinquency email.`
    );
    return;
  }

  const firstName = profile.full_name
    ? profile.full_name.trim().split(" ")[0]
    : null;

  const eventType = "payment_delinquency";
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

  await sendDelinquencyEmail(profile.email, firstName);
  await logEmailSent(userId, subscriptionId, eventType);
}

function startRealtimeListener() {
  console.log("Starting Realtime listener for delinquent subscriptions...");

  supabase
    .channel("subscriptions-delinquent-changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "subscriptions" },
      async (payload) => {
        const newRow = payload.new;
        console.log("DEBUG: Received update event (delinquency)");
        console.log("newRow:", newRow);

        // We only handle if the new row is now past_due, with no cancel_at_period_end
        if (
          newRow.status === "past_due" &&
          newRow.cancel_at_period_end === false
        ) {
          console.log(
            `Detected delinquency: sub ${newRow.id}, user ${newRow.user_id}`
          );
          await handleDelinquency(newRow.user_id, newRow.id);
        } else {
          console.log(
            `Condition not met (delinquency) for sub ${newRow.id}, user ${newRow.user_id}. 
             status: ${newRow.status}, cancel_at_period_end: ${newRow.cancel_at_period_end}`
          );
        }
      }
    )
    .subscribe();
}

startRealtimeListener();
