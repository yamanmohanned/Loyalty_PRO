import { describe, expect, it } from 'vitest';
import {
  SETTING_DEFINITIONS,
  SETTINGS_BY_KEY,
  SETTING_DEFAULTS,
  effectiveValues,
  resolveSettings,
  schemaForSetting,
  validateSettingValues,
} from '../settings';

/**
 * The settings engine is the acceptance gate PRD §4 sets for every later requirement,
 * so what is asserted here is mostly the engine's promises rather than any one value:
 * that bounds cannot be bypassed, that a layer cannot claim a setting it was not given,
 * and that resolution is total.
 */

describe('FND-04: the registry itself', () => {
  it('has a unique, dotted key for every setting', () => {
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  /**
   * §4's acceptance test, enforced rather than remembered: «القيمة الافتراضية،
   * والحدان الأدنى والأعلى، ومن يملك صلاحية تعديله». A setting added without one of
   * those fails here, at the moment it is added, rather than reaching a screen that
   * cannot render it.
   */
  it('declares a default, a scope and an editor for every setting', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.default, definition.key).toBeDefined();
      expect(definition.scopes.length, definition.key).toBeGreaterThan(0);
      expect(definition.editableBy.length, definition.key).toBeGreaterThan(0);
      expect(definition.labelAr.length, definition.key).toBeGreaterThan(0);
      expect(definition.helpAr.length, definition.key).toBeGreaterThan(0);
    }
  });

  it('gives every numeric setting a usable range that contains its own default', () => {
    for (const definition of SETTING_DEFINITIONS) {
      if (definition.kind !== 'int') continue;
      expect(definition.min, definition.key).toBeLessThan(definition.max);
      expect(definition.default, definition.key).toBeGreaterThanOrEqual(definition.min);
      expect(definition.default, definition.key).toBeLessThanOrEqual(definition.max);
    }
  });

  it('gives every default a value its own schema accepts', () => {
    for (const definition of SETTING_DEFINITIONS) {
      const parsed = schemaForSetting(definition).safeParse(definition.default);
      expect(parsed.success, `${definition.key} — its own default is invalid`).toBe(true);
    }
  });

  /**
   * §3: «كل التعقيد للمدير وحده». An operator never reaches a settings screen, so a
   * setting that named STATION as an editor would be a contradiction the registry can
   * hold but the product cannot.
   */
  it('never lets the station operator edit a setting', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.editableBy as readonly string[], definition.key).not.toContain('STATION');
    }
  });
});

describe('FND-04: validation', () => {
  it('accepts a value inside the bounds', () => {
    const { accepted, rejected } = validateSettingValues('MERCHANT', {
      'security.login_attempts': 7,
    });
    expect(rejected).toEqual([]);
    expect(accepted['security.login_attempts']).toBe(7);
  });

  /**
   * The bound is the point. A screen that caps a field and an API that does not is the
   * shape §4's «حواجز أمان» exists to prevent, and the only way to be sure they agree
   * is for both to read this one declaration.
   */
  it('refuses a value outside the bounds, and says what the bounds are', () => {
    const definition = SETTINGS_BY_KEY['security.login_attempts'];
    const { accepted, rejected } = validateSettingValues('MERCHANT', {
      'security.login_attempts': 999,
    });
    expect(accepted).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.key).toBe('security.login_attempts');
    if (definition?.kind === 'int') {
      expect(rejected[0]?.messageAr).toContain(String(definition.max));
    }
  });

  it('refuses an unknown key rather than storing it', () => {
    const { accepted, rejected } = validateSettingValues('MERCHANT', { 'nope.not_a_setting': 1 });
    expect(accepted).toEqual({});
    expect(rejected[0]?.messageAr).toBe('إعداد غير معروف');
  });

  it('refuses a merchant-only setting written at station level', () => {
    const { accepted, rejected } = validateSettingValues('STATION', {
      'security.login_attempts': 6,
    });
    expect(accepted).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.messageAr).toContain('المتجر');
  });

  /**
   * A settings screen submits a group. Reporting one failure at a time turns fixing
   * three fields into three round trips, each of which loses the other two.
   */
  it('reports every rejection at once, and keeps the good values', () => {
    const { accepted, rejected } = validateSettingValues('MERCHANT', {
      'security.login_attempts': 999,
      'security.lockout_minutes': 0,
      'backup.daily_time': '03:30',
    });
    expect(rejected.map((r) => r.key).sort()).toEqual([
      'security.lockout_minutes',
      'security.login_attempts',
    ]);
    expect(accepted).toEqual({ 'backup.daily_time': '03:30' });
  });

  it('refuses a time that is not HH:MM', () => {
    for (const bad of ['3:00', '25:00', '03:60', 'الثالثة', '0300']) {
      const { rejected } = validateSettingValues('MERCHANT', { 'backup.daily_time': bad });
      expect(rejected, bad).toHaveLength(1);
    }
    expect(validateSettingValues('MERCHANT', { 'backup.daily_time': '23:59' }).rejected).toEqual([]);
  });

  it('refuses a value outside an enum', () => {
    const { rejected } = validateSettingValues('MERCHANT', { 'locale.timezone': 'Mars/Olympus' });
    expect(rejected).toHaveLength(1);
  });
});

describe('FND-04: resolution', () => {
  it('returns a value for every setting when nothing is stored', () => {
    const resolved = resolveSettings({});
    expect(Object.keys(resolved).sort()).toEqual([...Object.keys(SETTING_DEFAULTS)].sort());
    for (const [key, r] of Object.entries(resolved)) {
      expect(r.origin, key).toBe('SYSTEM');
      expect(r.value, key).toEqual(SETTING_DEFAULTS[key]);
    }
  });

  it('lets the merchant layer override the default, and says so', () => {
    const resolved = resolveSettings({ MERCHANT: { 'station.receipt_fade_ms': 1200 } });
    expect(resolved['station.receipt_fade_ms']).toEqual({ value: 1200, origin: 'MERCHANT' });
    // Untouched settings keep their default rather than disappearing.
    expect(resolved['station.card_display_ms']?.origin).toBe('SYSTEM');
  });

  it('lets the station override the merchant, because the narrower layer wins', () => {
    const resolved = resolveSettings({
      MERCHANT: { 'station.receipt_fade_ms': 1200 },
      STATION: { 'station.receipt_fade_ms': 300 },
    });
    expect(resolved['station.receipt_fade_ms']).toEqual({ value: 300, origin: 'STATION' });
  });

  /**
   * The row exists and is ignored. This is the case the scope list is FOR: a station
   * that could widen its own permissions by writing a row would make every
   * merchant-level rule advisory.
   */
  it('ignores a station row for a setting the station may not set', () => {
    const resolved = resolveSettings({
      MERCHANT: { 'security.login_attempts': 8 },
      STATION: { 'security.login_attempts': 99 },
    });
    expect(resolved['security.login_attempts']).toEqual({ value: 8, origin: 'MERCHANT' });
  });

  /**
   * A database can hold a value that was valid under an older registry, or one written
   * by hand. Obeying it would mean the bounds hold only for values that arrived
   * through the API — which is to say, not at all.
   */
  it('ignores a stored value that is out of bounds and falls back to the layer beneath', () => {
    const resolved = resolveSettings({ MERCHANT: { 'security.lockout_minutes': 10_000 } });
    expect(resolved['security.lockout_minutes']).toEqual({
      value: SETTING_DEFAULTS['security.lockout_minutes'],
      origin: 'SYSTEM',
    });
  });

  it('ignores a key that is no longer in the registry', () => {
    const resolved = resolveSettings({ MERCHANT: { 'removed.old_setting': 1 } });
    expect(resolved['removed.old_setting']).toBeUndefined();
  });

  it('flattens to plain values for callers that do not care about the origin', () => {
    const resolved = resolveSettings({ MERCHANT: { 'locale.day_start_hour': 4 } });
    expect(effectiveValues(resolved)['locale.day_start_hour']).toBe(4);
  });
});
