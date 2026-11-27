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

// Set once the customer hides the onboarding card; it never reappears on this
// browser even if setup later regresses (e.g. all rules deleted).
export const SETUP_GUIDE_DISMISSED_KEY = 'mailcast_setup_guide_dismissed';

// Table or graph on the routing tab; phones always get the table regardless.
export const ROUTES_VIEW_KEY = 'mailcast_routes_view';

// Optional strict privacy mode for HTML emails; off by default so images & styles load cleanly.
export const BLOCK_REMOTE_CONTENT_KEY = 'mailcast_block_remote_content';
