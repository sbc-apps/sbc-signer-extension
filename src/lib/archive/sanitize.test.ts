import { describe, expect, it } from 'vitest';

import {
  annotateArchiveDocument,
  sanitizeArchiveDocument,
  serializeDocument,
} from './sanitize';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('sanitizeArchiveDocument', () => {
  it('removes scripts', () => {
    const doc = parse('<p>keep</p><script>alert(1)</script><script src="x.js"></script>');
    const result = sanitizeArchiveDocument(doc);

    expect(result.scripts).toBe(2);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('p')?.textContent).toBe('keep');
  });

  it('removes inline event handlers', () => {
    const doc = parse('<div onclick="steal()" ONMOUSEOVER="x()" id="d">hi</div>');
    const result = sanitizeArchiveDocument(doc);

    const div = doc.querySelector('#d');
    expect(result.handlers).toBe(2);
    expect(div?.getAttribute('onclick')).toBeNull();
    expect(div?.getAttribute('onmouseover')).toBeNull();
    expect(div?.getAttribute('id')).toBe('d');
  });

  it('strips javascript: urls without removing the element', () => {
    const doc = parse('<a href="javascript:alert(1)">x</a>');
    sanitizeArchiveDocument(doc);

    const anchor = doc.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBeNull();
  });

  it('removes frames that would load the live web', () => {
    const doc = parse('<iframe src="https://tracker.example"></iframe><object data="x"></object>');
    const result = sanitizeArchiveDocument(doc);

    expect(result.frames).toBe(2);
    expect(doc.querySelector('iframe, object')).toBeNull();
  });

  it('removes base elements that would re-root relative urls', () => {
    const doc = parse('<head><base href="https://example.com/"></head>');
    sanitizeArchiveDocument(doc);
    expect(doc.querySelector('base')).toBeNull();
  });

  it('removes refresh and CSP metas but keeps ordinary ones', () => {
    const doc = parse(`
      <meta http-equiv="refresh" content="0;url=https://elsewhere">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
      <meta http-equiv="content-type" content="text/html">
      <meta name="description" content="keep me">
    `);
    sanitizeArchiveDocument(doc);

    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="content-type"]')).not.toBeNull();
    expect(doc.querySelector('meta[name="description"]')).not.toBeNull();
  });

  it('removes origin-bound link hints but keeps stylesheets and icons', () => {
    const doc = parse(`
      <link rel="preload" href="a.js" as="script">
      <link rel="dns-prefetch" href="//cdn.example">
      <link rel="stylesheet" href="/site.css">
      <link rel="icon" href="/favicon.ico">
    `);
    sanitizeArchiveDocument(doc);

    expect(doc.querySelector('link[rel="preload"]')).toBeNull();
    expect(doc.querySelector('link[rel="dns-prefetch"]')).toBeNull();
    expect(doc.querySelector('link[rel="stylesheet"]')).not.toBeNull();
    expect(doc.querySelector('link[rel="icon"]')).not.toBeNull();
  });

  it('is idempotent, so the second defence-in-depth pass is a no-op', () => {
    const doc = parse('<script>x()</script><div onclick="y()">z</div>');
    sanitizeArchiveDocument(doc);
    const after = serializeDocument(doc);

    const second = sanitizeArchiveDocument(doc);
    expect(second).toEqual({ scripts: 0, frames: 0, handlers: 0 });
    expect(serializeDocument(doc)).toBe(after);
  });
});

describe('annotateArchiveDocument', () => {
  it('adds a CSP that blocks active content but allows rendering', () => {
    const doc = parse('<head></head><body></body>');
    annotateArchiveDocument(doc, { sourceUrl: 'https://example.com/', capturedAt: 1788188092 });

    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const content = csp?.getAttribute('content') ?? '';
    expect(content).toContain("script-src 'none'");
    expect(content).toContain("object-src 'none'");
    // Images, styles and fonts must still load or the archive is blank.
    expect(content).not.toContain('default-src');
  });

  it('records provenance', () => {
    const doc = parse('<head></head><body></body>');
    annotateArchiveDocument(doc, { sourceUrl: 'https://example.com/a', capturedAt: 1788188092 });

    expect(doc.querySelector('meta[name="archive:source"]')?.getAttribute('content')).toBe(
      'https://example.com/a',
    );
    expect(
      doc.querySelector('meta[name="archive:captured-at"]')?.getAttribute('content'),
    ).toBe(new Date(1788188092 * 1000).toISOString());
  });
});

describe('serializeDocument', () => {
  it('round-trips through the parser', () => {
    const doc = parse('<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>');
    const html = serializeDocument(doc);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(parse(html).querySelector('title')?.textContent).toBe('t');
    expect(parse(html).querySelector('p')?.textContent).toBe('x');
  });
});
