/**
 * LA County, split into the search areas the Google Maps lane (GTM-12)
 * scrapes one by one. Google Maps returns at most ~120 places per search, so
 * the City of Los Angeles is split into its main districts and the rest of
 * the county is searched city by city. Each area becomes one search string:
 * "property management in <query>".
 *
 * `region` only groups areas for display and for scraping part of the county.
 */

export interface MapsArea {
  /** Stable id (lowercase, hyphens): what a caller passes to pick areas. */
  id: string
  /** What follows "in" in the search string. */
  query: string
  region: MapsRegion
}

export const MAPS_REGIONS = ['la-city', 'westside', 'south-bay', 'gateway', 'sgv', 'valleys', 'north-county'] as const
export type MapsRegion = (typeof MAPS_REGIONS)[number]

const a = (id: string, query: string, region: MapsRegion): MapsArea => ({ id, query, region })

export const LA_COUNTY_AREAS: readonly MapsArea[] = [
  // City of Los Angeles, by district
  a('downtown-la', 'Downtown Los Angeles, CA', 'la-city'),
  a('hollywood', 'Hollywood, Los Angeles, CA', 'la-city'),
  a('koreatown', 'Koreatown, Los Angeles, CA', 'la-city'),
  a('westwood', 'Westwood, Los Angeles, CA', 'la-city'),
  a('west-la', 'West Los Angeles, CA', 'la-city'),
  a('venice', 'Venice, Los Angeles, CA', 'la-city'),
  a('silver-lake', 'Silver Lake, Los Angeles, CA', 'la-city'),
  a('south-la', 'South Los Angeles, CA', 'la-city'),
  a('san-pedro', 'San Pedro, Los Angeles, CA', 'la-city'),
  a('sherman-oaks', 'Sherman Oaks, CA', 'la-city'),
  a('studio-city', 'Studio City, CA', 'la-city'),
  a('van-nuys', 'Van Nuys, CA', 'la-city'),
  a('north-hollywood', 'North Hollywood, CA', 'la-city'),
  a('encino', 'Encino, CA', 'la-city'),
  a('woodland-hills', 'Woodland Hills, CA', 'la-city'),
  a('northridge', 'Northridge, CA', 'la-city'),
  // Westside
  a('santa-monica', 'Santa Monica, CA', 'westside'),
  a('beverly-hills', 'Beverly Hills, CA', 'westside'),
  a('west-hollywood', 'West Hollywood, CA', 'westside'),
  a('culver-city', 'Culver City, CA', 'westside'),
  a('marina-del-rey', 'Marina del Rey, CA', 'westside'),
  a('malibu', 'Malibu, CA', 'westside'),
  // South Bay
  a('torrance', 'Torrance, CA', 'south-bay'),
  a('redondo-beach', 'Redondo Beach, CA', 'south-bay'),
  a('manhattan-beach', 'Manhattan Beach, CA', 'south-bay'),
  a('el-segundo', 'El Segundo, CA', 'south-bay'),
  a('inglewood', 'Inglewood, CA', 'south-bay'),
  a('gardena', 'Gardena, CA', 'south-bay'),
  a('carson', 'Carson, CA', 'south-bay'),
  a('long-beach', 'Long Beach, CA', 'south-bay'),
  // Gateway cities
  a('downey', 'Downey, CA', 'gateway'),
  a('whittier', 'Whittier, CA', 'gateway'),
  a('norwalk', 'Norwalk, CA', 'gateway'),
  a('lakewood', 'Lakewood, CA', 'gateway'),
  a('cerritos', 'Cerritos, CA', 'gateway'),
  // San Gabriel Valley
  a('pasadena', 'Pasadena, CA', 'sgv'),
  a('arcadia', 'Arcadia, CA', 'sgv'),
  a('alhambra', 'Alhambra, CA', 'sgv'),
  a('el-monte', 'El Monte, CA', 'sgv'),
  a('west-covina', 'West Covina, CA', 'sgv'),
  a('pomona', 'Pomona, CA', 'sgv'),
  a('glendora', 'Glendora, CA', 'sgv'),
  // Valleys (outside LA city)
  a('glendale', 'Glendale, CA', 'valleys'),
  a('burbank', 'Burbank, CA', 'valleys'),
  a('calabasas', 'Calabasas, CA', 'valleys'),
  // North county
  a('santa-clarita', 'Santa Clarita, CA', 'north-county'),
  a('lancaster', 'Lancaster, CA', 'north-county'),
  a('palmdale', 'Palmdale, CA', 'north-county'),
]

/**
 * The areas to search: all of LA County, or only the given ids / regions.
 * Unknown ids are returned in `unknown` so a caller can refuse them instead
 * of silently scraping less than asked.
 */
export function pickAreas(sel: { ids?: readonly string[]; regions?: readonly string[] } = {}): { areas: MapsArea[]; unknown: string[] } {
  const ids = (sel.ids ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const regions = (sel.regions ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!ids.length && !regions.length) return { areas: [...LA_COUNTY_AREAS], unknown: [] }
  const known = new Set(LA_COUNTY_AREAS.map((x) => x.id))
  const knownRegions = new Set<string>(MAPS_REGIONS)
  const unknown = [...ids.filter((id) => !known.has(id)), ...regions.filter((r) => !knownRegions.has(r))]
  const want = new Set(ids)
  const wantRegions = new Set(regions)
  const areas = LA_COUNTY_AREAS.filter((x) => want.has(x.id) || wantRegions.has(x.region))
  return { areas, unknown }
}
