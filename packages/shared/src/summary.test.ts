import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX_LENGTH, deriveSummary, normaliseSummary } from './summary';

describe('normaliseSummary', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseSummary('  Save   a bookmark\n\n in one step  ')).toEqual({
      ok: true,
      value: 'Save a bookmark in one step',
    });
  });

  it('rejects a value that is not a string', () => {
    expect(normaliseSummary(undefined).ok).toBe(false);
    expect(normaliseSummary(null).ok).toBe(false);
    expect(normaliseSummary(42).ok).toBe(false);
  });

  it('rejects an empty value', () => {
    const result = normaliseSummary('   \n  ');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('summary');
  });

  it('accepts a summary of exactly the maximum length', () => {
    const value = 'a'.repeat(SUMMARY_MAX_LENGTH);

    expect(normaliseSummary(value)).toEqual({ ok: true, value });
  });

  it('rejects a summary over the maximum length', () => {
    const result = normaliseSummary('a'.repeat(SUMMARY_MAX_LENGTH + 1));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(SUMMARY_MAX_LENGTH));
  });
});

describe('deriveSummary', () => {
  it('uses the first paragraph of Markdown, skipping a leading heading', () => {
    expect(deriveSummary('# Personal Bookmarks\n\nSave links and find them again.')).toBe(
      'Save links and find them again.',
    );
  });

  it('skips leading blank lines and empty blocks', () => {
    expect(deriveSummary('\n\n   \n\nA first sentence.\n\nA second paragraph.')).toBe(
      'A first sentence.',
    );
  });

  it('strips common Markdown markers and joins the paragraph', () => {
    expect(
      deriveSummary('## Context\n\n- Create **the** tables\n- Add [indexes](https://example.com)'),
    ).toBe('Create the tables Add indexes');
  });

  it('collapses whitespace across the paragraph', () => {
    expect(deriveSummary('Word one\nword two   word three')).toBe('Word one word two word three');
  });

  it('truncates a long paragraph to the maximum length', () => {
    const summary = deriveSummary(`${'word '.repeat(60)}end`);

    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('falls back to a heading when the Markdown has no body text', () => {
    expect(deriveSummary('## Problem Statement')).toBe('Problem Statement');
  });

  it('returns an empty string when there is no text', () => {
    expect(deriveSummary('')).toBe('');
    expect(deriveSummary('   \n\n  ')).toBe('');
  });
});
