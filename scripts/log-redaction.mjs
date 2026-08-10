export function truncateUtf8Bytes(value, maxBytes) {
  const encoded = Buffer.from(String(value ?? ''), 'utf8');
  let end = Math.max(0, Math.min(encoded.length, Math.floor(maxBytes)));
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

/** Redact common credentials before Worker diagnostics leave the process. */
export function redactLogText(value, maxBytes = 8192) {
  let text = String(value ?? '');
  text = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|proxy-authorization)\s+bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:"?(?:authorization|proxy-authorization|token|access[_-]?token|api[_-]?key|secret|password|cookie|credential)"?)\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/((?:token|access[_-]?token|api[_-]?key|secret|password|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  return `${truncateUtf8Bytes(text, maxBytes)}…[TRUNCATED]`;
}
