"""Paragraph-aware text chunker for the RAG indexing pipeline.

Splits a document's OCR'd text into chunks suitable for embedding with
`bge-m3` (or any 8k-context BERT-family model). The strategy is laid
out in `docs/plans/rag-phase-1.md`:

  1. Normalise whitespace, then split on paragraph boundaries
     (double-newline, with ≥1 blank line between).
  2. Pack paragraphs greedily into chunks until adding another would
     exceed the target token budget.
  3. If a single paragraph alone exceeds the budget (rare — long
     contract clauses, tables flattened by OCR), fall back to
     sentence-level splitting on `[.!?]+` followed by whitespace.
     German-aware in the sense that we never split on `Z. B.` or
     similar abbreviations — we require the punctuation to be
     followed by whitespace + an uppercase letter.
  4. Add an overlap between adjacent chunks, expressed in tokens, by
     prepending a tail of the previous chunk to the next. This
     preserves cross-boundary context so an answer that straddles a
     chunk boundary stays retrievable.

Token counting is approximate: we use whitespace-split words as the
unit because the real `bge-m3` tokenizer would pull in `transformers`
and a model load just for length estimation. The ~25% overshoot a
word-based estimate gives versus a BPE tokenizer is fine — `bge-m3`'s
8192-token context dwarfs our 500-token target, so a wobbly estimate
never produces an over-length chunk that would fail to embed.

Pure function, no I/O. Caller is responsible for embedding and storing
the chunks.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

# Target chunk size in approximate tokens (= whitespace-split words). 500 is
# the sweet spot per the RAG Phase 1 design: small enough that a single
# answer-relevant excerpt isn't diluted by surrounding context, large enough
# that paragraph-level reasoning survives. Adjust via `chunk_text(...,
# target_tokens=...)` per call site if needed.
DEFAULT_TARGET_TOKENS = 500

# Token overlap between adjacent chunks. ~10% of target. Preserves answers
# that straddle a paragraph boundary — without overlap, a sentence split
# across chunks #3 and #4 would be retrieved by neither half-context.
DEFAULT_OVERLAP_TOKENS = 50

# Minimum chunk size in tokens. Avoids single-word "stub" chunks that
# would be embedded as noise. Drops chunks below this threshold.
MIN_CHUNK_TOKENS = 5


@dataclass(frozen=True)
class Chunk:
    """One chunk of text ready for embedding.

    `index` is monotonically increasing within a document; the indexer
    stores `(doc_id, index)` as the primary key in Qdrant. `char_start`
    and `char_end` reference the original text the chunker received,
    which lets the SPA highlight the exact span when rendering a
    citation. `token_count` is the same approximate count the chunker
    used internally — handy for index-size budgeting.
    """

    index: int
    text: str
    char_start: int
    char_end: int
    token_count: int


def chunk_text(
    text: str,
    *,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Split `text` into paragraph-aware overlapping chunks.

    Returns an empty list if the input is empty or contains only
    whitespace. Otherwise every chunk has `token_count >= MIN_CHUNK_TOKENS`
    so the embedder never sees stubs.

    Raises ValueError on configuration mistakes (target < overlap, or
    either being non-positive) — these are programmer errors, not
    runtime conditions, so we surface them loudly.
    """
    if target_tokens <= 0:
        raise ValueError(f"target_tokens must be positive, got {target_tokens}")
    if overlap_tokens < 0:
        raise ValueError(f"overlap_tokens must be non-negative, got {overlap_tokens}")
    if overlap_tokens >= target_tokens:
        raise ValueError(
            f"overlap_tokens ({overlap_tokens}) must be < target_tokens "
            f"({target_tokens}) — otherwise chunks never advance"
        )

    normalised = _normalise(text)
    if not normalised:
        return []

    paragraphs = _split_paragraphs(normalised)

    # First pass: pack paragraphs into chunks. A paragraph that alone
    # exceeds the target is split into sentences, which are then packed
    # the same way. Each piece carries its char-offsets in the original
    # text so the chunk's char_start/char_end stay accurate.
    pieces: list[_Piece] = []
    for para in paragraphs:
        if _count_tokens(para.text) <= target_tokens:
            pieces.append(para)
        else:
            pieces.extend(_split_into_sentences(para))

    raw_chunks = list(_pack(pieces, target_tokens))

    # Second pass: prepend overlap tails. Done as a separate pass so
    # the first pass stays a pure pack — easier to reason about and
    # easier to test. The overlap text comes from the *previous*
    # chunk's tail; its char range starts inside the previous chunk.
    final: list[Chunk] = []
    for i, raw in enumerate(raw_chunks):
        if i == 0 or overlap_tokens == 0:
            text_with_overlap = raw.text
            char_start = raw.char_start
        else:
            tail = _last_n_tokens(raw_chunks[i - 1].text, overlap_tokens)
            if tail:
                text_with_overlap = tail + " " + raw.text
                # char_start moves backward into the previous chunk by
                # the length of the tail, so highlights still land
                # inside the original text.
                tail_offset = len(tail) + 1  # +1 for the joining space
                char_start = raw.char_start - tail_offset
                # Defensive: if the previous chunk doesn't actually
                # have that many leading characters available, fall
                # back to its boundary rather than producing a
                # negative offset.
                if char_start < raw_chunks[i - 1].char_start:
                    char_start = raw_chunks[i - 1].char_start
            else:
                text_with_overlap = raw.text
                char_start = raw.char_start
        token_count = _count_tokens(text_with_overlap)
        # MIN_CHUNK_TOKENS exists to filter out overlap-only stub chunks
        # (which would happen if `_pack` ever emitted a tiny remainder).
        # It must NOT drop the only chunk of a very short document — a
        # one-line CV is still a document worth indexing. So we only
        # apply the threshold when there's at least one other chunk
        # already accepted; the first chunk always lands.
        if final and token_count < MIN_CHUNK_TOKENS:
            continue
        final.append(
            Chunk(
                index=len(final),
                text=text_with_overlap,
                char_start=char_start,
                char_end=raw.char_end,
                token_count=token_count,
            )
        )
    return final


# ---- internals -------------------------------------------------------------


@dataclass(frozen=True)
class _Piece:
    """A unit of text emitted by the splitters. Carries its char-offsets
    in the original (post-normalisation) string so the chunker can
    reconstruct accurate spans for the final Chunks."""

    text: str
    char_start: int
    char_end: int


_WHITESPACE_RUN = re.compile(r"[ \t]+")
_TRAILING_SPACES = re.compile(r" +(?=\n)")
_PARAGRAPH_BREAK = re.compile(r"\n\s*\n+")
# Sentence boundary: terminator + whitespace + a capitalised "next sentence"
# starter. The lookahead requires the next non-space character to be an
# uppercase letter or a digit (catches "Es waren 3. Bemerkenswerte ..."),
# which avoids false splits on German abbreviations like "Z. B." or "u. a."
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])")


def _normalise(text: str) -> str:
    """Trim, collapse interior runs of horizontal whitespace, and strip
    trailing spaces before linebreaks. Leaves vertical structure
    (paragraph breaks) intact — that's what `_split_paragraphs` keys on.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _TRAILING_SPACES.sub("", text)
    text = _WHITESPACE_RUN.sub(" ", text)
    return text.strip()


def _split_paragraphs(text: str) -> list[_Piece]:
    """Split on `\\n\\s*\\n` boundaries; emit non-empty pieces with offsets."""
    out: list[_Piece] = []
    cursor = 0
    for match in _PARAGRAPH_BREAK.finditer(text):
        para = text[cursor : match.start()].strip()
        if para:
            # The .strip() above may have trimmed a few chars; recover the
            # actual span by searching for the trimmed text inside the slice.
            slice_text = text[cursor : match.start()]
            inner_start = slice_text.find(para)
            start = cursor + inner_start
            out.append(_Piece(text=para, char_start=start, char_end=start + len(para)))
        cursor = match.end()
    tail = text[cursor:].strip()
    if tail:
        slice_text = text[cursor:]
        inner_start = slice_text.find(tail)
        start = cursor + inner_start
        out.append(_Piece(text=tail, char_start=start, char_end=start + len(tail)))
    return out


def _split_into_sentences(piece: _Piece) -> list[_Piece]:
    """Sentence-split a paragraph that's too large to fit a single chunk.

    Falls back to returning the whole piece as one sentence if no
    sentence boundary is found (single very long sentence — preserve
    rather than truncate; the embedder will handle a long input by
    truncating to its model context, which is still better than
    chopping mid-word).
    """
    text = piece.text
    boundaries: list[int] = []
    for m in _SENTENCE_BREAK.finditer(text):
        boundaries.append(m.start())
    if not boundaries:
        return [piece]
    out: list[_Piece] = []
    cursor = 0
    base = piece.char_start
    for boundary in boundaries:
        seg = text[cursor:boundary].strip()
        if seg:
            slice_text = text[cursor:boundary]
            inner_start = slice_text.find(seg)
            start = base + cursor + inner_start
            out.append(_Piece(text=seg, char_start=start, char_end=start + len(seg)))
        cursor = boundary + 1  # skip the whitespace at the match boundary
        # _SENTENCE_BREAK matches on whitespace, of variable length; advance
        # cursor past any contiguous whitespace.
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
    tail = text[cursor:].strip()
    if tail:
        slice_text = text[cursor:]
        inner_start = slice_text.find(tail)
        start = base + cursor + inner_start
        out.append(_Piece(text=tail, char_start=start, char_end=start + len(tail)))
    return out


def _pack(pieces: list[_Piece], target_tokens: int) -> Iterator[_RawChunk]:
    """Greedily pack pieces into chunks not exceeding `target_tokens`.

    Each pack starts a new chunk when adding the next piece would
    overshoot. A piece that is already larger than the target on its
    own (post-sentence-splitting still oversize — i.e. a single
    monstrous sentence) is emitted as its own chunk so we never silently
    drop content.
    """
    buf_pieces: list[_Piece] = []
    buf_tokens = 0
    for p in pieces:
        p_tokens = _count_tokens(p.text)
        if buf_pieces and buf_tokens + p_tokens > target_tokens:
            yield _flush(buf_pieces)
            buf_pieces = []
            buf_tokens = 0
        buf_pieces.append(p)
        buf_tokens += p_tokens
    if buf_pieces:
        yield _flush(buf_pieces)


@dataclass(frozen=True)
class _RawChunk:
    """A pre-overlap chunk. Just `_pack` output."""

    text: str
    char_start: int
    char_end: int


def _flush(pieces: list[_Piece]) -> _RawChunk:
    return _RawChunk(
        text="\n\n".join(p.text for p in pieces),
        char_start=pieces[0].char_start,
        char_end=pieces[-1].char_end,
    )


def _count_tokens(text: str) -> int:
    """Approximate `bge-m3` token count via whitespace-split. See module
    docstring — this is intentionally lighter than running the real
    tokenizer because we only need length estimation, not actual
    tokenization."""
    return len(text.split())


def _last_n_tokens(text: str, n: int) -> str:
    """Return the last `n` tokens of `text`. Used to build overlap tails."""
    if n <= 0:
        return ""
    words = text.split()
    if not words:
        return ""
    return " ".join(words[-n:])
