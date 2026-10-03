import { describe, expect, it } from 'vitest';

import { canonicalizePageUrl } from '@/lib/canonicalUrl';

import {
  aggregateHash,
  archiveTitle,
  buildArchiveManifest,
  NSITE_SNAPSHOT_KIND,
  sourceIdTags,
  type ArchiveFile,
} from './manifest';

/**
 * A real kind 5128 event published by an unrelated tool
 * (`ad0ff8ba946e24c2…`, "Field Notes — NostrClay demo A"). Reproducing
 * its `x` tag from its `path` tags proves our reading of the aggregate
 * hash matches a third-party producer, not just itself.
 */
const NOSTRCLAY_PATHS: ArchiveFile[] = [
  { path: '/index.html', sha256: '7d767b036f0b859557a491ad41753760446104bbd6d123c4c5de0ad360bb507c' },
  { path: '/nostrclay-b67796c5.js', sha256: 'b67796c59bd8d230af6e53aa1fc32b86426c3ee2297828b1c3401b68ff066c64' },
  { path: '/nostrclay.js', sha256: 'b67796c59bd8d230af6e53aa1fc32b86426c3ee2297828b1c3401b68ff066c64' },
];
const NOSTRCLAY_AGGREGATE = '17a21b4719bff7d726a95b35baaed7c8a61c4ca4c285c7f54bfa533813e11980';

describe('aggregateHash', () => {
  it('reproduces the x tag of a third-party published manifest', () => {
    expect(aggregateHash(NOSTRCLAY_PATHS)).toBe(NOSTRCLAY_AGGREGATE);
  });

  it('ignores path tag order', () => {
    const reversed = [...NOSTRCLAY_PATHS].reverse();
    expect(aggregateHash(reversed)).toBe(NOSTRCLAY_AGGREGATE);
  });

  it('distinguishes different content at the same path', () => {
    const changed: ArchiveFile[] = [
      { ...NOSTRCLAY_PATHS[0], sha256: 'a'.repeat(64) },
      ...NOSTRCLAY_PATHS.slice(1),
    ];
    expect(aggregateHash(changed)).not.toBe(NOSTRCLAY_AGGREGATE);
  });

  it('distinguishes the same content at a different path', () => {
    const moved: ArchiveFile[] = [
      { ...NOSTRCLAY_PATHS[0], path: '/other.html' },
      ...NOSTRCLAY_PATHS.slice(1),
    ];
    expect(aggregateHash(moved)).not.toBe(NOSTRCLAY_AGGREGATE);
  });
});

describe('archiveTitle', () => {
  it('uses the page title when present', () => {
    expect(archiveTitle('Example Domain', 'https://example.com/')).toBe(
      'Archive of Example Domain',
    );
  });

  it('falls back to the hostname for an untitled page', () => {
    expect(archiveTitle(undefined, 'https://example.com/a/b')).toBe('Archive of example.com');
    expect(archiveTitle('   ', 'https://example.com/a/b')).toBe('Archive of example.com');
  });

  it('truncates a pathologically long title', () => {
    const title = archiveTitle('x'.repeat(500), 'https://example.com/');
    expect(title.length).toBe(200);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('sourceIdTags', () => {
  it('emits the normalized URL as a lone i tag', () => {
    expect(sourceIdTags('https://example.com/post')).toEqual([
      ['i', 'https://example.com/post'],
    ]);
  });

  it('drops the fragment, per NIP-73', () => {
    expect(sourceIdTags('https://example.com/post#section-2')[0]).toEqual([
      'i',
      'https://example.com/post',
    ]);
  });

  it('strips tracking params so repeat visits share one identity', () => {
    expect(sourceIdTags('https://example.com/post?utm_source=x&id=7')[0]).toEqual([
      'i',
      'https://example.com/post?id=7',
    ]);
  });

  it('matches the identifier NIP-22 comments use for the same page', () => {
    // Both go through `canonicalizePageUrl`, so an archive and the
    // comments about that page agree on what "the page" is.
    const messy = 'https://Example.com/post?fbclid=abc#top';
    expect(sourceIdTags(messy)[0][1]).toBe(canonicalizePageUrl(messy)?.toString());
  });

  it('omits the tag for a URL that cannot be canonicalized', () => {
    expect(sourceIdTags('chrome://newtab')).toEqual([]);
    expect(sourceIdTags('not a url')).toEqual([]);
  });
});

describe('buildArchiveManifest', () => {
  const files: ArchiveFile[] = [
    { path: '/index.html', sha256: '93f2ea0a24df6c74965e73f0225c9dc27b292aafbef2a7f6f0b4a9fab2b97f21' },
    { path: '/assets/style.css', sha256: 'acf208cc34d822b5c7870e09829f55a902c39660df262c73a3078584fd6e8b3e' },
  ];

  const template = buildArchiveManifest({
    files,
    servers: ['https://nostr.download'],
    pageTitle: 'Example Domain',
    sourceUrl: 'https://example.com/',
    capturedAt: 1788188092,
  });

  it('emits a kind 5128 event with empty content', () => {
    expect(template.kind).toBe(NSITE_SNAPSHOT_KIND);
    expect(template.content).toBe('');
  });

  it('emits one path tag per file', () => {
    const paths = template.tags.filter(([name]) => name === 'path');
    expect(paths).toEqual([
      ['path', '/index.html', files[0].sha256],
      ['path', '/assets/style.css', files[1].sha256],
    ]);
  });

  it('emits the aggregate x tag matching a hash verified against a live gateway', () => {
    expect(template.tags).toContainEqual([
      'x',
      'd3292dffb8f9498db0142e46814f72c4f20e85ce349c5819162f79f41af4875e',
      'aggregate',
    ]);
  });

  it('omits the a and A tags', () => {
    // The deliberate spec deviation — an archive of a web page
    // snapshots no parent nsite, so there is nothing to reference.
    expect(template.tags.some(([name]) => name === 'a' || name === 'A')).toBe(false);
  });

  it('identifies the archived page with a NIP-73 i tag and nothing else', () => {
    expect(template.tags).toContainEqual(['i', 'https://example.com/']);
    expect(template.tags.some(([name]) => name === 'r')).toBe(false);
    expect(template.tags.some(([name]) => name === 'k')).toBe(false);
  });

  it('advertises the servers holding the blobs', () => {
    expect(template.tags).toContainEqual(['server', 'https://nostr.download']);
  });

  it('rejects an archive with no index', () => {
    expect(() =>
      buildArchiveManifest({
        files: [files[1]],
        servers: [],
        sourceUrl: 'https://example.com/',
      }),
    ).toThrow(/index\.html/);
  });
});
