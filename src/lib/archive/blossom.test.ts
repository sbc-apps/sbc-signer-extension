import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hashBytes,
  serverFailures,
  serversHoldingEveryBlob,
  uploadBlob,
  type ArchiveBlob,
  type BlobUploadResult,
} from './blossom';

import type { NostrSigner } from '@nostrify/nostrify';

const SIGNER = {
  signEvent: async (template: Record<string, unknown>) => ({
    ...template,
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
  }),
} as unknown as NostrSigner;

function blob(bytes = new Uint8Array([1, 2, 3])): ArchiveBlob {
  return {
    path: '/assets/x.png',
    sha256: hashBytes(bytes),
    bytes,
    mimeType: 'image/png',
  };
}

/** Route requests by method and host so tests can shape per-server behaviour. */
function mockFetch(
  handler: (url: string, init: RequestInit) => { status: number; body?: unknown } | 'throw',
) {
  return vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const result = handler(url, init);
    if (result === 'throw') throw new Error('network down');

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: new Headers(),
      json: async () => result.body,
      text: async () => JSON.stringify(result.body ?? ''),
    } as unknown as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hashBytes', () => {
  it('matches the sha256 of the bytes', () => {
    // echo -n "hello" | sha256sum
    expect(hashBytes(new TextEncoder().encode('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('uploadBlob', () => {
  it('uploads where missing and reports success per server', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) =>
        init.method === 'HEAD' ? { status: 404 } : { status: 200, body: { sha256: blob().sha256 } },
      ),
    );

    const result = await uploadBlob(blob(), ['https://a.example', 'https://b.example'], SIGNER);

    expect(result.outcomes).toEqual([
      { server: 'https://a.example', ok: true, deduplicated: false },
      { server: 'https://b.example', ok: true, deduplicated: false },
    ]);
  });

  it('skips the upload when the server already has the blob', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init.method === 'HEAD' ? { status: 200 } : { status: 500 },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);

    expect(result.outcomes[0]).toEqual({
      server: 'https://a.example',
      ok: true,
      deduplicated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a server that stored different bytes than we sent', async () => {
    // Servers that transcode images would leave the manifest pointing
    // at a hash the server doesn't actually serve.
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) =>
        init.method === 'HEAD'
          ? { status: 404 }
          : { status: 200, body: { sha256: 'f'.repeat(64) } },
      ),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);

    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].error).toMatch(/different hash/);
  });

  it('records an HTTP failure without rejecting', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => (init.method === 'HEAD' ? { status: 404 } : { status: 413 })),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);
    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].error).toMatch(/413/);
  });

  it('records a network failure without rejecting', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => (init.method === 'HEAD' ? { status: 404 } : 'throw')),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);
    expect(result.outcomes[0].ok).toBe(false);
    expect(result.outcomes[0].error).toMatch(/network down/);
  });

  it('prefers the BUD-11 base64url token', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init.method === 'HEAD' ? { status: 404 } : { status: 200, body: {} },
    );
    vi.stubGlobal('fetch', fetchMock);

    await uploadBlob(blob(), ['https://a.example'], SIGNER);

    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);

    const token = (puts[0][1]?.headers as Record<string, string>).authorization.slice(6);
    // Base64url is padless and uses -/_ rather than +//.
    expect(token).not.toMatch(/[+/=]/);
  });

  it('retries with standard base64 when a server rejects base64url', async () => {
    // Measured behaviour of nostr.download and blossom.primal.net.
    let puts = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => {
        if (init.method === 'HEAD') return { status: 404 };
        puts += 1;
        return puts === 1 ? { status: 400 } : { status: 200, body: {} };
      }),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);

    expect(result.outcomes[0].ok).toBe(true);
    expect(puts).toBe(2);
  });

  it('reuses the same signature across both encodings', async () => {
    // Re-signing would cost a network round trip on a bunker login.
    const signEvent = vi.fn(SIGNER.signEvent.bind(SIGNER));
    let puts = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => {
        if (init.method === 'HEAD') return { status: 404 };
        puts += 1;
        return puts === 1 ? { status: 401 } : { status: 200, body: {} };
      }),
    );

    await uploadBlob(blob(), ['https://a.example'], {
      signEvent,
    } as unknown as NostrSigner);

    expect(signEvent).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-auth rejection', async () => {
    let puts = 0;
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => {
        if (init.method === 'HEAD') return { status: 404 };
        puts += 1;
        return { status: 413 };
      }),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);

    expect(puts).toBe(1);
    expect(result.outcomes[0].error).toMatch(/413/);
  });

  it('treats 409 as a real failure, not "already have it"', async () => {
    // BUD-02: 409 means the body didn't match the X-SHA-256 we sent.
    // An existing blob is a 200 with a descriptor.
    vi.stubGlobal(
      'fetch',
      mockFetch((_url, init) => (init.method === 'HEAD' ? { status: 404 } : { status: 409 })),
    );

    const result = await uploadBlob(blob(), ['https://a.example'], SIGNER);
    expect(result.outcomes[0].ok).toBe(false);
  });

  it('sends the hash we computed, not one the server chooses', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init.method === 'HEAD' ? { status: 404 } : { status: 200, body: {} },
    );
    vi.stubGlobal('fetch', fetchMock);

    const target = blob();
    await uploadBlob(target, ['https://a.example'], SIGNER);

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const headers = put?.[1]?.headers as Record<string, string>;
    expect(headers['x-sha-256']).toBe(target.sha256);
    expect(headers.authorization).toMatch(/^Nostr /);
  });
});

describe('serversHoldingEveryBlob', () => {
  const results = (): BlobUploadResult[] => [
    {
      sha256: 'a'.repeat(64),
      path: '/index.html',
      outcomes: [
        { server: 'https://a.example', ok: true, deduplicated: false },
        { server: 'https://b.example', ok: true, deduplicated: false },
      ],
    },
    {
      sha256: 'b'.repeat(64),
      path: '/assets/x.png',
      outcomes: [
        { server: 'https://a.example', ok: true, deduplicated: false },
        { server: 'https://b.example', ok: false, deduplicated: false, error: 'HTTP 413' },
      ],
    },
  ];

  it('excludes a server that dropped any single blob', () => {
    // b.example holds the HTML but not the image — advertising it
    // would produce an archive that renders with pieces missing.
    expect(serversHoldingEveryBlob(results())).toEqual(['https://a.example']);
  });

  it('returns nothing when there is nothing to publish', () => {
    expect(serversHoldingEveryBlob([])).toEqual([]);
  });

  it('surfaces the first failure reason per server', () => {
    expect(serverFailures(results())).toEqual(new Map([['https://b.example', 'HTTP 413']]));
  });
});
