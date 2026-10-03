import { describe, expect, it } from 'vitest';

import {
  absolutize,
  assetPath,
  collectDocumentAssets,
  extensionFor,
  extractCssUrls,
  isFetchableUrl,
  parseSrcset,
  rewriteCssUrls,
  rewriteDocumentAssets,
  serializeSrcset,
} from './rewrite';

const BASE = 'https://example.com/blog/post';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('isFetchableUrl', () => {
  it('accepts http(s)', () => {
    expect(isFetchableUrl('https://example.com/a.png')).toBe(true);
    expect(isFetchableUrl('http://example.com/a.png')).toBe(true);
  });

  it('rejects self-contained and unfetchable schemes', () => {
    expect(isFetchableUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isFetchableUrl('blob:https://example.com/abc')).toBe(false);
    expect(isFetchableUrl('javascript:alert(1)')).toBe(false);
    expect(isFetchableUrl('about:blank')).toBe(false);
    expect(isFetchableUrl('   ')).toBe(false);
  });
});

describe('parseSrcset', () => {
  it('parses density and width descriptors', () => {
    expect(parseSrcset('a.png 1x, b.png 2x')).toEqual([
      { url: 'a.png', descriptor: '1x' },
      { url: 'b.png', descriptor: '2x' },
    ]);
    expect(parseSrcset('a.png 480w, b.png 960w')).toEqual([
      { url: 'a.png', descriptor: '480w' },
      { url: 'b.png', descriptor: '960w' },
    ]);
  });

  it('parses a bare candidate with no descriptor', () => {
    expect(parseSrcset('a.png')).toEqual([{ url: 'a.png', descriptor: '' }]);
    expect(parseSrcset('a.png, b.png 2x')).toEqual([
      { url: 'a.png', descriptor: '' },
      { url: 'b.png', descriptor: '2x' },
    ]);
  });

  it('keeps a comma-free data URI intact', () => {
    // A bare comma inside a srcset URL is invalid per the HTML spec
    // (it has to be percent-encoded as %2C), and browsers split on it
    // too — so matching the spec here is the correct behaviour, not a
    // limitation. A properly encoded data URI must survive.
    const srcset = 'data:image/svg+xml;base64,PHN2Zy8%2B 1x, b.png 2x';
    expect(parseSrcset(srcset)).toEqual([
      { url: 'data:image/svg+xml;base64,PHN2Zy8%2B', descriptor: '1x' },
      { url: 'b.png', descriptor: '2x' },
    ]);
  });

  it('round-trips through serializeSrcset', () => {
    const input = 'a.png 1x, b.png 2x';
    expect(serializeSrcset(parseSrcset(input))).toBe(input);
  });
});

describe('extractCssUrls', () => {
  it('finds urls in every quoting form', () => {
    const css = `
      a { background: url("one.png"); }
      b { background: url('two.png'); }
      c { background: url(three.png); }
    `;
    expect(extractCssUrls(css, BASE).sort()).toEqual([
      'https://example.com/blog/one.png',
      'https://example.com/blog/three.png',
      'https://example.com/blog/two.png',
    ]);
  });

  it('finds @import targets', () => {
    expect(extractCssUrls('@import "theme.css";', BASE)).toEqual([
      'https://example.com/blog/theme.css',
    ]);
  });

  it('skips data URIs', () => {
    expect(extractCssUrls('a{background:url(data:image/png;base64,AAA)}', BASE)).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    const css = 'a{background:url(x.png)} b{background:url("x.png")}';
    expect(extractCssUrls(css, BASE)).toEqual(['https://example.com/blog/x.png']);
  });
});

describe('rewriteCssUrls', () => {
  const resolve = (url: string) =>
    url === 'https://example.com/blog/x.png' ? '/assets/deadbeef.png' : undefined;

  it('rewrites archived urls to archive paths', () => {
    expect(rewriteCssUrls('a{background:url(x.png)}', BASE, resolve)).toBe(
      'a{background:url("/assets/deadbeef.png")}',
    );
  });

  it('absolutizes urls that were not archived', () => {
    expect(rewriteCssUrls('a{background:url(y.png)}', BASE, resolve)).toBe(
      'a{background:url("https://example.com/blog/y.png")}',
    );
  });

  it('rewrites @import while preserving its form', () => {
    expect(rewriteCssUrls('@import "x.png"', BASE, resolve)).toBe(
      '@import "/assets/deadbeef.png"',
    );
  });
});

describe('collectDocumentAssets', () => {
  it('collects subresources but not outbound links', () => {
    const doc = parse(`
      <link rel="stylesheet" href="/site.css">
      <img src="a.png" srcset="a.png 1x, b.png 2x">
      <video poster="p.jpg"><source src="v.mp4"></video>
      <div style="background:url(bg.png)"></div>
      <style>@font-face{src:url(f.woff2)}</style>
      <a href="/other-page">link</a>
    `);

    expect(collectDocumentAssets(doc, BASE).sort()).toEqual([
      'https://example.com/blog/a.png',
      'https://example.com/blog/b.png',
      'https://example.com/blog/bg.png',
      'https://example.com/blog/f.woff2',
      'https://example.com/blog/p.jpg',
      'https://example.com/blog/v.mp4',
      'https://example.com/site.css',
    ]);
  });

  it('ignores data URIs already inline in the page', () => {
    const doc = parse('<img src="data:image/png;base64,AAAA">');
    expect(collectDocumentAssets(doc, BASE)).toEqual([]);
  });
});

describe('rewriteDocumentAssets', () => {
  it('rewrites archived assets and absolutizes the rest', () => {
    const doc = parse('<img src="a.png"><img src="missing.png">');
    rewriteDocumentAssets(doc, BASE, (url) =>
      url.endsWith('/a.png') ? '/assets/aaaa.png' : undefined,
    );

    const [archived, missing] = Array.from(doc.querySelectorAll('img'));
    expect(archived.getAttribute('src')).toBe('/assets/aaaa.png');
    expect(missing.getAttribute('src')).toBe('https://example.com/blog/missing.png');
  });

  it('rewrites every srcset candidate independently', () => {
    const doc = parse('<img srcset="a.png 1x, b.png 2x">');
    rewriteDocumentAssets(doc, BASE, (url) =>
      url.endsWith('/a.png') ? '/assets/aaaa.png' : undefined,
    );

    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe(
      '/assets/aaaa.png 1x, https://example.com/blog/b.png 2x',
    );
  });

  it('absolutizes outbound links so they still work from the gateway', () => {
    const doc = parse('<a href="/other">x</a><a href="#frag">y</a>');
    rewriteDocumentAssets(doc, BASE, () => undefined);

    const [external, fragment] = Array.from(doc.querySelectorAll('a'));
    expect(external.getAttribute('href')).toBe('https://example.com/other');
    // In-page fragments must stay relative or they'd leave the archive.
    expect(fragment.getAttribute('href')).toBe('#frag');
  });

  it('rewrites urls inside inline styles and style elements', () => {
    const doc = parse('<div style="background:url(x.png)"></div><style>a{background:url(x.png)}</style>');
    rewriteDocumentAssets(doc, BASE, () => '/assets/xxxx.png');

    expect(doc.querySelector('div')?.getAttribute('style')).toBe(
      'background:url("/assets/xxxx.png")',
    );
    expect(doc.querySelector('style')?.textContent).toBe('a{background:url("/assets/xxxx.png")}');
  });
});

describe('extensionFor', () => {
  it('prefers the response content type', () => {
    expect(extensionFor('image/png', 'https://example.com/x')).toBe('png');
    expect(extensionFor('text/css; charset=utf-8', 'https://example.com/x')).toBe('css');
  });

  it('falls back to the URL extension', () => {
    expect(extensionFor(null, 'https://example.com/a/b.woff2')).toBe('woff2');
    expect(extensionFor('application/octet-stream', 'https://example.com/a/b.PNG')).toBe('png');
  });

  it('ignores query strings when reading the URL extension', () => {
    expect(extensionFor(null, 'https://example.com/a.png?v=2')).toBe('png');
  });

  it('falls back to bin for the unknowable', () => {
    expect(extensionFor(null, 'https://example.com/a/b')).toBe('bin');
  });
});

describe('assetPath', () => {
  it('names blobs by content hash', () => {
    expect(assetPath('a'.repeat(64), 'png')).toBe(`/assets/${'a'.repeat(64)}.png`);
  });
});

describe('absolutize', () => {
  it('resolves against the capture base', () => {
    expect(absolutize('../x.png', BASE)).toBe('https://example.com/x.png');
  });

  it('returns undefined for garbage', () => {
    expect(absolutize('', BASE)).toBeUndefined();
  });
});
