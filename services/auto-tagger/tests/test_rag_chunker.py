"""Unit tests for the RAG chunker — pure-function, no I/O.

Lives under services/auto-tagger/tests by the same convention used for
the other aktenraum-core helpers (CLAUDE.md: "tests for the moved
modules continue to live under services/auto-tagger/tests").
"""

from __future__ import annotations

import pytest
from aktenraum_core.rag import Chunk, chunk_text

# ---- empty / degenerate inputs --------------------------------------------


def test_empty_text_returns_no_chunks():
    assert chunk_text("") == []


def test_whitespace_only_returns_no_chunks():
    assert chunk_text("   \n\n  \t\n") == []


# ---- happy path -----------------------------------------------------------


def test_short_text_yields_single_chunk():
    text = "Mein Lebenslauf. Ich arbeite seit 2022 bei Kopfstand als Frontend Engineer."
    chunks = chunk_text(text)
    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.index == 0
    assert chunk.text == text
    assert chunk.char_start == 0
    assert chunk.char_end == len(text)
    assert chunk.token_count == 11


def test_paragraphs_packed_into_one_chunk_when_under_target():
    text = (
        "Erster Absatz mit ein paar Worten.\n\n"
        "Zweiter Absatz, ebenso kurz.\n\n"
        "Dritter Absatz."
    )
    chunks = chunk_text(text, target_tokens=500)
    assert len(chunks) == 1
    # Paragraph break preserved as `\n\n` between joined paragraphs.
    assert chunks[0].text.count("\n\n") == 2


def test_paragraphs_split_when_over_target():
    # Four paragraphs of ~10 words each. With target_tokens=15 each chunk
    # holds at most one paragraph; with target_tokens=25 it holds two.
    paras = [
        "Eins zwei drei vier fünf sechs sieben acht neun zehn",
        "elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig",
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        "lambda mu nu xi omikron pi rho sigma tau ypsilon",
    ]
    text = "\n\n".join(paras)
    chunks = chunk_text(text, target_tokens=15, overlap_tokens=0)
    # Each paragraph is ~10 tokens; can't fit two (~20) in 15; so 4 chunks.
    assert len(chunks) == 4
    for chunk, para in zip(chunks, paras, strict=True):
        assert chunk.text == para
    # Char offsets must be strictly increasing — no overlap when overlap=0.
    for prev, next_ in zip(chunks, chunks[1:], strict=False):
        assert prev.char_end <= next_.char_start


def test_overlap_prepends_tail_of_previous_chunk():
    paras = [
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        "lambda mu nu xi omikron pi rho sigma tau ypsilon",
    ]
    text = "\n\n".join(paras)
    chunks = chunk_text(text, target_tokens=15, overlap_tokens=3)
    assert len(chunks) == 2
    # Second chunk must start with the last 3 tokens of the first.
    assert chunks[1].text.startswith("theta iota kappa "), chunks[1].text
    # The overlap shouldn't appear in the first chunk's text (it's raw paragraph).
    assert chunks[0].text == paras[0]
    # Char range of chunk 2 must reach back into chunk 1's tail.
    assert chunks[1].char_start < chunks[0].char_end


def test_overlap_zero_disables_prepending():
    paras = [
        "alpha beta gamma delta epsilon zeta",
        "eta theta iota kappa lambda mu",
    ]
    text = "\n\n".join(paras)
    chunks = chunk_text(text, target_tokens=10, overlap_tokens=0)
    assert len(chunks) == 2
    # No overlap: each chunk equals its source paragraph verbatim.
    assert chunks[0].text == paras[0]
    assert chunks[1].text == paras[1]


# ---- monolithic paragraphs trigger sentence fallback ----------------------


def test_oversize_paragraph_splits_at_sentence_boundaries():
    # A single 60-word "paragraph" of 5 sentences, each 12 words. With
    # target_tokens=20 it cannot fit; the splitter must drop to
    # sentence-level packing — three chunks of 1+1, 1+1, 1 sentences.
    sentences = [
        "Ich arbeitete in einer kleinen Agentur an einem grossen Projekt mit "
        "vielen Teammitgliedern.",
        "Wir bauten eine Webanwendung mit React TypeScript Tailwind und einer "
        "kleinen Node-API.",
        "Das Projekt lief ueber zwoelf Monate und wir lieferten in drei "
        "iterativen Phasen.",
        "Die Kunden waren mit der Qualitaet und der Geschwindigkeit der "
        "Auslieferung sehr zufrieden.",
        "Ich uebernahm spaeter die Rolle der technischen Leitung und "
        "mentorierte zwei Juniors.",
    ]
    text = " ".join(sentences)
    chunks = chunk_text(text, target_tokens=20, overlap_tokens=0)
    assert len(chunks) >= 3
    # Each sentence must appear in some chunk (no content drop).
    rejoined = " ".join(c.text for c in chunks)
    for s in sentences:
        assert s in rejoined


def test_german_abbreviation_does_not_force_split():
    # "Z. B." is a common German abbreviation — the regex must not split
    # there because the next char is a lowercase letter.
    text = "Hier ist ein Satz mit z. B. einer Abkuerzung. Hier kommt der naechste Satz."
    chunks = chunk_text(text, target_tokens=500)
    assert len(chunks) == 1
    assert "z. B." in chunks[0].text


def test_single_sentence_too_long_kept_intact():
    """If a paragraph has no sentence boundaries AND exceeds target, we
    keep it whole rather than chopping mid-word — the embedder will
    truncate to its model context, which is preferable to bad splits."""
    long_sentence = " ".join(f"wort{i}" for i in range(80))  # 80 tokens, no `.!?`
    chunks = chunk_text(long_sentence, target_tokens=20, overlap_tokens=0)
    assert len(chunks) == 1
    assert chunks[0].text == long_sentence


# ---- chunk metadata invariants --------------------------------------------


def test_chunk_indices_are_sequential_from_zero():
    text = "\n\n".join(f"Absatz nummer {i} mit ein paar Worten" for i in range(10))
    chunks = chunk_text(text, target_tokens=10, overlap_tokens=0)
    indices = [c.index for c in chunks]
    assert indices == list(range(len(indices)))


def test_token_count_matches_internal_estimate():
    text = "alpha beta gamma delta epsilon"
    chunks = chunk_text(text)
    assert chunks[0].token_count == 5


def test_char_offsets_recover_original_substring():
    """For a no-overlap chunk, slicing the original text by [char_start,
    char_end] must reproduce the chunk's text verbatim (paragraph-joined
    text uses the same `\n\n` separator the original had)."""
    text = "Erster Absatz hier.\n\nZweiter Absatz hier.\n\nDritter Absatz hier."
    chunks = chunk_text(text, target_tokens=4, overlap_tokens=0)
    for chunk in chunks:
        # The chunk's text is the joined-with-\n\n version; the underlying
        # source has the same separator. So the slice equals the chunk text
        # whenever overlap is zero.
        assert text[chunk.char_start : chunk.char_end] == chunk.text


def test_short_document_kept_even_below_min_chunk_threshold():
    """A whole document shorter than MIN_CHUNK_TOKENS still produces one
    chunk. The threshold exists to filter overlap-only stub *follow-on*
    chunks, not to silently drop short documents (a one-line CV is still
    a document worth indexing)."""
    chunks = chunk_text("alpha beta gamma")  # 3 tokens, below MIN_CHUNK_TOKENS=5
    assert len(chunks) == 1
    assert chunks[0].token_count == 3


def test_subsequent_stub_chunks_below_threshold_dropped():
    """If a *second-or-later* chunk would be tiny (e.g. an overlap-only
    fragment from a degenerate pack), drop it. The first chunk lands
    regardless; subsequent ones must clear the threshold."""
    # Long first paragraph, tiny trailing one. Target chosen so packing
    # produces (long, short) and the short one is below threshold.
    long_para = " ".join(f"wort{i}" for i in range(20))  # 20 tokens
    short_para = "abc"  # 1 token
    text = f"{long_para}\n\n{short_para}"
    chunks = chunk_text(text, target_tokens=15, overlap_tokens=0)
    # First chunk fits 15 tokens of the 20-token paragraph (well, the
    # whole paragraph since pack is greedy on paragraph units; this is
    # the "monstrous single paragraph" case so it lands as one chunk
    # regardless). Then "abc" is a 1-token follow-on; under-threshold.
    # The follow-on chunk should be dropped.
    debug = [(c.text, c.token_count) for c in chunks]
    assert all(c.token_count >= 5 for c in chunks[1:]), (
        f"chunks after the first must clear MIN_CHUNK_TOKENS=5; got {debug}"
    )


# ---- configuration validation ---------------------------------------------


@pytest.mark.parametrize("target", [0, -1, -100])
def test_non_positive_target_tokens_rejected(target: int):
    with pytest.raises(ValueError, match="target_tokens must be positive"):
        chunk_text("some text", target_tokens=target)


def test_negative_overlap_rejected():
    with pytest.raises(ValueError, match="overlap_tokens must be non-negative"):
        chunk_text("some text", overlap_tokens=-1)


def test_overlap_must_be_less_than_target():
    with pytest.raises(ValueError, match="overlap_tokens .* must be < target_tokens"):
        chunk_text("some text", target_tokens=10, overlap_tokens=10)


# ---- normalisation --------------------------------------------------------


def test_windows_line_endings_normalised():
    text = "Erster Absatz.\r\n\r\nZweiter Absatz."
    chunks = chunk_text(text)
    assert len(chunks) == 1
    assert "\r" not in chunks[0].text


def test_runs_of_horizontal_whitespace_collapsed():
    text = "alpha    beta\t\tgamma   delta"
    chunks = chunk_text(text)
    assert chunks[0].text == "alpha beta gamma delta"


def test_chunk_dataclass_is_frozen():
    """Chunks travel through the indexing pipeline by reference; making
    them frozen prevents accidental mutation downstream."""
    chunk = Chunk(index=0, text="hello", char_start=0, char_end=5, token_count=1)
    with pytest.raises(Exception):  # noqa: BLE001 — dataclasses raise FrozenInstanceError
        chunk.text = "modified"  # type: ignore[misc]
