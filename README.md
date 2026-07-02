# Never Miss a Call — AI Receptionist for Tradespeople

An AI phone receptionist for plumbers, HVAC techs, electricians, and other home-services pros. It answers the phone in a natural voice, figures out what the caller needs, collects the job details, **texts the owner instantly**, and logs every lead to a simple job board the owner can pull up in the field.

The whole thing is built so the owner never touches a setting — **you** set it up for them. That's the business: they're losing jobs to missed calls and they won't configure software themselves.

---

## What's in here

```
never-miss-call/
├── src/
│   ├── server.js      Web server: Twilio webhook, media-stream socket, dashboard API
│   ├── realtime.js    The core bridge: phone audio <-> OpenAI realtime voice + tool calls
│   ├── agent.js       Builds the trade-specific script + the book_job / take_message tools
│   ├── db.js          Dependency-free JSON store for leads
│   └── sms.js         Texts the owner when a lead comes in
├── config/
│   └── business.example.json   One file per client = one configured receptionist
├── public/
│   └── dashboard.html The mobile job board the owner views
├── simulate.js        Test the agent with NO phone (and optionally NO API key)
├── .env.example       Copy to .env and fill in
└── README.md
```

---

## 1. Try it in 30 seconds (no accounts, no keys)

```bash
npm install
npm run simulate:mock
```

This runs a scripted emergency call through the whole pipeline — you'll see the conversation, the `book_job` tool fire, the lead save, and the exact text the owner would get. Then:

```bash
npm start
```

Open <http://localhost:3000>, enter the password (`changeme` by default), and you'll see that captured lead on the job board.

---

## 2. Talk to the real agent (OpenAI key, still no phone)

```bash
cp .env.example .env        # then put your OPENAI_API_KEY in .env
npm run simulate
```

Now you're typing as the caller and the **real model** is answering and booking jobs. This is the fastest way to tune the script in `config/*.json` before spending a cent on telephony. (This text sim uses the Chat Completions API; the live phone path uses the Realtime API.)

---

## 3. Go live on a real phone number

You need an **OpenAI** account (Realtime API) and a **Twilio** account (a phone number + SMS).

**a. Fill in `.env`** — `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, and `PUBLIC_HOST`.

**b. Deploy** to anywhere that gives you a public HTTPS URL with WebSocket support — Render, Railway, Fly.io, or a small VPS. Set `PUBLIC_HOST` to that host (no `https://`), e.g. `your-app.onrender.com`. Set all the `.env` values as environment variables in the host's dashboard.

> **Local testing with a real call:** run `npm start`, then in another terminal start a tunnel (`ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`) and set `PUBLIC_HOST` to the tunnel's host.

**c. Point Twilio at it.** In the Twilio console → your phone number → *Voice Configuration* → "A call comes in" → **Webhook**, `POST` to:

```
https://YOUR_PUBLIC_HOST/incoming-call
```

**d. Forward the client's existing number** to your Twilio number when they can't answer (most carriers: `*61*<twilio number>#` for no-answer forwarding, or set it in their carrier account). Now missed calls hit the AI instead of voicemail.

Call the number. The agent should greet, take a job, text the owner, and drop the lead on the board.

---

## 4. Set up a new client (your repeatable playbook)

Each client is **one JSON file** in `config/`. Copy `business.example.json`, fill in their name, trade, services, hours, owner cell, and greeting, then set `BUSINESS=their-file-name` (without `.json`) in that client's environment. That's the whole onboarding. Aim to do it in under an hour.

To run multiple clients, deploy one instance per client (cheap) — or extend `server.js` to pick the config by the Twilio number that was dialed (the `To` field) for true multi-tenant. Start with one-per-client; add multi-tenant once you have enough clients to justify it.

---

## 5. Cost math (per client)

- **Twilio:** ~$1–2/mo per number + ~$0.0085/min inbound + ~$0.0079 per SMS.
- **OpenAI Realtime (`gpt-realtime-2`):** billed per audio token; budget **roughly $0.06–0.15 per call minute** depending on length and how much the model talks. Confirm current rates on OpenAI's pricing page before you quote.
- **Hosting:** ~$5–7/mo (one small instance can serve several low-volume clients).

So a client doing, say, 60 answered minutes/month costs you on the order of $5–15 all-in. Charge **$199–$399/mo** and you keep most of it. One booked job pays for their year.

---

## 6. Important notes & caveats

- **Realtime API is mid-migration (June 2026).** The GA model `gpt-realtime-2` uses the nested `session.audio.*` config; the older beta used flat fields. This repo defaults to GA (`REALTIME_API_MODE=ga`). If `session.update` is rejected with an "unknown parameter" error, flip `REALTIME_API_MODE=beta` and set `REALTIME_MODEL=gpt-realtime`. The μ-law format value (`audio/pcmu`) and event names can change — if you get audio-format errors, check the current Realtime docs and update the two `format.type` values in `src/realtime.js`.
- **Call recording consent is state-specific.** Washington and Oregon have different rules (WA is all-party consent). If you record or transcribe calls, add a spoken disclosure at the start and confirm the client's obligations. This code does not record audio by default.
- **TCPA applies to outbound.** This product is inbound-only. If you later add outbound texts/calls, get explicit opt-in and honor stop requests.
- **The agent must not invent prices or firm appointment times** — the prompt already forbids this, but spot-check it per trade. An AI that promises "$89" or "we'll be there at 2" creates real liability for your client. Keep it to "the owner will confirm."
- **Always capture a callback number.** The prompt treats this as the one non-negotiable field so a garbled call still produces a usable lead.
- **Test the demo line before you sell.** Your entire pitch rests on a prospect calling a number and hearing something that sounds good. Get one solid config dialed in first.

---

## License / next steps

This is your MVP. Sensible next builds, roughly in order: per-Twilio-number multi-tenant routing, a calendar integration so it offers real time slots, post-call summary texts, and a tiny admin page to edit a client's config without touching JSON.
