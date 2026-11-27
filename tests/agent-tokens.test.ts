import { describe, expect, it } from 'vitest';
import {
  buildReadPrefixSqlFilter,
  buildSentPrefixSqlFilter,
  canReadPrefix,
  canSendFromPrefix,
  canSendToRecipient,
  type AgentPrincipal,
} from '../src/auth/principal';
import {
  agentTokenHint,
  generateAgentToken,
  hashAgentToken,
  isAgentTokenFormat,
  parseCreateAgentTokenInput,
  validateAllowlistEntry,
} from '../src/auth/agent-token';
import { extractCodeCandidates, extractLinks } from '../src/services/mail-query';

const scopedAgent: AgentPrincipal = {
  kind: 'agent',
  tokenId: 1,
  name: 'CI Agent',
  scopes: ['mail:read', 'mail:send'],
  prefixes: ['ci', 'agent'],
  allowPlusTags: true,
  recipientPolicy: 'allowlist',
  recipientAllowlist: ['alice@example.com', '@trusted.org'],
  sendLimitHour: 10,
  sendLimitDay: 30,
};

describe('agent principal prefix & recipient scoping', () => {
  it('allows reading +tag subaddresses when enabled, but only exact prefixes for sending', () => {
    expect(canReadPrefix(scopedAgent, 'ci')).toBe(true);
    expect(canReadPrefix(scopedAgent, 'ci+github')).toBe(true);
    expect(canReadPrefix(scopedAgent, 'CI+OpenAI')).toBe(true);
    expect(canReadPrefix(scopedAgent, 'ci2')).toBe(false);
    expect(canReadPrefix(scopedAgent, 'personal')).toBe(false);

    expect(canSendFromPrefix(scopedAgent, 'ci')).toBe(true);
    expect(canSendFromPrefix(scopedAgent, 'ci+github')).toBe(false);
    expect(canSendFromPrefix(scopedAgent, '*')).toBe(false);
  });

  it('disables +tag matching when allowPlusTags is false', () => {
    const strictAgent: AgentPrincipal = { ...scopedAgent, allowPlusTags: false };
    expect(canReadPrefix(strictAgent, 'ci')).toBe(true);
    expect(canReadPrefix(strictAgent, 'ci+github')).toBe(false);
  });

  it('builds index-friendly binary range SQL filters without LIKE', () => {
    const allFilter = buildReadPrefixSqlFilter(scopedAgent);
    expect(allFilter.allowed).toBe(true);
    expect(allFilter.sql).not.toMatch(/LIKE/i);
    expect(allFilter.sql).toBe(
      '((to_prefix = ? OR (to_prefix >= ? AND to_prefix < ?)) OR (to_prefix = ? OR (to_prefix >= ? AND to_prefix < ?)))',
    );
    expect(allFilter.params).toEqual(['ci', 'ci+', 'ci,', 'agent', 'agent+', 'agent,']);

    const specificTag = buildReadPrefixSqlFilter(scopedAgent, 'ci+github');
    expect(specificTag).toEqual({
      allowed: true,
      sql: 'to_prefix = ?',
      params: ['ci+github'],
    });

    const forbidden = buildReadPrefixSqlFilter(scopedAgent, 'secret');
    expect(forbidden.allowed).toBe(false);

    const sentFilter = buildSentPrefixSqlFilter(scopedAgent);
    expect(sentFilter).toEqual({
      allowed: true,
      sql: 'from_prefix IN (?, ?)',
      params: ['ci', 'agent'],
    });
  });

  it('enforces exact and @domain recipient allowlist rules', () => {
    expect(canSendToRecipient(scopedAgent, 'Alice@Example.com')).toBe(true);
    expect(canSendToRecipient(scopedAgent, 'bob@trusted.org')).toBe(true);
    expect(canSendToRecipient(scopedAgent, 'bob@evil-trusted.org')).toBe(false);
    expect(canSendToRecipient(scopedAgent, 'attacker@evil.com')).toBe(false);

    const openAgent: AgentPrincipal = { ...scopedAgent, recipientPolicy: 'any', recipientAllowlist: [] };
    expect(canSendToRecipient(openAgent, 'anyone@anywhere.net')).toBe(true);
  });
});

describe('agent token generation and validation', () => {
  it('generates mc_ tokens with valid format, hint, and deterministic SHA-256 hash', async () => {
    const token = generateAgentToken();
    expect(isAgentTokenFormat(token)).toBe(true);
    expect(agentTokenHint(token)).toBe(`mc_…${token.slice(-4)}`);
    const h1 = await hashAgentToken(token);
    const h2 = await hashAgentToken(token);
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(30);
    expect(isAgentTokenFormat('not-a-token')).toBe(false);
  });

  it('validates create token input and requires allowlist entries for allowlist send tokens', () => {
    const missingAllowlist = parseCreateAgentTokenInput({
      name: 'Sender',
      scopes: ['mail:read', 'mail:send'],
      prefixes: ['agent'],
      recipient_policy: 'allowlist',
      recipient_allowlist: [],
    });
    expect(missingAllowlist.ok).toBe(false);

    const valid = parseCreateAgentTokenInput({
      name: 'Codex Helper',
      scopes: ['mail:read', 'mail:send'],
      prefixes: ['Agent', 'CI'],
      allow_plus_tags: true,
      recipient_policy: 'allowlist',
      recipient_allowlist: ['Alice@Example.com', '@Trusted.org'],
      send_limit_hour: 5,
      send_limit_day: 20,
      expires_in_days: 90,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.prefixes).toEqual(['agent', 'ci']);
      expect(valid.data.recipientAllowlist).toEqual(['alice@example.com', '@trusted.org']);
      expect(valid.data.sendLimitHour).toBe(5);
      expect(valid.data.sendLimitDay).toBe(20);
    }

    expect(validateAllowlistEntry('@example.com').error).toBeNull();
    expect(validateAllowlistEntry('@bad').error).not.toBeNull();
  });
});

describe('deterministic email extractors', () => {
  it('extracts verification code candidates and clean non-asset links', () => {
    const codes = extractCodeCandidates(
      'Your verification code is 482910',
      'Use OTP: AB92-77 or enter 482910 within 10 minutes.',
    );
    expect(codes).toContain('482910');
    expect(codes).toContain('AB92-77');

    const links = extractLinks(
      'Verify here: https://app.example.com/verify?token=abc. Ignore https://cdn.example.com/logo.png',
      '<a href="https://docs.example.com/guide">Guide</a><img src="https://cdn.example.com/a.jpg">',
    );
    expect(links).toEqual([
      { url: 'https://app.example.com/verify?token=abc', host: 'app.example.com' },
      { url: 'https://docs.example.com/guide', host: 'docs.example.com' },
    ]);
  });
});
