export interface DiscoveryProviderCapabilities {
  provider: string;
  supportsPersistence: boolean;
  supportsCommercialUse: boolean;
  supportsContactDiscovery: boolean;
  supportsLocationSearch: boolean;
  supportsImages: boolean;
}

export interface DiscoverySearchInput {
  query: string;
  country?: string;
  language?: string;
  count?: number;
}

export interface DiscoverySearchResult {
  url: string;
  title: string;
  snippet?: string;
  rank: number;
}

export interface DiscoveryProvider {
  readonly capabilities: DiscoveryProviderCapabilities;
  health(): Promise<{ healthy: boolean; message?: string }>;
  search(input: DiscoverySearchInput): Promise<DiscoverySearchResult[]>;
}
