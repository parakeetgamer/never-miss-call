# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start server with --watch (auto-restart on file changes)
npm start            # start server without watch
npm run simulate:mock  # run a scripted booking end-to-end — no API keys needed
npm run simulate     # interactive text chat with the real OpenAI model (needs OPENAI_API_KEY)
npm run test:call    # e2e fake-Twilio test: start server first (PORT=3100 npm start), then run this
```

There is no lint script or test runner — `npm run simulate:mock` is the main smoke-test.

For the e2e test, run the server and the test in separate terminals:
```bash
PORT=3100 npm start       # terminal 1
PORT=3100 npm run test:call  # terminal 2 — exits 0 if greeting audio arrives
```

## Architecture

This is a **single-process Node.js ESM app** (`"type": "module"` in package.json). No build step.

### Call path (the critical path)

1. **Twilio** calls the owner's number → forwards to our Twilio number → `POST /incoming-call`
2. **`server.js`** responds with TwiML that opens a WebSocket media stream to `/media-stream`
3. **`realtime.js`** (`startCallBridge`) bridges the Twilio socket to the OpenAI Realtime API:
   - Twilio sends G.711 μ-law audio frames as base64 → forwarded as `input_audio_buffer.append`
   - OpenAI sends back `response.audio.delta` (same μ-law format) → forwarded to Twilio as `media` events
   - Barge-in: on `input_audio_buffer.speech_started`, send `clear` to Twilio, `response.cancel` + `conversation.item.truncate` to OpenAI
4. **`agent.js`** builds the system prompt from the business config and defines three tools: `book_job`, `take_message`, `end_call`
5. **`db.js`** appends captured leads to `data/leads.json` (flat JSON file, no external DB)
6. **`sms.js`** texts the owner via Twilio SMS on every lead

### Key timing constraint: never speak before `session.updated`

OpenAI sends `session.created` first, then `session.updated` after our config is accepted. Audio queued before `session.updated` would play in the default 24kHz PCM format instead of G.711 μ-law, causing static. `realtime.js` queues Twilio audio and delays the greeting trigger until `session.updated` is received.

### OpenAI Realtime API modes (GA vs beta)

The `REALTIME_API_MODE` env var switches between two session config shapes:
- `ga` (default): nested `session.audio.input/output.format` objects, model `gpt-realtime-2`
- `beta`: flat `input_audio_format`/`output_audio_format` fields, model `gpt-realtime`

If `session.update` is rejected with an "unknown parameter" error logged as `*** SESSION CONFIG REJECTED ***`, flip the mode.

### Business config

Each client is `config/<name>.json`. The server loads the file named by `BUSINESS` env var (default: `business.example`). Fields: `businessName`, `trade`, `ownerName`, `ownerCell`, `city`, `serviceArea`, `hours`, `emergencyAvailable`, `services`, `doesNotDo`, `bookingQuestions`, `greeting`.

### Lead capture guard

`end_call` is blocked in `realtime.js` until `haveName`, `haveNumber`, and `haveSituation` are all true. The only exception is a life-threatening emergency keyword in the reason string. If the guard fires, a `function_call_output` error is returned to the model instructing it to keep asking.

### Dashboard

`public/dashboard.html` is a static file served at `/`. It polls `/api/leads?pw=<password>`. No framework — plain HTML/JS.

### Simulator vs live call

`simulate.js` uses the Chat Completions API (text-only) with the same prompt and tool definitions as the live call path. This makes it cheap to iterate on the prompt without Twilio or audio. The `--mock` flag skips the API entirely and runs a hardcoded script to exercise the DB + SMS pipeline.
