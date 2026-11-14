/**
 * Recall's fulltext candidate arm ranks every row matching the OR of its
 * words, so its words are cut to an estimated match budget first.
 */

import { describe, expect, it } from 'vitest';
import { type QueryWordFrequency, selectCandidateWords, tsqueryTokens } from '../fts';

const TOTAL_ROWS = 1_000_000;
const FLOOR = 0.0025;

function word(token: string, frequency: number | null, lexemes = [token]): QueryWordFrequency {
  return { token, lexemes, frequency, floor_frequency: FLOOR, total_rows: TOTAL_ROWS };
}

describe('selectCandidateWords', () => {
  it('keeps every word when the column has no statistics', () => {
    const tokens = ['alpha', 'beta'];
    expect(selectCandidateWords(tokens, [])).toEqual(tokens);
    expect(
      selectCandidateWords(tokens, [{ ...word('alpha', 0.5), floor_frequency: null }])
    ).toEqual(tokens);
    expect(selectCandidateWords(tokens, [{ ...word('alpha', 0.5), total_rows: -1 }])).toEqual(
      tokens
    );
  });

  it('drops a word whose matches alone exceed the budget', () => {
    // 'lobu' in 7.7% of a 1M-row table is 77k matches against a 50k budget.
    const frequencies = [word('lobu', 0.077), word('proxy', null)];
    expect(selectCandidateWords(['lobu', 'proxy'], frequencies, 50_000)).toEqual(['proxy']);
  });

  it('keeps the rarest words first until the budget is spent', () => {
    // Estimates: common 40k, middling 20k, unlisted words 1.25k each.
    const frequencies = [
      word('common', 0.04),
      word('middling', 0.02),
      word('inference', null),
      word('proxy', null),
    ];
    const tokens = frequencies.map((w) => w.token);
    expect(selectCandidateWords(tokens, frequencies, 25_000)).toEqual([
      'middling',
      'inference',
      'proxy',
    ]);
    expect(selectCandidateWords(tokens, frequencies, 2_000)).toEqual(['inference']);
  });

  it('returns no words when even the rarest exceeds the budget', () => {
    expect(selectCandidateWords(['lobu'], [word('lobu', 0.077)], 10_000)).toEqual([]);
  });

  it('estimates an unlisted word at half the smallest listed share', () => {
    // FLOOR / 2 * TOTAL_ROWS = 1,250 rows each.
    const frequencies = [word('rare', null), word('other', null)];
    expect(selectCandidateWords(['rare', 'other'], frequencies, 1_250)).toEqual(['rare']);
    expect(selectCandidateWords(['rare', 'other'], frequencies, 2_500)).toEqual([
      'rare',
      'other',
    ]);
  });

  it('skips words the parser drops and words that stem like an earlier one', () => {
    const frequencies = [
      word('running', null, ['run']),
      word('runs', null, ['run']),
      word('the', null, []),
      word('proxy', null),
    ];
    // Only two distinct lexemes count against the budget.
    expect(
      selectCandidateWords(['running', 'runs', 'the', 'proxy'], frequencies, 2_500)
    ).toEqual(['running', 'proxy']);
  });
});

describe('tsqueryTokens', () => {
  it('keeps only lowercase alphanumerics and drops stopwords', () => {
    expect(tsqueryTokens("What's the Lobu PR4918 rollout?\nnew-line")).toEqual([
      's',
      'lobu',
      'pr4918',
      'rollout',
      'new',
      'line',
    ]);
    expect(tsqueryTokens('the of a')).toEqual([]);
  });
});
