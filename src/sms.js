// sms.js — text the owner the moment a lead comes in.
import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Format a lead into a readable text message.
 */
export function formatLead(biz, lead) {
  if (lead.type === "job") {
    const flag = lead.is_emergency ? "🚨 EMERGENCY JOB" : "🔧 New job";
    return [
      `${flag} — ${biz.businessName}`,
      lead.customer_name ? `Name: ${lead.customer_name}` : null,
      lead.callback_number ? `Phone: ${lead.callback_number}` : null,
      lead.service_address ? `Address: ${lead.service_address}` : null,
      lead.problem ? `Problem: ${lead.problem}` : null,
      lead.notes ? `Notes: ${lead.notes}` : null,
      `Call them back to confirm a time.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `📩 New message — ${biz.businessName}`,
    lead.customer_name ? `From: ${lead.customer_name}` : null,
    lead.callback_number ? `Phone: ${lead.callback_number}` : null,
    lead.message ? `Message: ${lead.message}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Send the SMS. No-ops gracefully (and logs) if Twilio isn't configured,
 * so the simulator and local testing still work without credentials.
 */
export async function notifyOwner(biz, lead) {
  const body = formatLead(biz, lead);
  if (!client || !TWILIO_PHONE_NUMBER || !biz.ownerCell || biz.ownerCell.includes("XXXX")) {
    console.log("\n[sms] (not sent — Twilio not configured) would send to owner:\n" + body + "\n");
    return { sent: false, body };
  }
  try {
    await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: biz.ownerCell,
      body,
    });
    console.log(`[sms] notified owner ${biz.ownerCell}`);
    return { sent: true, body };
  } catch (err) {
    console.error("[sms] failed to send:", err.message);
    return { sent: false, body, error: err.message };
  }
}
