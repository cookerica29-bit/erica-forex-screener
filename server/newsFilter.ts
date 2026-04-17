// Maps OANDA pair names to the currency codes to check for news events.
// Metals use only USD since their news is driven by USD events.
const PAIR_CURRENCIES: Record<string, string[]> = {
  // Majors
  EUR_USD: ['EUR', 'USD'],
  GBP_USD: ['GBP', 'USD'],
  USD_JPY: ['USD', 'JPY'],
  USD_CAD: ['USD', 'CAD'],
  USD_CHF: ['USD', 'CHF'],
  AUD_USD: ['AUD', 'USD'],
  NZD_USD: ['NZD', 'USD'],
  // JPY crosses
  EUR_JPY: ['EUR', 'JPY'],
  GBP_JPY: ['GBP', 'JPY'],
  AUD_JPY: ['AUD', 'JPY'],
  NZD_JPY: ['NZD', 'JPY'],
  CAD_JPY: ['CAD', 'JPY'],
  // Other crosses
  EUR_GBP: ['EUR', 'GBP'],
  EUR_AUD: ['EUR', 'AUD'],
  // Metals — driven by USD events
  XAU_USD: ['USD'],
  XAG_USD: ['USD'],
};

let _cachedEvents: any[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchNewsEvents(): Promise<any[]> {
  const now = Date.now();
  if (_cachedEvents && now - _cacheTime < CACHE_TTL_MS) return _cachedEvents;
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return _cachedEvents || [];
    _cachedEvents = await res.json() as any[];
    _cacheTime = now;
    return _cachedEvents;
  } catch {
    return _cachedEvents || [];
  }
}

/**
 * Returns true if any high-impact news event is scheduled within the
 * lookahead window (default 4 hours) for either currency in the pair.
 * Also flags events within the past 1 hour (chop risk after release).
 * Fails safe: returns false on error.
 */
export async function checkNewsRisk(pair: string, lookaheadHours = 4): Promise<boolean> {
  try {
    const currencies = PAIR_CURRENCIES[pair];
    if (!currencies || !currencies.length) return false;

    const events = await fetchNewsEvents();
    const now = Date.now();
    const lookaheadMs = lookaheadHours * 60 * 60 * 1000;
    const lookbackMs = 60 * 60 * 1000; // 1 hour back

    for (const event of events) {
      if (event.impact !== 'High') continue;
      const country = (event.country || '').toUpperCase();
      if (!currencies.includes(country)) continue;
      try {
        const diffMs = new Date(event.date).getTime() - now;
        if (diffMs >= -lookbackMs && diffMs <= lookaheadMs) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
