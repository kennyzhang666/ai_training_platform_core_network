/**
 * Audit records are operational evidence, not a copy of the audited entity.
 *
 * Two fields make a raw copy unbounded: `avatarDataUrl` carries up to 256 KiB
 * of base64, and a rich-text challenge description carries embedded images up
 * to 8 MiB. Storing those verbatim made a single audit row hundreds of
 * kilobytes, and because the whole audit table is loaded into the process
 * snapshot, every request then paid to clone them.
 *
 * Keep the shape and the small scalar fields — which is what an auditor reads
 * — and replace bulk payloads with a size marker.
 */

/** Field names whose value is never evidence, only bulk. */
const DROPPED_KEYS = new Set(['avatarDataUrl']);
const MAX_STRING_BYTES = 1024;
const MAX_ARRAY_ITEMS = 100;
const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_DEPTH = 12;

function marker(bytes: number, reason: string): string {
  return `[audit:${reason} ${bytes} bytes omitted]`;
}

function redactString(value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_STRING_BYTES) return value;
  // Keep a readable head so a reviewer can still recognise the value.
  return `${value.slice(0, 256)}… ${marker(bytes, 'truncated')}`;
}

function walk(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return marker(0, 'depth-limit');
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(marker(value.length - MAX_ARRAY_ITEMS, 'items'));
    return items;
  }
  if (typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key)) {
      if (typeof item === 'string' && item) result[key] = marker(Buffer.byteLength(item, 'utf8'), 'dropped');
      else if (item !== undefined) result[key] = item;
      continue;
    }
    const redacted = walk(item, depth + 1);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

/**
 * Return an audit-safe projection of a before/after payload. The input is not
 * mutated; callers may pass a live domain object.
 */
export function redactAuditPayload<T>(value: T): T {
  if (value === undefined) return value;
  const redacted = walk(value, 0) as T;
  // A deeply nested record can still add up. Fall back to a summary rather
  // than letting one audit row dominate the table.
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted) ?? '';
  } catch {
    return marker(0, 'unserializable') as unknown as T;
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_TOTAL_BYTES) return redacted;
  return marker(bytes, 'oversized') as unknown as T;
}
