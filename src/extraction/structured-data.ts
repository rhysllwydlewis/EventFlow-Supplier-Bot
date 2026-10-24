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

// schema.org allows a business to declare its email either directly or
// nested under one or more ContactPoint entries -- both are the same kind
// of deliberate, structured declaration extractServiceTagsFromJsonLd's own
// comment describes, so this business object's own email isn't limited to
// only the flat form.
function contactPointEmail(business: Record<string, unknown>): string | null {
  const points = Array.isArray(business.contactPoint) ? business.contactPoint : [business.contactPoint];
  for (const point of points) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) continue;
    const email = text((point as Record<string, unknown>).email);
    if (email) return email;
  }
  return null;
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
    email: text(business.email) ?? contactPointEmail(business),
    telephone: text(business.telephone),
    locality: text(address.addressLocality),
    region: text(address.addressRegion),
    postcode: text(address.postalCode),
    priceRange: text(business.priceRange),
    sameAs: sameAsRaw.map(text).filter((item): item is string => Boolean(item)).slice(0, 20),
  };
}

// A page's own JSON-LD is a deliberate, structured declaration of what a
// business offers -- schema.org's `serviceType` and `makesOffer` are the
// standard places a site states this -- so this is a real, deterministic
// signal for the services/tags gap, not a guess the way matching a photo to
// a package title would be.
export function extractServiceTagsFromJsonLd(jsonLd: unknown[]): string[] {
  const objects = jsonLd.flatMap(objectsFrom);
  const business = objects.find(object => typeMatches(object['@type'])) ?? objects.find(object => text(object.name));
  if (!business) return [];

  const tags: string[] = [];
  const serviceType = business.serviceType;
  const serviceTypes = Array.isArray(serviceType) ? serviceType : [serviceType];
  for (const value of serviceTypes) {
    const tagText = text(value);
    if (tagText) tags.push(tagText);
  }

  const makesOffer = business.makesOffer;
  const offers = Array.isArray(makesOffer) ? makesOffer : [makesOffer];
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue;
    const offerObject = offer as Record<string, unknown>;
    const itemOffered = offerObject.itemOffered;
    const itemName = itemOffered && typeof itemOffered === 'object' && !Array.isArray(itemOffered)
      ? text((itemOffered as Record<string, unknown>).name)
      : null;
    const name = itemName ?? text(offerObject.name);
    if (name) tags.push(name);
  }

  return tags;
}
