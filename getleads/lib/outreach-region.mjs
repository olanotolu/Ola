/** Outreach geography: US, Canada, Mexico only */

const NA_COUNTRIES = new Set([
  "united states",
  "united states of america",
  "usa",
  "us",
  "u.s.",
  "canada",
  "mexico",
]);

const NON_NA_COUNTRIES = new Set([
  "nigeria",
  "portugal",
  "united kingdom",
  "uk",
  "england",
  "scotland",
  "wales",
  "ireland",
  "france",
  "germany",
  "spain",
  "italy",
  "brazil",
  "india",
  "australia",
  "singapore",
  "south africa",
  "kenya",
  "ghana",
  "uae",
  "united arab emirates",
]);

const NA_REGIONS = new Set(["noram", "north america", "na"]);

function norm(s) {
  return (s || "").trim().toLowerCase();
}

function countryFromContact(contact) {
  const sp = contact?.source_payload || {};
  const gb = sp.gojiberry || {};
  const candidates = [
    sp.person_country_name,
    sp.data?.person_country_name,
    sp.job_location_country,
    sp.data?.job_location_country,
    gb.location?.split(",").pop(),
    sp.location?.split(",").pop(),
  ];
  for (const c of candidates) {
    const n = norm(c);
    if (n) return n;
  }
  return "";
}

function regionFromContact(contact) {
  const sp = contact?.source_payload || {};
  return norm(sp.person_country_region || sp.data?.person_country_region || sp.person_continent || sp.data?.person_continent);
}

/**
 * True if contact is in US, Canada, or Mexico (by enrichment country/region or gojiberry location).
 */
export function isNorthAmericaContact(contact) {
  const country = countryFromContact(contact);
  const region = regionFromContact(contact);

  if (region && NA_REGIONS.has(region)) return true;
  if (country && NA_COUNTRIES.has(country)) return true;
  if (country && NON_NA_COUNTRIES.has(country)) return false;

  const gbLoc = norm(contact?.source_payload?.gojiberry?.location || contact?.source_payload?.location);
  if (gbLoc) {
    if (/\bcanada\b/i.test(gbLoc)) return true;
    if (/\b(united states|usa|u\.s\.)\b/i.test(gbLoc)) return true;
    if (/\bmexico\b/i.test(gbLoc)) return true;
    if (/\b(nigeria|portugal|united kingdom|uk|england|europe|africa|asia|australia)\b/i.test(gbLoc)) return false;
    // "City, State, United States" pattern
    if (/,\s*(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|dc)\b/i.test(gbLoc)) {
      return true;
    }
  }

  // No country signal: allow if account market is US/Canada metro (not a guarantee)
  const mk = norm(contact?.crm_accounts?.market_key || contact?.market_key);
  if (mk === "ca" || mk === "us" || mk === "nyc" || mk.endsWith("-nc") || mk.includes("charleston")) return true;

  // Default: exclude when unknown (safer for NA-only outreach)
  if (!country && !region && !gbLoc) return false;

  return false;
}

export function filterNorthAmericaContacts(contacts) {
  return (contacts || []).filter(isNorthAmericaContact);
}

export function northAmericaSkipReason(contact) {
  const country = countryFromContact(contact);
  if (country) return country;
  const region = regionFromContact(contact);
  if (region) return region;
  const gbLoc = norm(contact?.source_payload?.gojiberry?.location || contact?.source_payload?.location);
  if (gbLoc) return gbLoc;
  const mk = norm(contact?.crm_accounts?.market_key || contact?.market_key);
  if (mk) return `market_key=${mk}`;
  return "unknown region";
}

/** Throws with code NON_NA_CONTACT when contact is outside US/Canada/Mexico. */
export function assertNorthAmericaContact(contact) {
  if (isNorthAmericaContact(contact)) return;
  const reason = northAmericaSkipReason(contact);
  const msg = `Outreach blocked (non-North America): ${contact?.name || contact?.email || contact?.id} — ${reason}`;
  console.log(`[outreach] ${msg}`);
  const err = new Error(msg);
  err.code = "NON_NA_CONTACT";
  throw err;
}
