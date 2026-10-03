/**
 * Bitcoin API settings — edit the Esplora-compatible REST endpoints the
 * wallet and Send Bitcoin dialog use.
 *
 * Edits `config.esploraApis` locally. The list is tried in order with
 * failover (see `src/lib/esplora.ts`), so the first entry is the primary
 * and the rest are fallbacks. Reorder to change the preferred endpoint.
 */

import { useState } from 'react';
import { Plus, X, RotateCcw, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppContext } from '@/hooks/useAppContext';
import { useToast } from '@/hooks/useToast';
import { DEFAULT_ESPLORA_APIS } from '@/lib/esplora';

function normalizeEsploraUrl(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).toString().replace(/\/+$/, '');
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString().replace(/\/+$/, '');
    } catch {
      return trimmed;
    }
  }
}

function isValidEsploraUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeEsploraUrl(url));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function renderEsploraUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}

export function EsploraSettings() {
  const { config, updateConfig } = useAppContext();
  const { toast } = useToast();
  const esploraApis = config.esploraApis;
  const [newUrl, setNewUrl] = useState('');

  const save = (next: string[]) => {
    updateConfig((current) => ({ ...current, esploraApis: next }));
  };

  const handleAdd = () => {
    if (!isValidEsploraUrl(newUrl)) {
      toast({
        title: 'Invalid API URL',
        description: 'Enter a valid URL (e.g. https://mempool.space/api)',
        variant: 'destructive',
      });
      return;
    }
    const normalized = normalizeEsploraUrl(newUrl);
    if (esploraApis.includes(normalized)) {
      toast({ title: 'Already in the list', variant: 'destructive' });
      return;
    }
    save([...esploraApis, normalized]);
    setNewUrl('');
  };

  const handleRemove = (url: string) => {
    // The AppConfig schema requires at least one endpoint.
    if (esploraApis.length <= 1) {
      toast({
        title: 'At least one API is required',
        description: 'Add another endpoint first, or restore the defaults.',
        variant: 'destructive',
      });
      return;
    }
    save(esploraApis.filter((u) => u !== url));
  };

  const handleMove = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= esploraApis.length) return;
    const next = [...esploraApis];
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  };

  const handleReset = () => {
    save([...DEFAULT_ESPLORA_APIS]);
    toast({ title: 'Bitcoin APIs restored to defaults' });
  };

  const isAtDefaults =
    esploraApis.length === DEFAULT_ESPLORA_APIS.length &&
    esploraApis.every((u, i) => u === DEFAULT_ESPLORA_APIS[i]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Esplora-compatible endpoints used by the wallet. Tried in order — if the top one
          is down or rate-limited, the next is used automatically.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReset}
          disabled={isAtDefaults}
          className="shrink-0 text-xs h-8"
          title="Restore the default endpoint list"
        >
          <RotateCcw className="size-3.5 mr-1" />
          Restore defaults
        </Button>
      </div>

      <ul className="space-y-1.5">
        {esploraApis.map((url, index) => (
          <li key={url} className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-mono" title={url}>
                {renderEsploraUrl(url)}
              </p>
              <p className="text-xs text-muted-foreground">
                {index === 0 ? 'Primary' : `Fallback ${index}`}
              </p>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleMove(index, -1)}
                disabled={index === 0}
                className="size-7 p-0"
                title="Move up"
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleMove(index, 1)}
                disabled={index === esploraApis.length - 1}
                className="size-7 p-0"
                title="Move down"
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleRemove(url)}
                disabled={esploraApis.length <= 1}
                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                title={esploraApis.length <= 1 ? 'At least one API is required' : 'Remove'}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Label htmlFor="new-esplora-url" className="sr-only">
          Bitcoin API URL
        </Label>
        <Input
          id="new-esplora-url"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="https://mempool.space/api"
          className="h-9 text-base md:text-sm font-mono"
        />
        <Button
          onClick={handleAdd}
          disabled={!newUrl.trim()}
          variant="outline"
          size="sm"
          className="h-9 shrink-0 text-xs"
        >
          <Plus className="size-3.5 mr-1" />
          Add
        </Button>
      </div>
    </div>
  );
}

export default EsploraSettings;
