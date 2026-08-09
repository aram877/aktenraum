/**
 * Paragraph-aware text chunker for the RAG indexing pipeline.
 *
 * Splits a document's OCR'd text into chunks suitable for embedding. The
 * strategy (see docs/plans/rag-phase-1.md on the Python side):
 *
 *   1. Normalise whitespace, then split on paragraph boundaries
 *      (double-newline, with >=1 blank line between).
 *   2. Pack paragraphs greedily into chunks until adding another would
 *      exceed the target token budget.
 *   3. If a single paragraph alone exceeds the budget (rare — long
 *      contract clauses, tables flattened by OCR), fall back to
 *      sentence-level splitting on `[.!?]+` followed by whitespace.
 *      German-aware in the sense that we never split on "Z. B." or
 *      similar abbreviations — we require the punctuation to be followed
 *      by whitespace + an uppercase letter or digit.
 *   4. Add an overlap between adjacent chunks, expressed in tokens, by
 *      prepending a tail of the previous chunk to the next. This
 *      preserves cross-boundary context so an answer that straddles a
 *      chunk boundary stays retrievable.
 *
 * Token counting is approximate: whitespace-split words are the unit,
 * same trade-off as the Python side — pulling in a real tokenizer just
 * for length estimation isn't worth it, and the embedding model's context
 * window dwarfs the ~500-token target regardless.
 *
 * Pure function, no I/O. Caller is responsible for embedding and storing
 * the chunks.
 */

// Target chunk size in approximate tokens (= whitespace-split words). 500 is
// the sweet spot per the RAG Phase 1 design: small enough that a single
// answer-relevant excerpt isn't diluted by surrounding context, large enough
// that paragraph-level reasoning survives.
export const DEFAULT_TARGET_TOKENS = 500;

// Token overlap between adjacent chunks. ~10% of target. Preserves answers
// that straddle a paragraph boundary — without overlap, a sentence split
// across chunks #3 and #4 would be retrieved by neither half-context.
export const DEFAULT_OVERLAP_TOKENS = 50;

// Minimum chunk size in tokens. Avoids single-word "stub" chunks that would
// be embedded as noise. Drops chunks below this threshold.
export const MIN_CHUNK_TOKENS = 5;

/**
 * One chunk of text ready for embedding.
 *
 * `index` is monotonically increasing within a document; the indexer stores
 * (docId, index) as the primary key in Qdrant. `charStart`/`charEnd`
 * reference the original text the chunker received, which lets the SPA
 * highlight the exact span when rendering a citation. `tokenCount` is the
 * same approximate count the chunker used internally.
 */
export interface Chunk {
  readonly index: number;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenCount: number;
}

export interface ChunkTextOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/**
 * Split `text` into paragraph-aware overlapping chunks.
 *
 * Returns an empty array if the input is empty or contains only whitespace.
 * Otherwise every chunk has tokenCount >= MIN_CHUNK_TOKENS so the embedder
 * never sees stubs.
 *
 * Throws on configuration mistakes (target < overlap, or either being
 * non-positive) — these are programmer errors, not runtime conditions, so
 * we surface them loudly.
 */
export function chunkText(text: string, options: ChunkTextOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  if (targetTokens <= 0) {
    throw new Error(`targetTokens must be positive, got ${targetTokens}`);
  }
  if (overlapTokens < 0) {
    throw new Error(`overlapTokens must be non-negative, got ${overlapTokens}`);
  }
  if (overlapTokens >= targetTokens) {
    throw new Error(
      `overlapTokens (${overlapTokens}) must be < targetTokens (${targetTokens}) — otherwise chunks never advance`,
    );
  }

  const normalised = normalise(text);
  if (!normalised) return [];

  const paragraphs = splitParagraphs(normalised);

  // First pass: pack paragraphs into chunks. A paragraph that alone exceeds
  // the target is split into sentences, which are then packed the same way.
  // Each piece carries its char-offsets in the original text so the
  // chunk's charStart/charEnd stay accurate.
  const pieces: Piece[] = [];
  for (const para of paragraphs) {
    if (countTokens(para.text) <= targetTokens) {
      pieces.push(para);
    } else {
      pieces.push(...splitIntoSentences(para));
    }
  }

  const rawChunks = pack(pieces, targetTokens);

  // Second pass: prepend overlap tails. Done as a separate pass so the
  // first pass stays a pure pack — easier to reason about and easier to
  // test. The overlap text comes from the *previous* chunk's tail; its
  // char range starts inside the previous chunk.
  const final: Chunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i]!;
    let textWithOverlap: string;
    let charStart: number;
    if (i === 0 || overlapTokens === 0) {
      textWithOverlap = raw.text;
      charStart = raw.charStart;
    } else {
      const prev = rawChunks[i - 1]!;
      const tail = lastNTokens(prev.text, overlapTokens);
      if (tail) {
        textWithOverlap = tail + " " + raw.text;
        // charStart moves backward into the previous chunk by the length
        // of the tail, so highlights still land inside the original text.
        const tailOffset = tail.length + 1; // +1 for the joining space
        charStart = raw.charStart - tailOffset;
        // Defensive: if the previous chunk doesn't actually have that
        // many leading characters available, fall back to its boundary
        // rather than producing a negative offset.
        if (charStart < prev.charStart) charStart = prev.charStart;
      } else {
        textWithOverlap = raw.text;
        charStart = raw.charStart;
      }
    }
    const tokenCount = countTokens(textWithOverlap);
    // MIN_CHUNK_TOKENS exists to filter out overlap-only stub chunks (which
    // would happen if `pack` ever emitted a tiny remainder). It must NOT
    // drop the only chunk of a very short document — a one-line CV is
    // still a document worth indexing. So we only apply the threshold when
    // there's at least one other chunk already accepted; the first chunk
    // always lands.
    if (final.length > 0 && tokenCount < MIN_CHUNK_TOKENS) continue;
    // Frozen: chunks travel through the indexing pipeline by reference;
    // freezing prevents accidental mutation downstream (mirrors the
    // Python side's `@dataclass(frozen=True)`).
    final.push(
      Object.freeze({
        index: final.length,
        text: textWithOverlap,
        charStart,
        charEnd: raw.charEnd,
        tokenCount,
      }),
    );
  }
  return final;
}

// ---- internals -------------------------------------------------------------

/**
 * A unit of text emitted by the splitters. Carries its char-offsets in the
 * original (post-normalisation) string so the chunker can reconstruct
 * accurate spans for the final Chunks.
 */
interface Piece {
  text: string;
  charStart: number;
  charEnd: number;
}

const WHITESPACE_RUN = /[ \t]+/g;
const TRAILING_SPACES = / +(?=\n)/g;
const PARAGRAPH_BREAK = /\n\s*\n+/g;
// Sentence boundary: terminator + whitespace + a capitalised "next sentence"
// starter. The lookahead requires the next non-space character to be an
// uppercase letter or a digit (catches "Es waren 3. Bemerkenswerte ..."),
// which avoids false splits on German abbreviations like "Z. B." or "u. a.".
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/g;

/**
 * Trim, collapse interior runs of horizontal whitespace, and strip trailing
 * spaces before linebreaks. Leaves vertical structure (paragraph breaks)
 * intact — that's what splitParagraphs keys on.
 */
function normalise(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  out = out.replace(TRAILING_SPACES, "");
  out = out.replace(WHITESPACE_RUN, " ");
  return out.trim();
}

/** Split on `\n\s*\n` boundaries; emit non-empty pieces with offsets. */
function splitParagraphs(text: string): Piece[] {
  const out: Piece[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    const matchStart = match.index!;
    const para = text.slice(cursor, matchStart).trim();
    if (para) {
      // The .trim() above may have trimmed a few chars; recover the actual
      // span by searching for the trimmed text inside the slice.
      const sliceText = text.slice(cursor, matchStart);
      const innerStart = sliceText.indexOf(para);
      const start = cursor + innerStart;
      out.push({ text: para, charStart: start, charEnd: start + para.length });
    }
    cursor = matchStart + match[0].length;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const sliceText = text.slice(cursor);
    const innerStart = sliceText.indexOf(tail);
    const start = cursor + innerStart;
    out.push({ text: tail, charStart: start, charEnd: start + tail.length });
  }
  return out;
}

/**
 * Sentence-split a paragraph that's too large to fit a single chunk.
 *
 * Falls back to returning the whole piece as one sentence if no sentence
 * boundary is found (single very long sentence — preserve rather than
 * truncate; the embedder will handle a long input by truncating to its
 * model context, which is still better than chopping mid-word).
 */
function splitIntoSentences(piece: Piece): Piece[] {
  const text = piece.text;
  const boundaries: number[] = [];
  for (const m of text.matchAll(SENTENCE_BREAK)) {
    boundaries.push(m.index!);
  }
  if (boundaries.length === 0) return [piece];

  const out: Piece[] = [];
  let cursor = 0;
  const base = piece.charStart;
  for (const boundary of boundaries) {
    const seg = text.slice(cursor, boundary).trim();
    if (seg) {
      const sliceText = text.slice(cursor, boundary);
      const innerStart = sliceText.indexOf(seg);
      const start = base + cursor + innerStart;
      out.push({ text: seg, charStart: start, charEnd: start + seg.length });
    }
    cursor = boundary + 1; // skip the whitespace at the match boundary
    // SENTENCE_BREAK matches on whitespace, of variable length; advance
    // cursor past any contiguous whitespace.
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const sliceText = text.slice(cursor);
    const innerStart = sliceText.indexOf(tail);
    const start = base + cursor + innerStart;
    out.push({ text: tail, charStart: start, charEnd: start + tail.length });
  }
  return out;
}

/** A pre-overlap chunk. Just `pack`'s output. */
interface RawChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Greedily pack pieces into chunks not exceeding `targetTokens`.
 *
 * Each pack starts a new chunk when adding the next piece would overshoot.
 * A piece that is already larger than the target on its own (post-sentence-
 * splitting still oversize — i.e. a single monstrous sentence) is emitted
 * as its own chunk so we never silently drop content.
 */
function pack(pieces: Piece[], targetTokens: number): RawChunk[] {
  const out: RawChunk[] = [];
  let bufPieces: Piece[] = [];
  let bufTokens = 0;
  for (const p of pieces) {
    const pTokens = countTokens(p.text);
    if (bufPieces.length > 0 && bufTokens + pTokens > targetTokens) {
      out.push(flush(bufPieces));
      bufPieces = [];
      bufTokens = 0;
    }
    bufPieces.push(p);
    bufTokens += pTokens;
  }
  if (bufPieces.length > 0) out.push(flush(bufPieces));
  return out;
}

function flush(pieces: Piece[]): RawChunk {
  return {
    text: pieces.map((p) => p.text).join("\n\n"),
    charStart: pieces[0]!.charStart,
    charEnd: pieces[pieces.length - 1]!.charEnd,
  };
}

/**
 * Approximate token count via whitespace-split. See module docstring —
 * intentionally lighter than running a real tokenizer because we only need
 * length estimation, not actual tokenization.
 */
function countTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Return the last `n` tokens of `text`. Used to build overlap tails. */
function lastNTokens(text: string, n: number): string {
  if (n <= 0) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const words = trimmed.split(/\s+/);
  return words.slice(-n).join(" ");
}
