/**
 * HTML content-type detection and body extraction.
 */

export function isHtmlContentType(contentType: string | null): boolean {
    return contentType !== null && /text\/html|application\/xhtml\+xml/i.test(contentType);
}

/**
 * Extract only the <body> tag content from an HTML string.
 * Falls back to the full document if <body> is not found.
 */
export function extractBody(html: string): string {
    const bodyMatch = html.match(/<body[\s>][\s\S]*?<\/body>/i);
    return bodyMatch ? bodyMatch[0] : html;
}
