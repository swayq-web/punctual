/**
 * Redaction for anything that prints a URL into a log. Magic links, manage
 * links and OAuth callbacks carry their secret in the query string (and the
 * fragment), so a log line may name the path and never the query.
 */

/** `https://host/path?token=abc#frag` becomes `https://host/path?[redacted]`. Unparseable input is returned as a placeholder, never echoed. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    const query = u.search ? '?[redacted]' : ''
    return `${u.origin}${u.pathname}${query}`
  } catch {
    return '[unparseable url]'
  }
}

/** Redact the query string and fragment of every http(s) URL inside free text (an error message). */
export function redactUrlsIn(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (m) => redactUrl(m))
}
