export interface StructuredBusinessFacts {
  name: string | null;
  url: string | null;
  email: string | null;
  telephone: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  priceRange: string | null;
  sameAs: string[];
}

function objectsFrom(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(objectsFrom);
  const object = value as Record<string, unknown>;
  const graph = Array.isArray(object['@graph']) ? object['@graph'] as unknown[] : [];
  return [object, ...graph.flatMap(objectsFrom)];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function typeMatches(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some(item => typeof item === 'string' && [
    'localbusiness', 'organization', 'professionalservice', 'eventvenue', 'foodestablishment', 'store',
  ].includes(item.toLowerCase()));
}

export function extractStructuredBusinessFacts(jsonLd: unknown[]): StructuredBusinessFacts {
  const objects = jsonLd.flatMap(objectsFrom);
  const business = objects.find(object => typeMatches(object['@type'])) ?? objects.find(object => text(object.name));
  if (!business) {
    return { name: null, url: null, email: null, telephone: null, locality: null, region: null, postcode: null, priceRange: null, sameAs: [] };
  }
  const address = business.address && typeof business.address === 'object' && !Array.isArray(business.address)
    ? business.address as Record<string, unknown>
    : {};
  const sameAsRaw = Array.isArray(business.sameAs) ? business.sameAs : [business.sameAs];
  return {
    name: text(business.name),
    url: text(business.url),
    email: text(business.email),
    telephone: text(business.telephone),
    locality: text(address.addressLocality),
    region: text(address.addressRegion),
    postcode: text(address.postalCode),
    priceRange: text(business.priceRange),
    sameAs: sameAsRaw.map(text).filter((item): item is string => Boolean(item)).slice(0, 20),
  };
}
