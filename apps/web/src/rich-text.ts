const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'template']);
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'img']);

/**
 * Images are embedded in the challenge description instead of being linked
 * from an arbitrary remote host. Keeping the limit small also prevents a
 * pasted image from turning an otherwise lightweight challenge record into a
 * multi-megabyte API request.
 */
export const RICH_TEXT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const RICH_TEXT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const RICH_TEXT_IMAGE_MAX_DATA_URL_LENGTH = Math.ceil(RICH_TEXT_IMAGE_MAX_BYTES / 3) * 4 + 64;

function safeImageDataUrl(value: string): boolean {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !RICH_TEXT_IMAGE_MIME_TYPES.has(match[1])) return false;
  return match[0].length <= RICH_TEXT_IMAGE_MAX_DATA_URL_LENGTH;
}

function detectedImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 24
    && bytes.subarray(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
    && bytes.subarray(12, 16).every((value, index) => value === [0x49, 0x48, 0x44, 0x52][index])) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 20
    && bytes.subarray(0, 4).every((value, index) => value === [0x52, 0x49, 0x46, 0x46][index])
    && bytes.subarray(8, 12).every((value, index) => value === [0x57, 0x45, 0x42, 0x50][index])) return 'image/webp';
  return null;
}

/** Read and validate a local image before inserting it into the editor. */
export async function readRichTextImage(file: File): Promise<{ dataUrl: string; alt: string }> {
  if (!file || file.size <= 0) throw new Error('图片文件不能为空');
  if (file.size > RICH_TEXT_IMAGE_MAX_BYTES) throw new Error('图片不能超过 2 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectedImageMime(bytes);
  if (!mime || (file.type && file.type.toLowerCase() !== mime)) throw new Error('仅支持有效的 PNG、JPEG 或 WebP 图片');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
  if (!safeImageDataUrl(dataUrl)) throw new Error('图片内容无效或超过大小限制');
  const alt = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 120) || '赛题图片';
  return { dataUrl, alt };
}

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
    if (tag === 'img') {
      const source = node.getAttribute('src') ?? '';
      if (!safeImageDataUrl(source)) {
        node.remove();
        return;
      }
      const alt = (node.getAttribute('alt') ?? '').trim().slice(0, 120);
      [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
      node.setAttribute('src', source);
      if (alt) node.setAttribute('alt', alt);
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
  const text = document.body.textContent ?? '';
  const imageAlt = [...document.body.querySelectorAll('img')].map((image) => image.getAttribute('alt') ?? '').join(' ');
  return `${text} ${imageAlt}`.replace(/\s+/g, ' ').trim();
}
