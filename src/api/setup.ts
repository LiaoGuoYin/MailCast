import { Hono } from 'hono';
import { getEmailDeliveryConfig } from '../settings';
import type { EmailProvider, Env } from '../types';
import { mailDomainFromAddress } from './settings';

// One round trip: the onboarding card is fetched on every inbox visit until
// setup is complete, so it should cost a single D1 query.
const SETUP_COUNTS_SQL = `
  SELECT
    (SELECT to_addr FROM emails ORDER BY id DESC LIMIT 1) AS latest_to_addr,
    (SELECT COUNT(*) FROM forward_rules WHERE enabled = 1) AS forward_rules,
    (SELECT COUNT(*) FROM tg_rules WHERE enabled = 1) AS telegram_rules,
    (SELECT COUNT(*) FROM bark_rules WHERE enabled = 1) AS bark_rules
`;

interface SetupCounts {
  latest_to_addr: string | null;
  forward_rules: number;
  telegram_rules: number;
  bark_rules: number;
}

export interface SetupStatus {
  receiving: { done: boolean; domain: string };
  rules: { done: boolean; count: number };
  // Sending only matters once a rule forwards to a mailbox; Telegram and Bark
  // work without it, so it is never a blocker for those users.
  sending: { done: boolean; required: boolean; provider: EmailProvider };
  complete: boolean;
}

export function deriveSetupStatus(
  counts: SetupCounts,
  sending: { provider: EmailProvider; configured: boolean },
): SetupStatus {
  const domain = mailDomainFromAddress(counts.latest_to_addr ?? '');
  const ruleCount = counts.forward_rules + counts.telegram_rules + counts.bark_rules;
  const receiving = { done: Boolean(counts.latest_to_addr), domain };
  const rules = { done: ruleCount > 0, count: ruleCount };
  const sendingStatus = {
    done: sending.configured,
    required: counts.forward_rules > 0,
    provider: sending.provider,
  };
  return {
    receiving,
    rules,
    sending: sendingStatus,
    complete: receiving.done && rules.done && (!sendingStatus.required || sendingStatus.done),
  };
}

export const setupRoutes = new Hono<{ Bindings: Env }>();

setupRoutes.get('/', async (c) => {
  const [counts, delivery] = await Promise.all([
    c.env.DB.prepare(SETUP_COUNTS_SQL).first<SetupCounts>(),
    getEmailDeliveryConfig(c.env.DB),
  ]);
  const configured = delivery.provider === 'resend'
    ? Boolean(delivery.resend_api_key)
    : Boolean(c.env.EMAIL);
  return c.json(deriveSetupStatus(
    counts ?? { latest_to_addr: null, forward_rules: 0, telegram_rules: 0, bark_rules: 0 },
    { provider: delivery.provider, configured },
  ));
});
