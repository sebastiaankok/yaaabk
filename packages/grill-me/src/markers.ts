/**
 * Incremental parser for the structured markers the grill-me skill emits.
 *
 * OpenCode streams stdout in arbitrary chunks, so a marker can be split across
 * two reads. The parser therefore holds back any text that could still turn out
 * to be the start of a marker, and only emits a block once its closing marker
 * has arrived. Nothing inside or before an opening marker leaks as a token.
 */

/** The structured markers the grill-me skill emits. */
export const MARKER_TYPES = ['QUESTION', 'PLAN', 'ISSUES'] as const;

export type MarkerType = (typeof MARKER_TYPES)[number];

/**
 * A piece of parsed output, in the order it appeared:
 * - `token` is raw text outside any marker (used for the live typing effect);
 * - `block` is the trimmed content of a completed marker.
 */
export type ParsedChunk =
  { kind: 'token'; text: string } | { kind: 'block'; type: MarkerType; content: string };

export interface MarkerParser {
  /** Feeds a chunk of stdout, returning everything now unambiguously parseable. */
  push(chunk: string): ParsedChunk[];
  /** Ends the stream, flushing any buffered text as a token. */
  flush(): ParsedChunk[];
}

function openTag(type: MarkerType): string {
  return `<${type}>`;
}

function closeTag(type: MarkerType): string {
  return `</${type}>`;
}

/** The earliest complete opening marker in `buffer`, if any. */
function earliestOpen(buffer: string): { index: number; type: MarkerType } | undefined {
  let found: { index: number; type: MarkerType } | undefined;
  for (const type of MARKER_TYPES) {
    const index = buffer.indexOf(openTag(type));
    if (index !== -1 && (found === undefined || index < found.index)) {
      found = { index, type };
    }
  }
  return found;
}

/**
 * The length of the longest suffix of `buffer` that is a proper prefix of an
 * opening marker — text that must be held back until more input arrives.
 */
function heldBackLength(buffer: string): number {
  let held = 0;
  for (const type of MARKER_TYPES) {
    const tag = openTag(type);
    const max = Math.min(tag.length - 1, buffer.length);
    for (let length = max; length > held; length -= 1) {
      if (buffer.endsWith(tag.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

export function createMarkerParser(): MarkerParser {
  let buffer = '';

  function drain(): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];

    for (;;) {
      const open = earliestOpen(buffer);
      if (open === undefined) {
        const held = heldBackLength(buffer);
        const text = buffer.slice(0, buffer.length - held);
        if (text !== '') {
          chunks.push({ kind: 'token', text });
        }
        buffer = buffer.slice(buffer.length - held);
        return chunks;
      }

      if (open.index > 0) {
        chunks.push({ kind: 'token', text: buffer.slice(0, open.index) });
      }

      const close = closeTag(open.type);
      const start = open.index + openTag(open.type).length;
      const end = buffer.indexOf(close, start);
      if (end === -1) {
        // Keep the whole unfinished block buffered until the closing marker.
        buffer = buffer.slice(open.index);
        return chunks;
      }

      chunks.push({ kind: 'block', type: open.type, content: buffer.slice(start, end) });
      buffer = buffer.slice(end + close.length);
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      return drain();
    },
    flush() {
      const chunks = drain();
      if (buffer !== '') {
        chunks.push({ kind: 'token', text: buffer });
        buffer = '';
      }
      return chunks;
    },
  };
}
