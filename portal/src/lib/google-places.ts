import 'server-only';
import { logError } from './observability';
import { resolveIntegrationSecret } from './integration-credentials';

// =============================================================================
// Prospección con IA, Fase A — thin fetch-direct client for the Google
// Places API (New), same convention as whatsapp-api.ts/telephony/twilio.ts:
// no SDK, every call returns {ok,data}|{ok:false,error}, never throws.
//
// Uses Text Search (searchText), not Nearby Search — verified against
// Google's current docs (developers.google.com/maps/documentation/
// places/web-service/{text-search,place-details}, fetched Aug 2026),
// deliberately, not the endpoint the session's own plan first sketched.
// Text Search geocodes a free-text query itself ("peluquerías en Las
// Palmas de Gran Canaria" resolves without a separate lat/lng step),
// which is exactly the shape a client's plain-language target profile
// (category + zone) already is — Nearby Search instead REQUIRES a
// lat/lng circle up front, which would mean geocoding locationQuery
// ourselves before ever calling Places. One fewer moving part, one
// fewer place to be wrong.
//
// UNVERIFIED AGAINST A REAL GOOGLE PLACES KEY — same standing caveat as
// meta-business.ts and telephony/twilio.ts: no key reachable from any
// environment this code has been built in. The shapes below are sourced
// from Google's current published contract, not guessed, but the first
// real call is the actual test this code hasn't had.
// =============================================================================

const API_BASE = 'https://places.googleapis.com/v1';
const TOOL_KEY = 'google_places';

export type GooglePlacesResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

/**
 * The key an operator pasted at /admin/portal/settings/integrations takes
 * precedence; GOOGLE_PLACES_API_KEY (env) is the fallback for an
 * environment where nothing has been saved through the portal yet — same
 * precedence as resolveActiveStripeSecret()'s DB-then-env fallback.
 */
async function resolveApiKey(): Promise<string | null> {
  return (await resolveIntegrationSecret(TOOL_KEY)) ?? process.env.GOOGLE_PLACES_API_KEY ?? null;
}

export async function isGooglePlacesConfigured(): Promise<boolean> {
  return (await resolveApiKey()) !== null;
}

interface GraphErrorBody {
  error?: { message?: string };
}

async function callPlacesApi<T>(
  path: string,
  method: 'GET' | 'POST',
  fieldMask: string,
  body?: Record<string, unknown>,
): Promise<GooglePlacesResult<T>> {
  const key = await resolveApiKey();
  if (!key) {
    return { ok: false, error: 'GOOGLE_PLACES_API_KEY not configured' };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Places API (New) auth + response-shaping: both are headers,
        // not query params — a real contract difference from the
        // legacy Places API this could easily be built against by
        // mistake without checking. There is NO default field set;
        // omitting X-Goog-FieldMask is documented to error outright.
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as (GraphErrorBody & T) | null;
    if (!res.ok) {
      return {
        ok: false,
        error: json?.error?.message ?? `google_places_http_${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    logError('google_places.request_failed', err, { path, method }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export interface PlaceSearchResult {
  id: string;
  name: string;
  formattedAddress: string | null;
  websiteUri: string | null;
  types: string[];
  latitude: number | null;
  longitude: number | null;
  /** A1 — solo llegan con `includeRatings`; null en una búsqueda normal.
   *  No confundir "sin valoración" (negocio nuevo, 0 reseñas) con "no se
   *  pidió": ambos son null aquí y quien compara debe descartar la fila,
   *  no tratarla como un 0 que hundiría la media de la zona. */
  rating: number | null;
  userRatingCount: number | null;
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
}

interface SearchTextResponse {
  places?: RawPlace[];
  nextPageToken?: string;
}

// places.location es campo Essentials, igual que los cuatro que ya había:
// añadirlo NO cambia el SKU que factura Google por esta búsqueda, y es lo
// que permite centrar después la búsqueda de competidores sin geocodificar
// la zona por nuestra cuenta.
const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.types,places.location,nextPageToken';

// A1 — la máscara del informe comparativo. rating y userRatingCount SÍ
// suben esta llamada de Essentials a Pro, así que van en una máscara
// aparte y nunca en el barrido semanal de runProspectingSearch: una
// búsqueda de campaña por cliente y semana no tiene por qué pagar Pro para
// unas estrellas que solo mira el informe de un prospecto concreto.
//
// Por lo mismo, las estrellas del propio prospecto salen de AQUÍ y no de
// getPlaceDetails: en Place Details, rating/userRatingCount pertenecen al
// SKU Enterprise + Atmosphere, el más caro de todos, y se pagaría en CADA
// lead creado. Una sola búsqueda Pro por informe cuesta bastante menos que
// encarecer los cientos de Details del barrido.
const SEARCH_WITH_RATINGS_FIELD_MASK = `${SEARCH_FIELD_MASK},places.rating,places.userRatingCount`;

function mapPlace(raw: RawPlace): PlaceSearchResult | null {
  // A result with no id is useless (it's the dedup key against
  // Lead.externalPlaceId) — drop it rather than create an
  // un-deduplicatable Lead.
  if (!raw.id) return null;
  return {
    id: raw.id,
    name: raw.displayName?.text ?? raw.id,
    formattedAddress: raw.formattedAddress ?? null,
    websiteUri: raw.websiteUri ?? null,
    types: raw.types ?? [],
    latitude: typeof raw.location?.latitude === 'number' ? raw.location.latitude : null,
    longitude: typeof raw.location?.longitude === 'number' ? raw.location.longitude : null,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    userRatingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
  };
}

export interface SearchPlacesParams {
  /** Free text — category and zone combined into one query, e.g.
   *  "peluquerías en Las Palmas de Gran Canaria". This is the client's
   *  own ProspectingCampaign.category + .locationQuery, concatenated —
   *  Text Search geocodes it itself. */
  textQuery: string;
  /** Optional bias circle. A BIAS, not a restriction — narrows results
   *  toward an area without excluding real matches just outside it,
   *  which matters for a client near a zone boundary. */
  locationBias?: { latitude: number; longitude: number; radiusMeters: number };
  /** From a previous call's nextPageToken — Text Search paginates,
   *  unlike Nearby Search, which is the other reason it's the right
   *  endpoint here: getting more than 20 results per campaign run
   *  doesn't require inventing an area-subdivision strategy. */
  pageToken?: string;
  /** A1 — pide también rating y userRatingCount. Sube el SKU de esta
   *  llamada de Essentials a Pro, así que solo lo usa el informe
   *  comparativo, nunca el barrido de campaña. */
  includeRatings?: boolean;
}

export async function searchPlaces(
  params: SearchPlacesParams,
): Promise<GooglePlacesResult<{ results: PlaceSearchResult[]; nextPageToken: string | null }>> {
  const body: Record<string, unknown> = { textQuery: params.textQuery, pageSize: 20 };
  if (params.pageToken) {
    body.pageToken = params.pageToken;
  }
  if (params.locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: params.locationBias.latitude, longitude: params.locationBias.longitude },
        // Google caps this at 50000m — clamp defensively so a bad
        // ProspectingCampaign.radiusMeters value 400s against Google
        // instead of being caught here, where the caller can log which
        // campaign was misconfigured.
        radius: Math.min(Math.max(params.locationBias.radiusMeters, 1), 50000),
      },
    };
  }

  const result = await callPlacesApi<SearchTextResponse>(
    '/places:searchText',
    'POST',
    params.includeRatings ? SEARCH_WITH_RATINGS_FIELD_MASK : SEARCH_FIELD_MASK,
    body,
  );
  if (!result.ok) return result;

  const results = (result.data.places ?? [])
    .map(mapPlace)
    .filter((p): p is PlaceSearchResult => p !== null);
  return { ok: true, data: { results, nextPageToken: result.data.nextPageToken ?? null } };
}

export interface PlaceDetails {
  id: string;
  name: string;
  formattedAddress: string | null;
  websiteUri: string | null;
  phoneNumber: string | null;
  /** Google's own category for the place (e.g. 'hair_salon') — not the
   *  same string as ProspectingCampaign.category, which is the
   *  client's free-text search term, not a validated Places type. */
  primaryType: string | null;
  /** 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY'.
   *  Worth surfacing: a permanently-closed business is not a lead. */
  businessStatus: string | null;
  /** A1 — coordenadas del negocio, para poder buscar después a sus
   *  competidores alrededor. Campo Essentials: esta llamada ya es
   *  Enterprise por el teléfono, así que pedirlo no cuesta más. */
  latitude: number | null;
  longitude: number | null;
}

// Sin rating/userRatingCount a propósito: en Details pertenecen al SKU
// Enterprise + Atmosphere y se pagarían en cada lead del barrido. El
// informe A1 los obtiene de una búsqueda Pro puntual — ver
// SEARCH_WITH_RATINGS_FIELD_MASK.
const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,websiteUri,internationalPhoneNumber,primaryType,businessStatus,location';

interface RawPlaceDetails {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  internationalPhoneNumber?: string;
  primaryType?: string;
  businessStatus?: string;
  location?: { latitude?: number; longitude?: number };
}

/**
 * The paid step — this is the call that actually costs money per lead
 * (Enterprise-tier pricing, since it asks for phone/website), unlike
 * searchPlaces above, which only asks for Essentials-tier fields.
 * ProspectingCampaign.leadsFoundThisMonth counts THESE calls, not
 * search calls — see the schema comment on that column.
 */
export async function getPlaceDetails(placeId: string): Promise<GooglePlacesResult<PlaceDetails>> {
  const result = await callPlacesApi<RawPlaceDetails>(
    `/places/${encodeURIComponent(placeId)}`,
    'GET',
    DETAILS_FIELD_MASK,
  );
  if (!result.ok) return result;

  const d = result.data;
  if (!d.id) {
    return { ok: false, error: 'place_details_missing_id' };
  }
  return {
    ok: true,
    data: {
      id: d.id,
      name: d.displayName?.text ?? d.id,
      formattedAddress: d.formattedAddress ?? null,
      websiteUri: d.websiteUri ?? null,
      phoneNumber: d.internationalPhoneNumber ?? null,
      primaryType: d.primaryType ?? null,
      businessStatus: d.businessStatus ?? null,
      latitude: typeof d.location?.latitude === 'number' ? d.location.latitude : null,
      longitude: typeof d.location?.longitude === 'number' ? d.location.longitude : null,
    },
  };
}
