// =============================================================================
// Prospección con IA, Fase A — unit tests for src/lib/google-places.ts.
//
// Mocked-fetch coverage for the request/response contract this code was
// built against (sourced from Google's current published docs — see the
// file's own header). Explicitly NOT a live-API test — there is no real
// GOOGLE_PLACES_API_KEY reachable from any environment this session had
// access to.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isGooglePlacesConfigured, searchPlaces, getPlaceDetails } from '@/lib/google-places';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  process.env.GOOGLE_PLACES_API_KEY = 'test_key_123';
});

afterEach(() => {
  delete process.env.GOOGLE_PLACES_API_KEY;
});

describe('isGooglePlacesConfigured', () => {
  it('true when GOOGLE_PLACES_API_KEY is set', () => {
    expect(isGooglePlacesConfigured()).toBe(true);
  });

  it('false when unset', () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(isGooglePlacesConfigured()).toBe(false);
  });
});

describe('searchPlaces', () => {
  it('POSTs to /places:searchText with the API key and field mask as headers, not query params', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ places: [] }));
    await searchPlaces({ textQuery: 'peluquerías en Las Palmas' });

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Goog-Api-Key']).toBe('test_key_123');
    expect(init.headers['X-Goog-FieldMask']).toContain('places.id');
    expect(JSON.parse(init.body)).toEqual({ textQuery: 'peluquerías en Las Palmas', pageSize: 20 });
  });

  it('includes locationBias as a circle, clamping radius to the 50000m Google ceiling', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ places: [] }));
    await searchPlaces({
      textQuery: 'restaurantes',
      locationBias: { latitude: 28.1, longitude: -15.4, radiusMeters: 999999 },
    });

    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.locationBias).toEqual({
      circle: { center: { latitude: 28.1, longitude: -15.4 }, radius: 50000 },
    });
  });

  it('forwards pageToken when given', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ places: [] }));
    await searchPlaces({ textQuery: 'x', pageToken: 'token_abc' });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.pageToken).toBe('token_abc');
  });

  it('maps places into the parsed shape and carries nextPageToken through', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        places: [
          {
            id: 'place_1',
            displayName: { text: 'Ferretería Central' },
            formattedAddress: 'Calle Mayor 1, Las Palmas',
            websiteUri: 'https://ferreteriacentral.example',
            types: ['hardware_store', 'store'],
          },
        ],
        nextPageToken: 'next_page_abc',
      }),
    );
    const result = await searchPlaces({ textQuery: 'ferreterías' });
    expect(result).toEqual({
      ok: true,
      data: {
        results: [
          {
            id: 'place_1',
            name: 'Ferretería Central',
            formattedAddress: 'Calle Mayor 1, Las Palmas',
            websiteUri: 'https://ferreteriacentral.example',
            types: ['hardware_store', 'store'],
          },
        ],
        nextPageToken: 'next_page_abc',
      },
    });
  });

  it('drops a result with no id — it cannot be deduplicated against Lead.externalPlaceId', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ places: [{ displayName: { text: 'Sin id' } }, { id: 'place_2', displayName: { text: 'Con id' } }] }),
    );
    const result = await searchPlaces({ textQuery: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.results).toHaveLength(1);
      expect(result.data.results[0].id).toBe('place_2');
    }
  });

  it('returns ok:false with GOOGLE_PLACES_API_KEY not configured when the key is unset — never calls fetch', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const result = await searchPlaces({ textQuery: 'x' });
    expect(result).toEqual({ ok: false, error: 'GOOGLE_PLACES_API_KEY not configured' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns the Google error message on a non-ok response', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'API key not valid' } }, false, 400),
    );
    const result = await searchPlaces({ textQuery: 'x' });
    expect(result).toEqual({ ok: false, error: 'API key not valid', status: 400 });
  });

  it('returns an error result and logs on a network failure, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await searchPlaces({ textQuery: 'x' });
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('getPlaceDetails', () => {
  it('GETs /places/{id} with the field mask requesting phone/website/status', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'place_1',
        displayName: { text: 'Ferretería Central' },
        formattedAddress: 'Calle Mayor 1, Las Palmas',
        websiteUri: 'https://ferreteriacentral.example',
        internationalPhoneNumber: '+34922334455',
        primaryType: 'hardware_store',
        businessStatus: 'OPERATIONAL',
      }),
    );
    const result = await getPlaceDetails('place_1');

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places/place_1');
    expect(init.method).toBe('GET');
    expect(init.headers['X-Goog-FieldMask']).toContain('internationalPhoneNumber');
    expect(init.headers['X-Goog-FieldMask']).toContain('businessStatus');
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'place_1',
        name: 'Ferretería Central',
        formattedAddress: 'Calle Mayor 1, Las Palmas',
        websiteUri: 'https://ferreteriacentral.example',
        phoneNumber: '+34922334455',
        primaryType: 'hardware_store',
        businessStatus: 'OPERATIONAL',
      },
    });
  });

  it('URL-encodes the place id', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 'weird id/with slash' }));
    await getPlaceDetails('weird id/with slash');
    const url = mockState.fetch.mock.calls[0][0];
    expect(url).toContain(encodeURIComponent('weird id/with slash'));
  });

  it('returns place_details_missing_id when Google responds without an id', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ displayName: { text: 'x' } }));
    const result = await getPlaceDetails('place_1');
    expect(result).toEqual({ ok: false, error: 'place_details_missing_id' });
  });

  it('returns null for missing optional fields rather than throwing', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 'place_1' }));
    const result = await getPlaceDetails('place_1');
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'place_1',
        name: 'place_1',
        formattedAddress: null,
        websiteUri: null,
        phoneNumber: null,
        primaryType: null,
        businessStatus: null,
      },
    });
  });
});
