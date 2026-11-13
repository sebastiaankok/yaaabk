import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Renders a Plan's Markdown to sanitized HTML.
 *
 * The plan comes from the AI, so it is never trusted as HTML: `marked` parses
 * the Markdown, then `DOMPurify` removes anything that could execute. The
 * helper is only called in the browser, where the plan is shown.
 */
export function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown) as string);
}
