import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute as a classic script, as MAIN-world injection does, rather than
// importing it as a module (which would hide global declaration collisions).
const script = ts.transpileModule(
  readFileSync('src/extension/inpage.ts', 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText;

function page() {
  const window = { addEventListener: vi.fn() };
  return { window, context: createContext({ window, exports: {} }) };
}

describe('MAIN-world provider installation', () => {
  it('coexists with page lexical declarations and can run twice', () => {
    const { window, context } = page();
    runInContext('const nostr = {}; const pending = {}; const MESSAGE_SCOPE = "page";', context);
    runInContext(script, context);
    const provider = Reflect.get(window, 'nostr');
    expect(provider).toHaveProperty('getPublicKey');
    expect(window.addEventListener).toHaveBeenCalledTimes(6);
    runInContext(script, context);
    expect(Reflect.get(window, 'nostr')).toBe(provider);
    expect(window.addEventListener).toHaveBeenCalledTimes(6);
  });

  it('preserves an existing signer without registering listeners', () => {
    const { window, context } = page();
    const provider = { getPublicKey: vi.fn() };
    Object.defineProperty(window, 'nostr', { value: provider });
    runInContext(script, context);
    expect(Reflect.get(window, 'nostr')).toBe(provider);
    expect(window.addEventListener).not.toHaveBeenCalled();
  });
});
