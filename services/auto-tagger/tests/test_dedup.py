from auto_tagger.dedup import DocFields, find_duplicates


def _doc(
    doc_id: int,
    *,
    correspondent: str | None = "Telekom",
    issue_date: str | None = "2024-03-15",
    monetary_amount: str | None = "EUR42.99",
    reference_numbers: str | None = None,
    document_type: str | None = None,
) -> DocFields:
    return DocFields(
        id=doc_id,
        correspondent=correspondent,
        issue_date=issue_date,
        monetary_amount=monetary_amount,
        reference_numbers=reference_numbers,
        document_type=document_type,
    )


class TestExactMatch:
    def test_same_correspondent_date_amount_flags(self):
        a = _doc(1)
        b = _doc(2)
        assert find_duplicates(b, [a]) == [1]

    def test_self_id_excluded(self):
        # If a doc is mis-fed into the candidate list it must not flag itself.
        a = _doc(1)
        assert find_duplicates(a, [a]) == []

    def test_empty_candidates_returns_empty(self):
        assert find_duplicates(_doc(1), []) == []

    def test_multiple_matches_returned_in_iteration_order(self):
        new = _doc(99)
        cands = [_doc(1), _doc(2), _doc(3)]
        assert find_duplicates(new, cands) == [1, 2, 3]


class TestCorrespondentMismatch:
    def test_different_correspondent_no_flag(self):
        a = _doc(1, correspondent="Telekom")
        b = _doc(2, correspondent="Vodafone")
        assert find_duplicates(b, [a]) == []

    def test_correspondent_case_and_whitespace_normalised(self):
        a = _doc(1, correspondent="  Telekom  ")
        b = _doc(2, correspondent="TELEKOM")
        assert find_duplicates(b, [a]) == [1]

    def test_german_eszett_case_folded(self):
        # casefold() folds ß → ss so receipts that vary on Eszett still match.
        a = _doc(1, correspondent="Großhändler")
        b = _doc(2, correspondent="grosshändler")
        assert find_duplicates(b, [a]) == [1]


class TestMissingAnchors:
    def test_missing_correspondent_on_new_doc_skips_detection(self):
        new = _doc(99, correspondent=None)
        # Candidates with matching everything-else should NOT flag.
        cands = [_doc(1), _doc(2)]
        assert find_duplicates(new, cands) == []

    def test_missing_issue_date_on_new_doc_skips_detection(self):
        new = _doc(99, issue_date=None)
        cands = [_doc(1), _doc(2)]
        assert find_duplicates(new, cands) == []

    def test_empty_correspondent_string_treated_as_missing(self):
        new = _doc(99, correspondent="   ")
        assert find_duplicates(new, [_doc(1)]) == []

    def test_candidate_missing_amount_falls_through_to_refs(self):
        # When the candidate has no amount but a shared ref number, still flags.
        new = _doc(
            99,
            monetary_amount=None,
            reference_numbers="RN-12345",
        )
        cand = _doc(
            1,
            monetary_amount=None,
            reference_numbers="RN-12345",
        )
        assert find_duplicates(new, [cand]) == [1]


class TestAmountTolerance:
    def test_amount_within_tolerance_flags(self):
        a = _doc(1, monetary_amount="EUR42.99")
        b = _doc(2, monetary_amount="EUR43.00")  # 1 cent diff, at tolerance
        assert find_duplicates(b, [a]) == [1]

    def test_amount_outside_tolerance_without_ref_no_flag(self):
        a = _doc(1, monetary_amount="EUR42.99")
        b = _doc(2, monetary_amount="EUR43.50")  # 51 cents diff
        assert find_duplicates(b, [a]) == []

    def test_amount_outside_tolerance_with_ref_overlap_flags(self):
        # The OR semantics: amount mismatch is fine when refs overlap.
        a = _doc(1, monetary_amount="EUR42.99", reference_numbers="RN-7")
        b = _doc(2, monetary_amount="EUR9999.00", reference_numbers="RN-7")
        assert find_duplicates(b, [a]) == [1]

    def test_currency_prefix_handled(self):
        a = _doc(1, monetary_amount="USD42.99")
        b = _doc(2, monetary_amount="USD42.99")
        # Tolerance doesn't care about currency code; the propagator only ever
        # compares docs from the same correspondent so cross-currency is rare
        # and a same-amount-different-currency match is still a duplicate
        # signal worth flagging.
        assert find_duplicates(b, [a]) == [1]

    def test_unparseable_amount_falls_through_to_refs(self):
        a = _doc(1, monetary_amount="not-a-number", reference_numbers="RN-1")
        b = _doc(2, monetary_amount="EUR1.00", reference_numbers="RN-1")
        # Amount can't compare; ref overlap saves it.
        assert find_duplicates(b, [a]) == [1]

    def test_unparseable_amount_no_ref_no_flag(self):
        a = _doc(1, monetary_amount="not-a-number", reference_numbers=None)
        b = _doc(2, monetary_amount="EUR1.00", reference_numbers=None)
        assert find_duplicates(b, [a]) == []


class TestReferenceNumbers:
    def test_shared_ref_alone_flags(self):
        # Amounts differ; refs match → flag.
        a = _doc(1, monetary_amount="EUR1.00", reference_numbers="RN-1")
        b = _doc(2, monetary_amount="EUR2.00", reference_numbers="RN-1, RN-2")
        assert find_duplicates(b, [a]) == [1]

    def test_no_ref_overlap_with_amount_mismatch_no_flag(self):
        a = _doc(1, monetary_amount="EUR1.00", reference_numbers="RN-1")
        b = _doc(2, monetary_amount="EUR99.00", reference_numbers="RN-99")
        assert find_duplicates(b, [a]) == []

    def test_ref_case_insensitive_and_trimmed(self):
        a = _doc(1, reference_numbers="  RN-001 ,  AZ-77")
        b = _doc(2, reference_numbers="rn-001")
        assert find_duplicates(b, [a]) == [1]

    def test_empty_ref_fragments_dropped(self):
        # A stray trailing comma must not smuggle an empty "" match.
        a = _doc(1, monetary_amount=None, reference_numbers="RN-1,")
        b = _doc(2, monetary_amount=None, reference_numbers=",,,")
        assert find_duplicates(b, [a]) == []


class TestDateMatching:
    def test_different_dates_no_flag(self):
        a = _doc(1, issue_date="2024-03-15")
        b = _doc(2, issue_date="2024-03-16")
        assert find_duplicates(b, [a]) == []

    def test_dates_compared_as_strings_not_normalised(self):
        # Stored dates are guaranteed ISO from the gateway normaliser; if
        # the formats diverge that's a separate bug. Verify strict equality.
        a = _doc(1, issue_date="2024-03-15")
        b = _doc(2, issue_date="2024-3-15")
        assert find_duplicates(b, [a]) == []


class TestCandidateExclusion:
    def test_candidate_missing_correspondent_dropped(self):
        new = _doc(99)
        cand = _doc(1, correspondent=None)
        assert find_duplicates(new, [cand]) == []

    def test_candidate_missing_date_dropped(self):
        new = _doc(99)
        cand = _doc(1, issue_date=None)
        assert find_duplicates(new, [cand]) == []


class TestDocumentTypeDiscriminator:
    """Type-aware matching: a Rechnung and its Beleg (payment proof)
    from the same vendor on the same day for the same amount should
    NOT be flagged as duplicates — they're related but distinct
    records of the same transaction."""

    def test_different_types_dont_match_despite_same_amount(self):
        # The Anthropic invoice + receipt scenario the user hit.
        rechnung = _doc(1, document_type="Rechnung")
        beleg = _doc(2, document_type="Beleg")
        assert find_duplicates(beleg, [rechnung]) == []
        assert find_duplicates(rechnung, [beleg]) == []

    def test_different_types_dont_match_despite_shared_refs(self):
        # Even if a Beleg references the Rechnung's number, the type
        # discriminator wins — the user explicitly opted for type-
        # awareness over ref-overlap heuristics.
        rechnung = _doc(
            1, document_type="Rechnung", reference_numbers="INV-123"
        )
        beleg = _doc(2, document_type="Beleg", reference_numbers="INV-123")
        assert find_duplicates(beleg, [rechnung]) == []

    def test_same_type_still_matches(self):
        # Two Rechnungen from the same vendor on the same day for the
        # same amount remain duplicates.
        a = _doc(1, document_type="Rechnung")
        b = _doc(2, document_type="Rechnung")
        assert find_duplicates(b, [a]) == [1]

    def test_missing_type_on_either_side_skips_check(self):
        # Backward compat: corpora indexed before this signal existed
        # have None for document_type. Don't block the match.
        a = _doc(1, document_type=None)
        b = _doc(2, document_type="Rechnung")
        assert find_duplicates(b, [a]) == [1]

    def test_missing_type_on_both_sides_skips_check(self):
        a = _doc(1, document_type=None)
        b = _doc(2, document_type=None)
        assert find_duplicates(b, [a]) == [1]

    def test_type_match_is_case_insensitive(self):
        # Defence in depth: if a doc somehow stored its type in a
        # different case (it shouldn't — the enum is exact-string —
        # but cf. correspondent case-folding) it should still match.
        a = _doc(1, document_type="rechnung")
        b = _doc(2, document_type="Rechnung")
        assert find_duplicates(b, [a]) == [1]
