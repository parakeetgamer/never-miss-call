// scrape.js
// Fetch a business website and (a) return cleaned text, (b) use the model to
// extract structured onboarding fields from it. Used by the /clients autofill.

const EXTRACT_MODEL = process.env.EXTRACT_MODEL || "gpt-4o-mini";

// Pull readable text off a business website (best effort, capped).
export async function fetchSiteText(url) {
  if (!url) return "";
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(target, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(t);
    if (!res.ok) return "";
    let html = await res.text();
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    return html.slice(0, 4000); // a bit more than the demo, for better extraction
  } catch {
    return "";
  }
}

// Ask the model to pull structured fields out of the site text. Returns an
// object with whatever it could find; missing fields come back as "".
export async function extractBusinessInfo(siteText) {
  const empty = {
    businessName: "", trade: "", ownerName: "", city: "",
    serviceArea: "", hours: "", services: [], doesNotDo: [],
  };
  if (!siteText || !process.env.OPENAI_API_KEY) return empty;

  const sys =
    "You extract structured facts about a home-services business from its website text. " +
    "Return ONLY valid minified JSON, no prose, no code fences. " +
    "Keys: businessName (string), trade (string, e.g. plumbing/HVAC/electrical), " +
    "ownerName (string, first name if clearly stated else \"\"), city (string), " +
    "serviceArea (string, e.g. a county or list of towns), hours (string), " +
    "services (array of short strings), doesNotDo (array of short strings). " +
    "Use \"\" or [] for anything not clearly stated. Do NOT invent facts.";

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: siteText.slice(0, 4000) },
        ],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const parsed = JSON.parse(data.choices[0].message.content);
    return {
      businessName: str(parsed.businessName),
      trade: str(parsed.trade),
      ownerName: str(parsed.ownerName),
      city: str(parsed.city),
      serviceArea: str(parsed.serviceArea),
      hours: str(parsed.hours),
      services: arr(parsed.services),
      doesNotDo: arr(parsed.doesNotDo),
    };
  } catch (e) {
    console.error("[autofill] extraction failed:", e.message);
    return empty;
  }
}

function str(v) { return typeof v === "string" ? v.trim() : ""; }
function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}
