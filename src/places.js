// places.js
// Pulls fresh businesses off the web so the call list never runs dry.
//
// Uses the Google Places API (Text Search). Set GOOGLE_PLACES_API_KEY in the
// environment to enable it — without a key the app still works, you just add
// prospects by hand or work the bundled seed list.

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = [
  "places.displayName",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
].join(",");

export function placesConfigured() {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

/**
 * Search for businesses, e.g. searchBusinesses("plumbers in Vancouver WA").
 * Returns [] (never throws) if the key is missing or the call fails.
 */
export async function searchBusinesses(query, { trade = "", max = 20 } = {}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !query || !query.trim()) return [];

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELDS,
      },
      body: JSON.stringify({
        textQuery: query.trim(),
        maxResultCount: Math.min(20, Math.max(1, max)),
      }),
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error(`[places] search failed: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.places || [])
      .map((p) => ({
        businessName: p.displayName?.text || "",
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",
        website: p.websiteUri || "",
        address: p.formattedAddress || "",
        city: cityFrom(p.formattedAddress || ""),
        trade,
        rating: typeof p.rating === "number" ? p.rating : null,
        reviewCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        source: "places",
        status: "new",
      }))
      .filter((p) => p.businessName && p.phone); // no phone = not callable
  } catch (e) {
    console.error("[places] search error:", e.message);
    return [];
  }
}

// "10110 NE 11th St, Vancouver, WA 98664, USA" -> "Vancouver, WA"
function cityFrom(formatted) {
  const parts = String(formatted).split(",").map((s) => s.trim());
  if (parts.length < 3) return "";
  const city = parts[parts.length - 3];
  const stateZip = parts[parts.length - 2] || "";
  const state = stateZip.split(" ")[0] || "";
  return city && state ? `${city}, ${state}` : city || "";
}
