/**
 * An iframe's canvas is transparent only when the iframe element and the document inside it
 * use the same color-scheme; otherwise the browser paints it opaque (white in a dark app). So
 * the host states the live theme's scheme in the widget document, ahead of the widget's own
 * markup, and sets the same scheme on the iframe element.
 */
export type ColorScheme = "dark" | "light";

export function withColorScheme(html: string, scheme: ColorScheme): string {
  const meta = `<meta name="color-scheme" content="${scheme}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + meta + html.slice(doctype[0].length);
  return meta + html;
}
