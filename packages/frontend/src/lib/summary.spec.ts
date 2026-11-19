import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX_LENGTH, summaryForIssue, summaryForPlan, validateSummary } from './summary';

describe('summaryForPlan', () => {
  it('uses the stored summary', () => {
    expect(
      summaryForPlan({ summary: 'Save bookmarks.', contentMarkdown: '# Plan\n\nLong body.' }),
    ).toBe('Save bookmarks.');
  });

  it('derives a fallback for a plan from before summaries', () => {
    expect(
      summaryForPlan({
        summary: null,
        contentMarkdown: '## Problem Statement\n\nLinks go missing.',
      }),
    ).toBe('Links go missing.');
  });

  it('has a placeholder when even the Markdown is empty', () => {
    expect(summaryForPlan({ summary: null, contentMarkdown: '   ' })).toBe('No summary yet.');
  });
});

describe('summaryForIssue', () => {
  it('uses the stored summary', () => {
    expect(summaryForIssue({ summary: 'Save a link.', title: 'Save', body: 'Long body.' })).toBe(
      'Save a link.',
    );
  });

  it('derives a fallback from the body, then the title', () => {
    expect(
      summaryForIssue({ summary: null, title: 'Save a link', body: 'Store it for later.' }),
    ).toBe('Store it for later.');
    expect(summaryForIssue({ summary: null, title: 'Save a link', body: '' })).toBe('Save a link');
  });
});

describe('validateSummary', () => {
  it('accepts a plain summary and normalises it', () => {
    expect(validateSummary('  Save   a link. ')).toEqual({ value: 'Save a link.' });
  });

  it('rejects an empty summary', () => {
    const result = validateSummary('   ');
    expect('error' in result).toBe(true);
  });

  it('rejects a summary over the limit', () => {
    const result = validateSummary('x'.repeat(SUMMARY_MAX_LENGTH + 1));
    expect('error' in result && result.error).toContain(String(SUMMARY_MAX_LENGTH));
  });
});
