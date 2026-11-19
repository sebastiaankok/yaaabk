import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Renders Markdown from a Plan, Issue or agent review to sanitized HTML.
 *
 * This content comes from the AI or GitHub, so it is never trusted as HTML:
 * `marked` parses the Markdown, then `DOMPurify` removes anything that could
 * execute. The helper is only called in the browser, where the Markdown is shown.
 */
export function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown) as string);
}
