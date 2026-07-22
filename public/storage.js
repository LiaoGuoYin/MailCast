export const TOKEN_KEY = 'mailcast_token';
export const THEME_KEY = 'mailcast_theme';

const LEGACY_STORAGE_KEYS = {
  [TOKEN_KEY]: 'cf_email_router_token',
  [THEME_KEY]: 'cf_email_router_theme',
};

export function migrateLegacyStorage(storage = localStorage) {
  for (const [currentKey, legacyKey] of Object.entries(LEGACY_STORAGE_KEYS)) {
    const legacyValue = storage.getItem(legacyKey);
    if (storage.getItem(currentKey) === null && legacyValue !== null) {
      storage.setItem(currentKey, legacyValue);
    }
    storage.removeItem(legacyKey);
  }
}
