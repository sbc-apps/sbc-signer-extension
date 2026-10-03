import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashBytes } from './blossom';
import { buildArchive, MAX_ASSET_BYTES } from './pipeline';

const SOURCE = 'https://example.com/blog/post';

interface Route {
  body: string | Uint8Array;
  type?: string;
  status?: number;
  /** Advertise a content-length larger than the body, as a CDN would. */
  declaredLength?: number;
}

/** Serve a fixed map of URLs; anything else 404s. */
function serve(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const route = routes[url];

    if (!route) {
      return { ok: false, status: 404, headers: new Headers() } as unknown as Response;
    }

    const bytes =
      typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body;

    const headers = new Headers();
    if (route.type) headers.set('content-type', route.type);
    headers.set('content-length', String(route.declaredLength ?? bytes.byteLength));

    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers,
      arrayBuffer: vi.fn(async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ),
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function build(html: string) {
  return buildArchive({ html, sourceUrl: SOURCE, capturedAt: 1788188092 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildArchive', () => {
  it('produces an index plus one blob per asset, index first', async () => {
    serve({
      'https://example.com/blog/a.png': { body: 'PNGDATA', type: 'image/png' },
    });

    const archive = await build('<html><body><img src="a.png"></body></html>');

    expect(archive.blobs[0].path).toBe('/index.html');
    expect(archive.blobs).toHaveLength(2);
    expect(archive.blobs[1].path).toBe(`/assets/${hashBytes(new TextEncoder().encode('PNGDATA'))}.png`);
    expect(archive.skipped).toEqual([]);
  });

  it('rewrites the document to point at archive paths', async () => {
    serve({
      'https://example.com/blog/a.png': { body: 'PNGDATA', type: 'image/png' },
    });

    const archive = await build('<html><body><img src="a.png"></body></html>');
    const index = textOf(archive.blobs[0].bytes);

    expect(index).toContain(`/assets/${hashBytes(new TextEncoder().encode('PNGDATA'))}.png`);
    expect(index).not.toContain('src="a.png"');
  });

  it('follows urls inside stylesheets and rewrites them', async () => {
    serve({
      'https://example.com/site.css': {
        body: 'body{background:url(bg.png)}',
        type: 'text/css',
      },
      'https://example.com/bg.png': { body: 'BGDATA', type: 'image/png' },
    });

    const archive = await build('<link rel="stylesheet" href="/site.css">');
    const css = archive.blobs.find((blob) => blob.path.endsWith('.css'));
    const bgHash = hashBytes(new TextEncoder().encode('BGDATA'));

    expect(css).toBeDefined();
    expect(textOf(css!.bytes)).toBe(`body{background:url("/assets/${bgHash}.png")}`);
  });

  it("hashes a stylesheet by its rewritten bytes, not the original", async () => {
    // The manifest addresses the blob we upload; if we hashed the
    // original the gateway would serve a stylesheet under a hash that
    // doesn't match its contents.
    serve({
      'https://example.com/site.css': {
        body: 'body{background:url(bg.png)}',
        type: 'text/css',
      },
      'https://example.com/bg.png': { body: 'BGDATA', type: 'image/png' },
    });

    const archive = await build('<link rel="stylesheet" href="/site.css">');
    const css = archive.blobs.find((blob) => blob.path.endsWith('.css'))!;

    expect(css.sha256).toBe(hashBytes(css.bytes));
    expect(css.sha256).not.toBe(hashBytes(new TextEncoder().encode('body{background:url(bg.png)}')));
  });

  it('follows @import one level deeper', async () => {
    serve({
      'https://example.com/site.css': { body: '@import "theme.css";', type: 'text/css' },
      'https://example.com/theme.css': { body: 'a{color:red}', type: 'text/css' },
    });

    const archive = await build('<link rel="stylesheet" href="/site.css">');
    const sheets = archive.blobs.filter((blob) => blob.path.endsWith('.css'));

    expect(sheets).toHaveLength(2);
    const entry = sheets.find((sheet) => textOf(sheet.bytes).startsWith('@import'))!;
    const theme = sheets.find((sheet) => textOf(sheet.bytes) === 'a{color:red}')!;
    // The trailing `;` isn't part of the `@import` match, so it survives.
    expect(textOf(entry.bytes)).toBe(`@import "${theme.path}";`);
  });

  it('records assets that failed to fetch and leaves them absolute', async () => {
    serve({});

    const archive = await build('<img src="gone.png">');

    expect(archive.blobs).toHaveLength(1);
    expect(archive.skipped).toEqual([
      { url: 'https://example.com/blog/gone.png', reason: 'HTTP 404' },
    ]);
    // The reference falls back to the live web rather than dangling.
    expect(textOf(archive.blobs[0].bytes)).toContain('https://example.com/blog/gone.png');
  });

  it('rejects an oversized asset on its declared length, before downloading', async () => {
    const fetchMock = serve({
      'https://example.com/blog/huge.bin': {
        body: 'small body',
        type: 'application/octet-stream',
        declaredLength: MAX_ASSET_BYTES + 1,
      },
    });

    const archive = await build('<img src="huge.bin">');

    expect(archive.skipped[0].reason).toMatch(/too large/);
    expect(archive.blobs).toHaveLength(1);
    // Body was never read — the size check ran on the declared length.
    const response = await fetchMock.mock.results[0].value;
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('strips scripts from the captured html', async () => {
    serve({});

    const archive = await build('<html><body><script>evil()</script><p>text</p></body></html>');
    const index = textOf(archive.blobs[0].bytes);

    expect(index).not.toContain('evil()');
    expect(index).toContain('text');
  });

  it('adds a script-blocking CSP and provenance metadata', async () => {
    serve({});

    const archive = await build('<html><head></head><body></body></html>');
    const index = textOf(archive.blobs[0].bytes);

    expect(index).toContain("script-src 'none'");
    expect(index).toContain('archive:source');
  });

  it('deduplicates an asset referenced more than once', async () => {
    serve({ 'https://example.com/blog/a.png': { body: 'SAME', type: 'image/png' } });

    const archive = await build('<img src="a.png"><img src="./a.png"><img src="a.png?">');

    // `a.png` and `./a.png` are the same URL; `a.png?` is a distinct
    // URL but identical bytes, so it collapses to the same blob path.
    const assetPaths = new Set(archive.blobs.slice(1).map((blob) => blob.path));
    expect(assetPaths.size).toBe(1);
  });

  it('reports a total size covering every blob', async () => {
    serve({ 'https://example.com/blog/a.png': { body: 'PNGDATA', type: 'image/png' } });

    const archive = await build('<img src="a.png">');
    const summed = archive.blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0);

    expect(archive.totalBytes).toBe(summed);
  });

  it('reports progress through both phases', async () => {
    serve({ 'https://example.com/blog/a.png': { body: 'PNGDATA', type: 'image/png' } });

    const phases: string[] = [];
    await buildArchive({
      html: '<img src="a.png">',
      sourceUrl: SOURCE,
      capturedAt: 1788188092,
      onProgress: ({ phase }) => {
        if (phases.at(-1) !== phase) phases.push(phase);
      },
    });

    expect(phases).toEqual(['fetching', 'building']);
  });
});
