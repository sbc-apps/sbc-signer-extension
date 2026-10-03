/**
 * Relay settings — edit the relays the extension uses.
 *
 * Edits `config.relayMetadata` locally (persisted to the extension's
 * AppConfig). The read relays here drive every relay query the
 * extension makes: comment threads in the popup, the comment-presence
 * badge in the background, profile lookups, bunker handshakes, etc.
 *
 * This is a local list only — it is not published as a NIP-65 (kind
 * 10002) event, matching the extension's design of keeping config
 * private to the extension pages.
 */

import { useState } from 'react';
import { Plus, X, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppContext } from '@/hooks/useAppContext';
import { useToast } from '@/hooks/useToast';
import { APP_RELAYS } from '@/lib/appRelays';

interface Relay {
  url: string;
  read: boolean;
  write: boolean;
}

function renderRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') {
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function normalizeRelayUrl(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`wss://${trimmed}`).toString();
    } catch {
      return trimmed;
    }
  }
}

function isValidRelayUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(normalizeRelayUrl(trimmed));
    return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
  } catch {
    return false;
  }
}

function isAtDefaults(relays: Relay[]): boolean {
  const def = APP_RELAYS.relays;
  return (
    relays.length === def.length &&
    relays.every(
      (r, i) => r.url === def[i].url && r.read === def[i].read && r.write === def[i].write,
    )
  );
}

export function RelaySettings() {
  const { config, updateConfig } = useAppContext();
  const { toast } = useToast();

  // Read relays straight from config — it's the source of truth and is
  // kept current by AppProvider, so no local mirror/effect is needed.
  const relays = config.relayMetadata.relays;
  const [newRelayUrl, setNewRelayUrl] = useState('');

  const saveRelays = (next: Relay[]) => {
    updateConfig((current) => ({
      ...current,
      relayMetadata: {
        relays: next,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    }));
  };

  const handleAddRelay = () => {
    if (!isValidRelayUrl(newRelayUrl)) {
      toast({
        title: 'Invalid relay URL',
        description: 'Enter a valid relay URL (e.g. wss://relay.example.com)',
        variant: 'destructive',
      });
      return;
    }
    const normalized = normalizeRelayUrl(newRelayUrl);
    if (relays.some((r) => r.url === normalized)) {
      toast({ title: 'Relay already in the list', variant: 'destructive' });
      return;
    }
    saveRelays([...relays, { url: normalized, read: true, write: true }]);
    setNewRelayUrl('');
  };

  const handleRemoveRelay = (url: string) => {
    saveRelays(relays.filter((r) => r.url !== url));
  };

  const handleToggle = (url: string, field: 'read' | 'write') => {
    saveRelays(relays.map((r) => (r.url === url ? { ...r, [field]: !r[field] } : r)));
  };

  const handleReset = () => {
    saveRelays(APP_RELAYS.relays.map((r) => ({ ...r })));
    toast({ title: 'Relays restored to defaults' });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Relays used to read and publish Nostr events. Read relays are also used for the
          comment indicator.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReset}
          disabled={isAtDefaults(relays)}
          className="shrink-0 text-xs h-8"
          title="Restore the default relay list"
        >
          <RotateCcw className="size-3.5 mr-1" />
          Restore defaults
        </Button>
      </div>

      {relays.length === 0 ? (
        <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
          No relays configured. Add one below to read and publish events.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {relays.map((relay) => (
            <li
              key={relay.url}
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
            >
              <p className="min-w-0 flex-1 truncate text-sm font-mono" title={relay.url}>
                {renderRelayUrl(relay.url)}
              </p>
              <div className="flex items-center gap-1 text-[10px] shrink-0">
                {relay.read && (
                  <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium">
                    Read
                  </span>
                )}
                {relay.write && (
                  <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">
                    Write
                  </span>
                )}
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
                    title="Read / write settings"
                  >
                    <span className="text-xs">···</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-40" align="end">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`read-${relay.url}`} className="text-xs cursor-pointer">
                        Read
                      </Label>
                      <Switch
                        id={`read-${relay.url}`}
                        checked={relay.read}
                        onCheckedChange={() => handleToggle(relay.url, 'read')}
                        size="sm"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`write-${relay.url}`} className="text-xs cursor-pointer">
                        Write
                      </Label>
                      <Switch
                        id={`write-${relay.url}`}
                        checked={relay.write}
                        onCheckedChange={() => handleToggle(relay.url, 'write')}
                        size="sm"
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRemoveRelay(relay.url)}
                className="size-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                title="Remove relay"
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Label htmlFor="new-relay-url" className="sr-only">
          Relay URL
        </Label>
        <Input
          id="new-relay-url"
          value={newRelayUrl}
          onChange={(e) => setNewRelayUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddRelay();
          }}
          placeholder="wss://relay.example.com"
          className="h-9 text-base md:text-sm font-mono"
        />
        <Button
          onClick={handleAddRelay}
          disabled={!newRelayUrl.trim()}
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

export default RelaySettings;
