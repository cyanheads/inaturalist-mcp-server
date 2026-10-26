/**
 * @fileoverview Independent CommonMark inspection for literal relay assertions.
 * @module tests/helpers/rendering-commonmark
 */
import { type Node, Parser } from 'commonmark';

/** Collect entering nodes without depending on the server's encoders. */
export function markdownNodes(markdown: string): Node[] {
  const nodes: Node[] = [];
  const walker = new Parser().parse(markdown).walker();
  for (let event = walker.next(); event; event = walker.next()) {
    if (event.entering) nodes.push(event.node);
  }
  return nodes;
}

/** Reconstruct inline text, retaining CommonMark line breaks as LF. */
export function markdownText(markdown: string): string {
  return markdownNodes(markdown)
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') return node.literal ?? '';
      return node.type === 'linebreak' || node.type === 'softbreak' ? '\n' : '';
    })
    .join('');
}
