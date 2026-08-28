// =============================================================================
// SEO con IA — unit tests for src/lib/seo-settings.ts.
//
// Covers: the DB row → env var → hardcoded default resolution chain for
// getContentGenerationMinIntervalDays, and that
// updateContentGenerationMinIntervalDays always upserts the same
// singleton row (create OR update, never a second row).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  seoSettingsFindUnique: vi.fn(),
  seoSettingsUpsert: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    seoSettings: {
      findUnique: (...args: unknown[]) => mockState.seoSettingsFindUnique(...args),
      upsert: (...args: unknown[]) => mockState.seoSettingsUpsert(...args),
    },
  },
}));

import {
  getContentGenerationMinIntervalDays,
  updateContentGenerationMinIntervalDays,
  SEO_SETTINGS_SINGLETON_ID,
  DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS,
} from '@/lib/seo-settings';

beforeEach(() => {
  mockState.seoSettingsFindUnique.mockReset().mockResolvedValue(null);
  mockState.seoSettingsUpsert.mockReset().mockResolvedValue({});
  delete process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS;
});

afterEach(() => {
  delete process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS;
});

describe('getContentGenerationMinIntervalDays', () => {
  it('returns the DB row value when a settings row exists', async () => {
    mockState.seoSettingsFindUnique.mockResolvedValueOnce({ contentGenerationMinIntervalDays: 5 });
    process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS = '20';
    const result = await getContentGenerationMinIntervalDays();
    expect(result).toBe(5);
    expect(mockState.seoSettingsFindUnique).toHaveBeenCalledWith({ where: { id: SEO_SETTINGS_SINGLETON_ID } });
  });

  it('falls back to the env var when no settings row exists', async () => {
    process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS = '14';
    const result = await getContentGenerationMinIntervalDays();
    expect(result).toBe(14);
  });

  it('falls back to the hardcoded default when neither a row nor a valid env var exists', async () => {
    const result = await getContentGenerationMinIntervalDays();
    expect(result).toBe(DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS);
  });

  it('ignores a non-numeric or non-positive env var and falls back to the default', async () => {
    process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS = 'not-a-number';
    expect(await getContentGenerationMinIntervalDays()).toBe(DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS);

    process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS = '-5';
    expect(await getContentGenerationMinIntervalDays()).toBe(DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS);
  });
});

describe('updateContentGenerationMinIntervalDays', () => {
  it('upserts the singleton row with the new value and actor', async () => {
    await updateContentGenerationMinIntervalDays(7, 'op@kairikos.com');
    expect(mockState.seoSettingsUpsert).toHaveBeenCalledWith({
      where: { id: SEO_SETTINGS_SINGLETON_ID },
      create: { id: SEO_SETTINGS_SINGLETON_ID, contentGenerationMinIntervalDays: 7, updatedBy: 'op@kairikos.com' },
      update: { contentGenerationMinIntervalDays: 7, updatedBy: 'op@kairikos.com' },
    });
  });

  it('accepts a null actor (e.g. the legacy operator-key auth path)', async () => {
    await updateContentGenerationMinIntervalDays(3, null);
    expect(mockState.seoSettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ updatedBy: null }) }),
    );
  });
});
