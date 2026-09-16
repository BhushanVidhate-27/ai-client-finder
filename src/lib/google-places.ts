const GOOGLE_PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";

const PLACES_TIMEOUT_MS = 15 * 1000;

/** Places Text Search returns at most this many results per request. */
const MAX_RESULT_COUNT = 20;

const REQUIRED_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.primaryType",
  "places.types",
].join(",");

export interface Lead {
  placeId: string;
  businessName: string;
  address: string;
  googleMapsUrl: string;
  websiteUrl: string | undefined;
  internationalPhoneNumber: string | undefined;
  nationalPhoneNumber: string | undefined;
  rating: number | undefined;
  reviewCount: number | undefined;
  businessStatus: string | undefined;
  primaryType: string | undefined;
  types: string[] | undefined;
}

interface GooglePlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    googleMapsUri?: string;
    websiteUri?: string;
    internationalPhoneNumber?: string;
    nationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    primaryType?: string;
    types?: string[];
  }>;
}

export async function searchPlaces(
  niche: string,
  location: string,
  leadCount: number,
  options?: { discoveryPool?: number },
): Promise<Lead[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not configured on the server.");
  }

  // Request a larger candidate pool than the target lead count when asked, so
  // pipeline can rank NO_WEBSITE/NEEDS_REDESIGN opportunities from more than
  // the first N raw Google Places results.
  const poolSize =
    options?.discoveryPool !== undefined
      ? Math.max(1, Math.min(options.discoveryPool, MAX_RESULT_COUNT))
      : Math.max(1, Math.min(leadCount, MAX_RESULT_COUNT));

  const response = await fetch(GOOGLE_PLACES_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": REQUIRED_FIELDS,
    },
    body: JSON.stringify({
      textQuery: `${niche} in ${location}`,
      maxResultCount: poolSize,
    }),
    signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error("[google-places] upstream error:", response.status, errorBody.slice(0, 500));
    throw new Error("Google Places search failed.");
  }

  const data: GooglePlacesResponse = await response.json();

  const places = data.places ?? [];

  return places.slice(0, poolSize).map((place) => ({
    placeId: place.id ?? "",
    businessName: place.displayName?.text ?? "Unknown",
    address: place.formattedAddress ?? "",
    googleMapsUrl: place.googleMapsUri ?? "",
    websiteUrl: place.websiteUri,
    internationalPhoneNumber: place.internationalPhoneNumber,
    nationalPhoneNumber: place.nationalPhoneNumber,
    rating: place.rating,
    reviewCount: place.userRatingCount,
    businessStatus: place.businessStatus,
    primaryType: place.primaryType,
    types: place.types,
  }));
}
