import { describe, expect, it } from 'vitest';

import {
  clipContext,
  ELLIPSIS,
  MAX_CONTEXT_LENGTH,
  normalizeText,
} from './highlightContext';

/** Build filler prose of at least `min` characters, in whole sentences. */
function prose(min: number, word = 'filler'): string {
  const sentence = `${word} ${word} ${word} ${word} ${word}. `;
  let out = '';
  while (out.length < min) out += sentence;
  return out.trim();
}

describe('normalizeText', () => {
  it('collapses every kind of whitespace run into one space', () => {
    expect(normalizeText('a  \n\t b \r\n  c')).toBe('a b c');
  });

  it('trims the edges', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('returns empty for whitespace-only input', () => {
    expect(normalizeText(' \n\t ')).toBe('');
  });
});

describe('clipContext', () => {
  it('returns short blocks unchanged', () => {
    const text = 'One. Two. Three.';
    expect(clipContext(text, 'Two.')).toBe(text);
  });

  it('rejects a block that adds nothing to the excerpt', () => {
    expect(clipContext('Two.', 'Two.')).toBeNull();
  });

  it('rejects a block that does not contain the excerpt', () => {
    expect(clipContext('One. Two.', 'Nowhere')).toBeNull();
  });

  it('rejects an empty excerpt', () => {
    expect(clipContext('One. Two.', '')).toBeNull();
  });

  describe('oversized blocks', () => {
    const excerpt = 'The excerpt sits right here.';
    const text = `${prose(3000, 'before')} ${excerpt} ${prose(3000, 'after')}`;

    it('clips to the cap instead of giving up', () => {
      const out = clipContext(text, excerpt);
      expect(out).not.toBeNull();
      expect(out!.length).toBeLessThanOrEqual(MAX_CONTEXT_LENGTH);
      expect(out!.length).toBeGreaterThan(excerpt.length);
    });

    it('keeps the NIP-84 context.includes(content) invariant', () => {
      expect(clipContext(text, excerpt)).toContain(excerpt);
    });

    it('marks both clipped edges with an ellipsis', () => {
      const out = clipContext(text, excerpt)!;
      expect(out.startsWith(ELLIPSIS)).toBe(true);
      expect(out.endsWith(ELLIPSIS)).toBe(true);
    });

    it('takes prose from both sides of the excerpt', () => {
      const out = clipContext(text, excerpt)!;
      expect(out).toMatch(/before/);
      expect(out).toMatch(/after/);
    });

    it('spends the whole budget on one side when the excerpt starts the block', () => {
      const head = `${excerpt} ${prose(6000, 'after')}`;
      const out = clipContext(head, excerpt)!;
      expect(out.startsWith(excerpt)).toBe(true);
      expect(out.endsWith(ELLIPSIS)).toBe(true);
      // Would be ~half this if the unused leading budget were forfeited.
      expect(out.length).toBeGreaterThan(MAX_CONTEXT_LENGTH * 0.9);
    });

    it('spends the whole budget on one side when the excerpt ends the block', () => {
      const tail = `${prose(6000, 'before')} ${excerpt}`;
      const out = clipContext(tail, excerpt)!;
      expect(out.startsWith(ELLIPSIS)).toBe(true);
      expect(out.endsWith(excerpt)).toBe(true);
      expect(out.length).toBeGreaterThan(MAX_CONTEXT_LENGTH * 0.9);
    });

    it('does not open or close mid-word', () => {
      const out = clipContext(text, excerpt)!;
      const inner = out.replace(new RegExp(`^${ELLIPSIS}|${ELLIPSIS}$`, 'g'), '');
      expect(inner).not.toMatch(/^[a-z]*[A-Z]/); // no truncated leading word
      expect(inner.startsWith('before')).toBe(true);
      expect(inner.endsWith('.')).toBe(true);
    });

    it('gives up when the excerpt alone fills the cap', () => {
      const huge = prose(MAX_CONTEXT_LENGTH + 500);
      expect(clipContext(`${huge} tail`, huge)).toBeNull();
    });
  });

  it('holds the invariant across every offset and excerpt length', () => {
    const text = prose(8000);
    for (let start = 0; start < text.length; start += 97) {
      for (const len of [1, 12, 140, 900, 1900]) {
        const excerpt = text.slice(start, start + len);
        if (!excerpt || excerpt.length >= MAX_CONTEXT_LENGTH) continue;
        const out = clipContext(text, excerpt);
        if (out === null) continue;
        expect(out).toContain(excerpt);
        expect(out.length).toBeGreaterThan(excerpt.length);
        expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_LENGTH);
      }
    }
  });
});
