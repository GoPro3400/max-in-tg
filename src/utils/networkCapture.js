const EVICT_AGE_MS = 60000;

/**
 * Find the most recent entry in a Map whose timestamp is within maxAgeMs.
 * Each map value must have a `timestamp` property (epoch ms).
 * Entries older than EVICT_AGE_MS are deleted to bound memory growth.
 */
export const findNewestCapture = (map, maxAgeMs = 30000) => {
  if (!map || map.size === 0) return null;
  const now = Date.now();
  let best = null;
  for (const [key, entry] of map) {
    const age = now - entry.timestamp;
    if (age >= EVICT_AGE_MS) {
      map.delete(key);
      continue;
    }
    if (age < maxAgeMs && (!best || entry.timestamp > best.timestamp)) {
      best = entry;
    }
  }
  return best;
};

/**
 * Find the most recent entry and remove it from the Map so it cannot be
 * consumed twice. Used when processing multiple media messages in a single
 * polling batch — each message should get its own unique capture.
 */
export const consumeNewestCapture = (map, maxAgeMs = 30000) => {
  if (!map || map.size === 0) return null;
  const now = Date.now();
  let bestKey = null;
  let best = null;
  for (const [key, entry] of map) {
    const age = now - entry.timestamp;
    if (age >= EVICT_AGE_MS) {
      map.delete(key);
      continue;
    }
    if (age < maxAgeMs && (!best || entry.timestamp > best.timestamp)) {
      bestKey = key;
      best = entry;
    }
  }
  if (bestKey !== null) {
    map.delete(bestKey);
  }
  return best;
};
