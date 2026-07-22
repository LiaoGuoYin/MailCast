import { beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyStorage, THEME_KEY, TOKEN_KEY } from '../public/storage.js';

describe('MailCast local storage migration', () => {
  beforeEach(() => localStorage.clear());

  it('moves legacy session and theme values to the MailCast keys', () => {
    localStorage.setItem('cf_email_router_token', 'legacy-session');
    localStorage.setItem('cf_email_router_theme', 'dark');

    migrateLegacyStorage();

    expect(localStorage.getItem(TOKEN_KEY)).toBe('legacy-session');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(localStorage.getItem('cf_email_router_token')).toBeNull();
    expect(localStorage.getItem('cf_email_router_theme')).toBeNull();
  });

  it('keeps current values when legacy values also exist', () => {
    localStorage.setItem(TOKEN_KEY, 'current-session');
    localStorage.setItem(THEME_KEY, 'light');
    localStorage.setItem('cf_email_router_token', 'legacy-session');
    localStorage.setItem('cf_email_router_theme', 'dark');

    migrateLegacyStorage();

    expect(localStorage.getItem(TOKEN_KEY)).toBe('current-session');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(localStorage.getItem('cf_email_router_token')).toBeNull();
    expect(localStorage.getItem('cf_email_router_theme')).toBeNull();
  });
});
