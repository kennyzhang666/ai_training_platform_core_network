const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'template']);
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code']);

/**
 * The challenge description is authored by administrators, but is displayed
 * to every participant. Keep the stored HTML deliberately small and remove
 * executable content before it reaches the API or the DOM.
 */
export function sanitizeRichText(value: string): string {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') {
    return value
      .replace(/<\s*(script|style|iframe|object|embed|form|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<[^>]*>/g, '');
  }
  const document = new DOMParser().parseFromString(value, 'text/html');
  document.body.querySelectorAll('*').forEach((node) => {
    const tag = node.tagName.toLowerCase();
    if (BLOCKED_TAGS.has(tag)) {
      node.remove();
      return;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
  });
  return document.body.innerHTML.trim();
}

export function richTextPreview(value: string): string {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const document = new DOMParser().parseFromString(sanitizeRichText(value), 'text/html');
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}
