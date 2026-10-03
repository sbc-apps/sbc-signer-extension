import { createContext } from "react";

export type Theme = "dark" | "light" | "system";

export interface RelayMetadata {
  /** List of relays with read/write permissions */
  relays: { url: string; read: boolean; write: boolean }[];
  /** Unix timestamp of when the relay list was last updated */
  updatedAt: number;
}

/** Blossom server list metadata (BUD-03 / kind 10063), mirroring RelayMetadata for parity. */
export interface BlossomServerMetadata {
  /** Ordered list of Blossom server URLs (most trusted/reliable first per BUD-03). */
  servers: string[];
  /** Unix timestamp of when the server list was last updated (from kind 10063 created_at). */
  updatedAt: number;
}

export interface AppConfig {
  /** Current theme */
  theme: Theme;
  /** NIP-65 relay list metadata */
  relayMetadata: RelayMetadata;
  /** User's kind 10063 Blossom server list. */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * When true, the app's default Blossom servers are merged with the user's
   * servers (app servers first, deduped). When false, only the user's servers
   * are used.
   */
  useAppBlossomServers: boolean;
  /**
   * Ordered list of base URLs for Esplora-compatible Bitcoin REST APIs.
   * Used by the wallet and the Send Bitcoin dialog. Each URL is the standard
   * Esplora REST root (no version segment, no trailing slash). The list is
   * tried in order with exponential-backoff failover on `429` / `5xx`
   * responses — see `src/lib/esplora.ts`.
   *
   * The first entry is treated as the primary. The mempool.space `/v1/prices`
   * extension is appended by the price call; endpoints that don't speak it
   * (e.g. Blockstream's Esplora) are silently skipped via a `404` soft-failover.
   *
   * Default:
   * ```
   * [
   *   'https://mempool.space/api',
   *   'https://mempool.emzy.de/api',
   *   'https://blockstream.info/api',
   * ]
   * ```
   */
  esploraApis: string[];
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
