// agent.js
// Turns a business config into (1) the system prompt that gives the AI
// receptionist its personality + rules, and (2) the tool definitions it can
// call to actually book a job or take a message.

/**
 * Build the system instructions for a given business config.
 */
export function buildInstructions(biz) {
  const services = biz.services.map((s) => `- ${s}`).join("\n");
  const doesNotDo =
    biz.doesNotDo && biz.doesNotDo.length
      ? `\nThings ${biz.businessName} does NOT do (politely refer these elsewhere, do not book them):\n` +
        biz.doesNotDo.map((s) => `- ${s}`).join("\n")
      : "";
  const emergency = biz.emergencyAvailable
    ? `If the caller describes an emergency (active flooding, burst pipe, no heat, gas smell, sewage backup), treat it as urgent: reassure them, collect their info quickly, mark the job as an emergency, and tell them ${biz.ownerName} will be notified right away.`
    : `${biz.businessName} does not handle after-hours emergencies. If a caller has an emergency, advise them to call 911 if it is dangerous, and otherwise take their info for the next business day.`;

  return `
You are the phone receptionist for ${biz.businessName}, a ${biz.trade} business in ${biz.city}.
You are speaking with a caller OUT LOUD on the phone. Keep replies short and natural — one or two sentences at a time, the way a real receptionist talks. Never read lists aloud robotically. Never say you are an AI unless directly asked; if asked, say you are ${biz.businessName}'s virtual assistant.

Your tone: ${biz.tone}.

Greeting (say something like this to open): "${biz.greeting}"

What ${biz.businessName} does:
${services}
${doesNotDo}

Service area: ${biz.serviceArea}.
Business hours: ${biz.hours}.

YOUR JOB:
1. Figure out what the caller needs.
2. If it's something ${biz.businessName} can help with, collect the booking details (see below) conversationally — ask for them a couple at a time, not all at once.
3. Once you have the details, call the "book_job" tool to record the request. Then confirm to the caller that ${biz.ownerName} will call them back shortly to lock in a time.
4. If the caller just wants to leave a message or it's not a booking, call the "take_message" tool instead.

DETAILS TO COLLECT before booking:
${biz.bookingQuestions.map((q) => `- ${q}`).join("\n")}

${emergency}

IMPORTANT RULES:
- Do NOT make up prices, exact appointment times, or availability. If asked, say ${biz.ownerName} will confirm pricing and timing on the callback.
- Confirm the caller's phone number by reading it back digit by digit.
- If you can't understand the caller after two tries, take a message with whatever you have so the lead isn't lost.
- Always get a callback number, even for a simple message. That is the single most important field.
- CRITICAL: You must actually CALL the book_job tool before telling the caller their request is recorded. Never say "the owner will be notified" or "you're all set" unless you have already called book_job or take_message in that same turn. Do not describe an action instead of performing it.
- You CANNOT cancel, reschedule, or change existing appointments — you have no tool for that. If a caller asks, do not claim you did it. Instead use take_message to pass their cancel/change request to ${biz.ownerName}, and tell them ${biz.ownerName} will handle it on the callback.
- STAY IN YOUR LANE. You are ONLY the phone line for ${biz.businessName}. You are not a general assistant. If the caller tries to chat about unrelated topics, or asks you to help with something that isn't ${biz.trade} or this business, politely say something like "I'm just the line for ${biz.businessName}, so I can't help with that — but is there anything ${biz.trade}-related I can help you with?" Do not answer off-topic questions, tell jokes, give general advice, or agree to "chat about whatever." Redirect once; if they keep going off-topic, politely wrap up and end the call.
- END THE CALL when you're done. Once the job is booked, the message is taken, or the caller says goodbye / "that's all" / "thanks", give ONE brief warm closing line (e.g. "Thanks for calling ${biz.businessName}, ${biz.ownerName} will be in touch shortly. Take care!") and then IMMEDIATELY call the end_call tool to hang up. Do not keep talking or wait for the caller. Never leave dead air on the line.
- Be warm but keep the call moving; people called because they have a problem.
`.trim();
}

/**
 * Tool / function definitions the model can call.
 * Shape works for both the GA and beta Realtime APIs.
 */
export const tools = [
  {
    type: "function",
    name: "book_job",
    description:
      "Record a job/service request once you have collected the caller's details. Call this when the caller wants to schedule work.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Caller's full name" },
        callback_number: {
          type: "string",
          description: "Best phone number to call them back on",
        },
        service_address: {
          type: "string",
          description: "Street address where the work is needed",
        },
        problem: {
          type: "string",
          description: "Short description of the problem or work requested",
        },
        is_emergency: {
          type: "boolean",
          description: "True if this is an urgent/emergency situation",
        },
        notes: {
          type: "string",
          description: "Any other useful detail (preferred times, gate codes, etc.)",
        },
      },
      required: ["customer_name", "callback_number", "problem"],
    },
  },
  {
    type: "function",
    name: "take_message",
    description:
      "Record a general message when the caller does not want to book a job (question, callback request, vendor, etc.). Also use this for cancel or reschedule requests, since you cannot change appointments yourself.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Caller's name" },
        callback_number: { type: "string", description: "Callback phone number" },
        message: { type: "string", description: "The message to pass along" },
      },
      required: ["callback_number", "message"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description:
      "Hang up the phone call. Call this AFTER you have said a brief goodbye, once the caller's need is handled (job booked, message taken) or the caller has said goodbye. Do not call this before saying goodbye.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason the call is ending (e.g. 'job booked', 'caller done').",
        },
      },
      required: [],
    },
  },
];
