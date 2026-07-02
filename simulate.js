// simulate.js
// Test the receptionist WITHOUT a phone. Two modes:
//
//   node simulate.js          -> real conversation via OpenAI (needs OPENAI_API_KEY).
//                                Type as if you're a caller; the agent talks back
//                                in text and actually calls book_job/take_message.
//
//   node simulate.js --mock   -> NO api key needed. Runs a scripted caller through
//                                a booking so you can verify the DB + owner-text
//                                pipeline and see a sample dashboard lead.
//
// Either way, captured leads land in the same SQLite DB the phone version uses,
// so you can run `npm start` afterward and see them on the dashboard.

import "dotenv/config";
import readline from "readline";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildInstructions, tools } from "./src/agent.js";
import { saveLead } from "./src/db.js";
import { notifyOwner } from "./src/sms.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUSINESS = process.env.BUSINESS || "business.example";
const biz = JSON.parse(
  readFileSync(join(__dirname, "config", `${BUSINESS}.json`), "utf8")
);

const MOCK = process.argv.includes("--mock");

async function runTool(name, args) {
  const type = name === "book_job" ? "job" : "message";
  const lead = saveLead({ type, ...args, caller_number: "+1 555 010 0000" });
  console.log(`\n  ✅ ${name} → lead #${lead.id} saved to the job board`);
  const { body } = await notifyOwner(biz, lead);
  return { ok: true, saved_id: lead.id };
}

// ----------------------------------------------------------------------------
// MOCK MODE — no API key, scripted booking to prove the pipeline end to end.
// ----------------------------------------------------------------------------
async function mock() {
  console.log(`\n=== MOCK CALL to ${biz.businessName} ===`);
  console.log(`(no API key used — this just exercises booking + owner text + DB)\n`);
  const script = [
    ["Caller", "Hi, my water heater is leaking all over the garage floor."],
    ["Assistant", "Oh no — let's get someone out to you. Can I grab your name and the best number to reach you?"],
    ["Caller", "Yeah, it's Dana Whitfield, 360-555-0142."],
    ["Assistant", "Thanks Dana. What's the service address, and is the water actively flooding right now?"],
    ["Caller", "1820 NE 3rd Ave, Camas. It's pooling but not flooding — but it's getting worse."],
    ["Assistant", "Got it. I'm logging this as urgent and Mike will call you right back to lock in a time."],
  ];
  for (const [who, line] of script) {
    console.log(`  ${who}: ${line}`);
    await new Promise((r) => setTimeout(r, 350));
  }
  await runTool("book_job", {
    customer_name: "Dana Whitfield",
    callback_number: "+1 360-555-0142",
    service_address: "1820 NE 3rd Ave, Camas, WA",
    problem: "Water heater leaking in the garage, getting worse",
    is_emergency: true,
  });
  console.log(`\nDone. Run "npm start" and open the dashboard to see this lead.\n`);
  process.exit(0);
}

// ----------------------------------------------------------------------------
// LIVE MODE — real agent via OpenAI Chat Completions (text), same prompt+tools.
// ----------------------------------------------------------------------------
async function live() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set. Use `node simulate.js --mock` to test without a key.");
    process.exit(1);
  }
  const model = process.env.SIM_MODEL || "gpt-4o";
  const messages = [
    { role: "system", content: buildInstructions(biz) + "\n\n(You are in a TEXT simulation. Reply in text as you would speak.)" },
  ];
  const fnTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log(`\n=== SIMULATED CALL to ${biz.businessName} ===`);
  console.log(`Type as the caller. Ctrl-C to hang up.\n`);

  // let the agent greet first
  await turn();

  async function turn() {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, tools: fnTools, tool_choice: "auto" }),
    });
    const data = await res.json();
    if (data.error) { console.error("API error:", data.error.message); process.exit(1); }
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await runTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      return turn(); // let the model respond after the tool result
    }

    if (msg.content) console.log(`  Assistant: ${msg.content}\n`);
    const userText = await ask("  Caller: ");
    messages.push({ role: "user", content: userText });
    return turn();
  }
}

if (MOCK) mock();
else live();
