// scripts/sendCommunityInvites.js
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

// 1) Create your supabase client with SERVICE KEY
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 2) Create Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

async function main() {
  console.log("Checking for pending invites...");

  // 1) Fetch invites with status='pending' up to 50
  const { data: invites, error } = await supabase
    .from("community_invites")
    .select(
      `
        id,
        invitee_email,
        community_id,
        invited_by,
        expires_at,
        status,
        created_at,
        communities ( name ),
        invited_by_profile:public_profile_info!invited_by ( full_name )
      `
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("Error fetching invites:", error);
    process.exit(1);
  }

  if (!invites || invites.length === 0) {
    console.log("No pending invites found.");
    process.exit(0);
  }

  for (const invite of invites) {
    try {
      // 2) Check expiration
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        // Mark expired
        await supabase
          .from("community_invites")
          .update({ status: "expired" })
          .eq("id", invite.id);
        console.log(`Invite ${invite.id} expired.`);
        continue;
      }

      // 3) Build the email
      const communityName = invite.communities?.name || "the community";
      const inviterName = invite.invited_by_profile?.full_name || "Someone";
      const inviteLink = `https://www.aimodels.fyi/invite?inviteId=${invite.id}`;

      const subjectLine = `Join "${communityName}" on AImodels.fyi`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #3b82f6; font-size: 24px;">
            Join "${communityName}" on AImodels.fyi
          </h1>

          <p style="font-size: 16px; color: #333;">
            ${inviterName} has invited you to join the "${communityName}" community on AImodels.fyi!
          </p>

          <p style="font-size: 14px; color: #333;">
            AImodels.fyi is a discussion forum for academic papers where researchers can share insights,
            ask questions, and engage in meaningful discussions about research. Communities on AImodels.fyi
            help you stay connected with your research peers and discover relevant papers together.
          </p>

          <div style="text-align: center; margin: 20px 0;">
            <a href="${inviteLink}"
              style="display: inline-block; background-color: #3b82f6; color: #fff;
                    padding: 12px 20px; border-radius: 5px; text-decoration: none;
                    font-weight: bold; font-size: 16px;"
            >
              Join "${communityName}"
            </a>
          </div>

          <p style="font-size: 12px; color: #666;">
            This invitation was sent by ${inviterName}. If you're not interested, you can ignore this email.
          </p>
        </div>
      `;

      // 4) Try sending with Resend
      let response;
      try {
        response = await resend.emails.send({
          // MUST be a verified domain in Resend
          from: "Mike Young <mike@mail.aimodels.fyi>",
          replyTo: ["mike@aimodels.fyi"],
          to: [invite.invitee_email],
          subject: subjectLine,
          html,
        });
      } catch (sendErr) {
        console.error(`Resend error for invite ${invite.id}:`, sendErr);
        // Mark as 'failed' if it fails
        await supabase
          .from("community_invites")
          .update({ status: "failed" })
          .eq("id", invite.id);

        // Then skip to next invite
        continue;
      }

      // If we reach here, sending succeeded
      console.log(
        `Invite ${invite.id} -> ${invite.invitee_email} [OK]. Resend response:`,
        response
      );

      // 5) Mark status='sent'
      await supabase
        .from("community_invites")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
        })
        .eq("id", invite.id);

      console.log(`Invite ${invite.id} marked as sent.`);
    } catch (err) {
      console.error(`Error processing invite ${invite.id}:`, err);
      // Optionally set status='failed' if you want to catch *any* error
      // but you might prefer to keep it as 'pending' for debugging
    }
  }

  console.log("Done processing invites.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error in sending invites:", err);
  process.exit(1);
});
