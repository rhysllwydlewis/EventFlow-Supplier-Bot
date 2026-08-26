import type { DiscoveryProvider } from './provider.js';
import { BraveDiscoveryProvider } from './brave.provider.js';

export function configuredDiscoveryProviders(): DiscoveryProvider[] {
  return [new BraveDiscoveryProvider()];
}

export function getDiscoveryProvider(name: string): DiscoveryProvider {
  const provider = configuredDiscoveryProviders().find(item => item.capabilities.provider === name);
  if (!provider) {
    throw new Error(`Unknown discovery provider: ${name}`);
  }
  return provider;
}
