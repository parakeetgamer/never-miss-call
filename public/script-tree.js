// script-tree.js — the branching call navigator.
// Every node: what YOU say, why it works, and what they might say back.
// Terminal kinds: "close" | "schedule" | "exit"
// {BIZ} and {OWNER} are swapped for the prospect's details at render time.

window.CALL_SCRIPT = {
  start: {
    stage: "After the demo",
    say: "So that's it working as {BIZ}. Want me to set it up on your real line this week?",
    why: "Ask, then STOP TALKING. Top reps pause 5x longer than average after an objection. Let the silence do the work.",
    options: [
      { label: "👍 Yes / sounds good", goto: "close" },
      { label: "💵 Too expensive", goto: "A0" },
      { label: "🤖 Customers will hate a robot", goto: "B0" },
      { label: "📞 Voicemail's fine / not missing calls", goto: "C0" },
      { label: "🕐 Need to think about it", goto: "D0" },
      { label: "⚠️ What if I cancel / you're one guy", goto: "E0" },
    ],
  },

  // ---------------- A · PRICE ----------------
  A0: {
    stage: "Price",
    say: "Totally fair — nobody wants another monthly bill. But look at it this way: $299 a month is about ten bucks a day. One missed call in your trade is worth what, a couple hundred? More on a big job. So let me ask — if the price fit what you were comfortable with, is this something you'd want working for you?",
    why: "ISOLATE before you answer. This turns the objection into a closing question and tells you if price is really the blocker.",
    options: [
      { label: "\"Yeah, if the money made sense\"", goto: "A1" },
      { label: "\"No, it's not really the money\"", goto: "A2" },
    ],
  },
  A1: {
    stage: "Price · it's genuinely the money",
    say: "Good — then it's not really about the money, it's about making sure it pays for itself. Most guys cover the $299 with one job they'd have missed. Small shops miss up to 62% of their calls during business hours. Save one a month and you're ahead. Want to run it month-to-month so it has to earn its keep?",
    why: "Reframe cost as a leak, not an expense. Month-to-month kills the risk.",
    options: [
      { label: "\"Okay, let's try it\"", goto: "close" },
      { label: "\"Still need to think about it\"", goto: "D0" },
      { label: "\"That's still a lot right now\"", goto: "A2b" },
    ],
  },
  A2: {
    stage: "Price was a smokescreen",
    say: "I appreciate you being straight with me. So what is it really — is it whether your customers will be okay with an AI picking up, or whether it actually works the way I'm telling you?",
    why: "GOLD. The stated objection wasn't the real one. Now you're actually selling.",
    options: [
      { label: "\"It's the AI thing\"", goto: "B0" },
      { label: "\"It's you being one guy\"", goto: "E2" },
      { label: "\"Honestly I'm just busy\"", goto: "D0" },
    ],
  },
  A2b: {
    stage: "Price · cash is genuinely tight",
    say: "I hear you, cash is tight for everybody right now. Here's the thing though — this isn't really a cost, it's plugging a leak. Do me a favor: this week, jot down every call you miss. If it's not costing you way more than $299, don't buy it. Fair?",
    why: "Don't discount. Give homework instead — their own numbers will sell it for you.",
    options: [
      { label: "\"Alright, I'll do that\"", goto: "schedule" },
      { label: "\"Fine, let's just try it\"", goto: "close" },
    ],
  },

  // ---------------- B · TRUST / AI ----------------
  B0: {
    stage: "Trust · the robot worry",
    say: "I get it, I'd worry about that too. But can I be honest? Right now the alternative isn't you picking up — it's voicemail. About 85% of people who hit voicemail just hang up and call the next guy. A friendly voice that grabs their name and problem beats a beep every time. You just heard it answer as your own shop — did that sound like a robot to you?",
    why: "Reframe: it's not AI vs you, it's AI vs voicemail. Then hand them the evidence they just heard.",
    options: [
      { label: "\"No, it sounded pretty good\"", goto: "B1" },
      { label: "\"My older customers want a real person\"", goto: "B2" },
      { label: "\"I just don't trust AI, period\"", goto: "B3" },
    ],
  },
  B1: {
    stage: "Trust · they liked it (BUYING SIGNAL)",
    say: "Right? Most callers won't even clock that it's AI — and the ones who do just care that somebody answered. Want me to set it up so it only picks up the calls you're already missing, after hours and when you're on a job?",
    why: "That's a buying signal. Stop selling and close on the smallest version.",
    options: [
      { label: "\"Yeah, let's do it\"", goto: "close" },
      { label: "\"Still not sure\"", goto: "B2" },
    ],
  },
  B2: {
    stage: "Trust · wants a real person",
    say: "Totally — and for the ones who want you, it takes a message and texts you right away so you can call them straight back. It's not replacing you, it's making sure nobody falls through the cracks while your hands are full. If it books the jobs you're flat-out missing today, that's found money, right?",
    why: "Position as backup, never replacement. Never insult whoever answers now.",
    options: [
      { label: "\"Yeah, that makes sense\"", goto: "close" },
      { label: "\"I'd have to see it\"", goto: "B2b" },
    ],
  },
  B2b: {
    stage: "Trust · puppy-dog close",
    say: "Then don't take my word for it. Run it a month and listen to the calls yourself. If even one customer complains, call me and we shut it off same day. Deal?",
    why: "Skeptical buyers believe what they experience, not what they're told. Let the product do the arguing.",
    options: [
      { label: "\"Alright, deal\"", goto: "close" },
      { label: "\"Let me sleep on it\"", goto: "D2" },
    ],
  },
  B3: {
    stage: "Trust · deep AI distrust",
    say: "Fair enough — a lot of this AI stuff is overhyped. That's exactly why I don't ask you to trust it. You hear every call it takes, it texts you every message, and you can pull the plug any day with no penalty. You stay in the driver's seat the whole time. What would you need to see in the first week to feel good about it?",
    why: "Their answer becomes your trial success metric. Write it down and use it.",
    options: [
      { label: "They name something specific", goto: "schedule" },
      { label: "\"Okay, one month\"", goto: "close" },
      { label: "\"Nah, not for me\"", goto: "exit" },
    ],
  },

  // ---------------- C · STATUS QUO ----------------
  C0: {
    stage: "Status quo · voicemail's fine",
    say: "It might be — but let me push back a little, friendly-like. Only about 15% of people leave a voicemail anymore. The rest just call the next name on Google. So voicemail isn't catching those jobs, it's where they go to die. When's the last time you actually counted how many calls you miss in a week?",
    why: "Make the status quo the risky choice. Then ask a question they can't answer — that gap IS the sale.",
    options: [
      { label: "\"I'm not missing that many\"", goto: "C1" },
      { label: "\"My wife / office gal answers\"", goto: "C2" },
      { label: "\"I've gotten by 20 years\"", goto: "C3" },
    ],
  },
  C1: {
    stage: "Status quo · denial",
    say: "That's what most owners figure — and then they check. Small shops miss up to 62% of calls during business hours, most of them while you're up a ladder or under a sink. Tell you what: run this a week and look at the log of calls it caught that you'd never have known about. If the number's tiny, walk away. If it's five or six jobs, we should talk. Fair?",
    why: "Don't argue with their guess. Offer a measurement instead — their own data wins the argument.",
    options: [
      { label: "\"Alright, let's measure it\"", goto: "close" },
      { label: "\"I'll keep track myself\"", goto: "schedule" },
    ],
  },
  C2: {
    stage: "Status quo · someone already answers",
    say: "That's great — and honestly this isn't here to replace her. She's got to sleep, run errands, handle the other forty things. This covers nights, weekends, and when she's already on another line — that's where 35 to 45% of your calls land. It just hands her clean messages instead of her chasing missed calls. Would it help her to not be chained to the phone after hours?",
    why: "Frame it as helping HER, not replacing her. Never make him defend his wife's work.",
    options: [
      { label: "\"Yeah, she'd love that\"", goto: "close" },
      { label: "\"I'd have to ask her\"", goto: "C2b" },
    ],
  },
  C2b: {
    stage: "Status quo · needs her buy-in",
    say: "Makes sense, it's her line too. Can we grab two minutes with her on the phone Thursday so she hears it herself? Way easier than me explaining it through you.",
    why: "Real stakeholder — don't fight it, get them both on the phone.",
    options: [
      { label: "\"Sure, Thursday works\"", goto: "schedule" },
      { label: "\"I'll talk to her and call you\"", goto: "schedule" },
    ],
  },
  C3: {
    stage: "Status quo · 20 years without it",
    say: "No doubt — you built a real business without any of this. I'd just say the way people call has changed. They don't wait around anymore; most folks hire whoever answers first. This is about not handing those to the guy down the road. Want to test it a month and see what it catches — no contract, cancel whenever?",
    why: "Respect the history, then make the market the reason to change — not their judgment.",
    options: [
      { label: "\"Alright, one month\"", goto: "close" },
      { label: "\"Let me think on it\"", goto: "D0" },
    ],
  },

  // ---------------- D · DELAY ----------------
  D0: {
    stage: "Delay · the stall",
    say: "Course — it's your call. Most folks who say that are either not sold yet, or there's one thing they're unsure about. Which one is it for me? Be straight — what's the piece you're chewing on?",
    why: "\"Think about it\" is almost never real. Surface the actual objection or you'll never hear from them again.",
    options: [
      { label: "\"It's the price\"", goto: "A0" },
      { label: "\"It's the AI thing\"", goto: "B0" },
      { label: "\"Just want to sleep on it\"", goto: "D2" },
      { label: "\"Call me at busy season\"", goto: "D3" },
      { label: "\"Need to ask my partner\"", goto: "D4" },
    ],
  },
  D2: {
    stage: "Delay · genuinely sleeping on it",
    say: "Fair. Let me make sleeping on it easy — there's no contract and you can cancel any day, so thinking about it and trying it cost you the same thing. Except trying it actually shows you the missed-call numbers. What if we switch it on today and you decide for real by Friday, with the data in front of you?",
    why: "Collapse the difference between deciding and trying. If they still resist, try the takeaway: \"Honestly, if you're not feeling it, maybe now's not the time?\"",
    options: [
      { label: "\"Alright, turn it on\"", goto: "close" },
      { label: "\"No, I really want to wait\"", goto: "schedule" },
    ],
  },
  D3: {
    stage: "Delay · call me at busy season",
    say: "That's actually backwards, and I'd say this as a friend — busy season is exactly when you're drowning and missing the most calls. Setting it up now, while it's calm, means it's already working when the flood hits. Want to get it in place before the phone blows up?",
    why: "The timing objection has a built-in reversal. Use it.",
    options: [
      { label: "\"Good point, let's do it\"", goto: "close" },
      { label: "\"No, call me then\"", goto: "schedule" },
    ],
  },
  D4: {
    stage: "Delay · needs partner",
    say: "Totally get it. Let me ask you though — if it were only up to you, would you do it?",
    why: "This one question separates a real stakeholder from a polite brush-off.",
    options: [
      { label: "\"Yeah, if it were just me\"", goto: "D4a" },
      { label: "They hesitate / dodge", goto: "D0" },
    ],
  },
  D4a: {
    stage: "Delay · they're sold, partner isn't",
    say: "Great — so you're sold, it's just getting them on board. What are they going to want to know? Let's get them that answer now. Can we grab five minutes with the two of you together?",
    why: "They're a yes. Don't send them off to sell it for you — you'll lose the deal in translation.",
    options: [
      { label: "\"Sure, let's set that up\"", goto: "schedule" },
      { label: "\"I'll handle it and call you\"", goto: "schedule" },
    ],
  },

  // ---------------- E · RISK / ONE GUY ----------------
  E0: {
    stage: "Risk · what if I cancel",
    say: "Then you cancel — one text, no penalty, no contract. It's month-to-month on purpose; I'd rather earn it every month than trap you. So since getting out is that easy, what's the risk in trying it? Want to start this month?",
    why: "This is usually a BUYING SIGNAL — they're picturing owning it. Answer fast and close.",
    options: [
      { label: "\"Alright, let's start\"", goto: "close" },
      { label: "\"What if it screws up a call?\"", goto: "E1" },
      { label: "\"You're just one guy though\"", goto: "E2" },
      { label: "\"Sounds complicated to set up\"", goto: "E3" },
    ],
  },
  E1: {
    stage: "Risk · what if it messes up",
    say: "Fair worry. Two things — you hear every call and read every message, so nothing's hidden from you. And if it ever flubs one, you tell me and I fix it that day. You've got me directly, not a call center in another state. If it's booking jobs you're missing today and you can watch it like a hawk, is that worth a one-month test?",
    why: "Transparency + your personal accountability. That's your edge over the big services.",
    options: [
      { label: "\"Yeah, okay\"", goto: "close" },
      { label: "Still hesitant", goto: "schedule" },
    ],
  },
  E2: {
    stage: "Risk · you're just one guy",
    say: "Straight answer: yeah, it's me. That's exactly why you get my cell and I actually answer it — try getting that from the big answering services. The system runs whether I'm at my desk or not, so your phone keeps getting answered either way. And month-to-month means if I ever let you down, you're gone in a day. Want to give me one month to prove it?",
    why: "Never hide the solo thing. Turn it into the reason to pick you.",
    options: [
      { label: "\"Alright, one month\"", goto: "close" },
      { label: "\"I'd feel better with a big company\"", goto: "E2b" },
    ],
  },
  E2b: {
    stage: "Risk · prefers a big company",
    say: "I get it. The difference is a big company treats a $299 account like a number — I treat it like my business, because it is. Do me one favor before you decide: run my one month next to whatever the big guys quoted you. If they're better, go with them, no hard feelings.",
    why: "Confident, unbothered, and reversible. Pushing harder here loses the referral too.",
    options: [
      { label: "\"Fair enough, let's try yours\"", goto: "close" },
      { label: "\"I'll think about it\"", goto: "schedule" },
      { label: "\"No thanks\"", goto: "exit" },
    ],
  },
  E3: {
    stage: "Risk · sounds complicated",
    say: "That's the best part — you do nothing. I set the whole thing up, record it in your shop's name, and forward your line. Takes me about a day and you don't touch a thing. If I handle all the tech, is there any reason not to let it run for a month?",
    why: "Remove effort entirely. \"You do nothing\" is the whole pitch for this buyer.",
    options: [
      { label: "\"No, I guess not\"", goto: "close" },
      { label: "\"Still want to think\"", goto: "D0" },
    ],
  },

  // ---------------- TERMINALS ----------------
  close: {
    stage: "CLOSE IT",
    kind: "close",
    say: "Perfect. I'll get your line answering — I can have it live tomorrow morning or Thursday. Which works better?",
    why: "Alternative-choice close: no yes/no, just a pick. Then get the details and go.",
    next: [
      "Get their cell number for lead texts",
      "Get their business hours + services they DON'T do",
      "Ask their carrier (for call forwarding)",
      "Text them the Stripe link while you're still on the phone",
      "Hit \"Onboard\" on this prospect and run the wizard",
    ],
    options: [{ label: "↺ Start the script over", goto: "start" }],
  },
  schedule: {
    stage: "BOOK THE NEXT STEP",
    kind: "schedule",
    say: "No problem at all. I'll give you a ring Tuesday. In the meantime do one thing for me — keep a rough tally of the calls you miss this week. That number's going to make this decision for you.",
    why: "Never leave with \"I'll check in sometime.\" A specific day plus homework beats a vague maybe.",
    next: [
      "Set the exact day and time — say it out loud",
      "Log it here as \"Call back\" with the date in your notes",
      "Follow up every 3–4 weeks with something NEW, never \"just checking in\"",
    ],
    options: [{ label: "↺ Start the script over", goto: "start" }],
  },
  exit: {
    stage: "EXIT CLEAN",
    kind: "exit",
    say: "No sweat — I'm not going to twist your arm. You know where I am. Do me one favor though: keep a rough tally of your missed calls this week. If it starts bugging you, give me a ring and we'll switch it on in a day.",
    why: "A graceful exit protects the referral and leaves the door open. Trades talk to each other.",
    next: [
      "Mark them \"Not interested\" — but keep them on the list",
      "Worth one value-add touch in a couple months (busy season, heat wave)",
      "Don't burn it. He knows other contractors.",
    ],
    options: [{ label: "↺ Start the script over", goto: "start" }],
  },
};

// Read these out loud in your head between calls — they mean STOP SELLING and close.
window.BUYING_SIGNALS = [
  "They say \"my customers\" — picturing ownership",
  "They ask how fast you can set it up",
  "They ask about cancelling or billing",
  "They repeat a benefit back to you positively",
  "They go quiet after the demo (they're doing the math — don't fill the silence)",
];
