import { describe, it, expect } from 'vitest';
import { SOURCE_KEYS } from '@harpe/core';
import { SOURCE_LABELS, SOURCE_ORDER } from './source-meta.js';

// Guards the "one place to add a source" promise: every backend source key in
// the @harpe/core registry must have a UI label and a chip-order entry, or a
// newly-registered source would render unlabeled and sorted last with no error.
// (The Record<DisplaySource, …> typing already enforces this at compile time;
// this is the runtime backstop + a clear failure message.)
describe('source-meta stays in sync with the registry', () => {
  it('every SOURCE_KEYS entry has a label', () => {
    for (const key of SOURCE_KEYS) {
      expect(SOURCE_LABELS[key], `missing SOURCE_LABELS['${key}']`).toBeTruthy();
    }
  });

  it('every SOURCE_KEYS entry has a chip order', () => {
    for (const key of SOURCE_KEYS) {
      expect(typeof SOURCE_ORDER[key], `missing SOURCE_ORDER['${key}']`).toBe('number');
    }
  });

  it('chip order values are unique', () => {
    const vals = Object.values(SOURCE_ORDER);
    expect(new Set(vals).size).toBe(vals.length);
  });
});
