# What this program must do

The product: an AI phone receptionist for local trade businesses that answers
every call, captures a usable lead, and texts the owner. These are the
requirements the code is held to, in priority order.

## 1. Audio works, period
- Caller hears clear speech — never static, white noise, or silence.
- All audio to/from Twilio is G.711 μ-law @ 8kHz. The bot must never speak
  until the OpenAI session has **confirmed** that format (`session.updated`).
  If the session config is rejected, log it loudly — do not talk in the wrong
  format.

## 2. Conversation flow (in this order)
1. Greet the caller with the configured greeting, then **stop and wait**.
2. Ask what's going on / what's wrong. Wait for the answer.
3. Ask for their name — on its own. Wait.
4. Ask for the best callback number — on its own. Wait.
5. Ask how urgent it is (emergency vs. can be scheduled). Wait.
6. Ask any remaining booking questions, one per turn.
7. Save the lead (book_job / take_message) BEFORE claiming anything is saved.
8. Confirm the owner will call back, say a warm goodbye, then hang up.

## 3. Turn-taking discipline
- ONE question per turn. Never chain questions ("...and also...").
- Never continue to the next script step before the caller has actually
  answered out loud. Never answer its own questions or invent the caller's
  side of the conversation.
- If the caller starts talking while the bot is speaking, the bot stops
  immediately (cancel + truncate) — no talking over people.
- Don't cut callers off mid-thought; tolerate pauses (semantic turn
  detection, low eagerness).

## 4. Personality
- Warm, friendly, genuinely likeable — a helpful neighbor, not a call center.
- Never make the caller feel rushed. Pauses are fine.
- Short natural sentences, contractions, no robotic phrasing.

## 5. Stays on track
- Brief friendly small talk is fine, then steer back to the next question.
- Can't be derailed into unrelated tangents or non-business requests.
- Politely declines services the business doesn't offer.

## 6. Never lose a lead
- Never hang up before having: name + callback number + situation.
  (Hard-enforced in code — end_call is blocked until all three exist.)
- Sole exception: life-threatening emergency → tell them to call 911.
- If audio is unclear, ask to repeat — never hang up out of confusion.
- Every captured lead is saved to the dashboard and texted to the owner.

## 7. Makes sense
- No nonsensical or contradictory statements; the bot's memory of the call
  must match what the caller actually heard (truncation on interruption).
