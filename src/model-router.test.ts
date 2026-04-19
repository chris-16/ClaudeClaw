import { describe, it, expect } from 'vitest';

vi.mock('./config.js', () => ({ CONTEXT_LIMIT: 1_000_000 }));
vi.mock('./logger.js', () => ({ logger: { info: () => {}, warn: () => {}, debug: () => {} } }));

import { vi } from 'vitest';
import {
  applyBudgetOverride,
  applyContextOverride,
  getContextLimitForModel,
  routeMessage,
} from './model-router.js';

describe('getContextLimitForModel', () => {
  it('returns the hardcoded window for known models', () => {
    expect(getContextLimitForModel('claude-haiku-4-5')).toBe(200_000);
    expect(getContextLimitForModel('claude-sonnet-4-5')).toBe(200_000);
    expect(getContextLimitForModel('claude-opus-4-6')).toBe(1_000_000);
  });

  it('falls back to CONTEXT_LIMIT for unknown models', () => {
    expect(getContextLimitForModel('claude-made-up-model')).toBe(1_000_000);
    expect(getContextLimitForModel(undefined)).toBe(1_000_000);
  });
});

describe('applyContextOverride', () => {
  it('upgrades to Opus when session + headroom exceeds the routed model window', () => {
    const base = routeMessage('hola'); // short → likely haiku (200k limit)
    // 185k + 20k headroom = 205k > 200k haiku limit → upgrade
    const upgraded = applyContextOverride(base, 185_000);
    expect(upgraded.tier).toBe('opus');
    expect(upgraded.reason).toContain('context override');
  });

  it('leaves the decision untouched when session fits', () => {
    const base = routeMessage('hola');
    const same = applyContextOverride(base, 50_000);
    expect(same.tier).toBe(base.tier);
    expect(same.modelId).toBe(base.modelId);
  });

  it('does not downgrade Opus decisions', () => {
    const base = routeMessage('refactor this codebase');
    expect(base.tier).toBe('opus');
    const stillOpus = applyContextOverride(base, 180_000);
    expect(stillOpus.tier).toBe('opus');
  });
});

describe('applyBudgetOverride combined with applyContextOverride', () => {
  it('context override overrides a budget-forced Haiku when session is too big', () => {
    const base = routeMessage('refactor everything');
    const budgetHaiku = applyBudgetOverride(base, 97);
    expect(budgetHaiku.tier).toBe('haiku');
    const contextRestored = applyContextOverride(budgetHaiku, 250_000);
    expect(contextRestored.tier).toBe('opus');
  });
});
