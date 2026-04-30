from auto_tagger.propagator import _split_suggested_tags


class TestSplitSuggestedTags:
    def test_none_returns_empty(self):
        assert _split_suggested_tags(None) == []

    def test_empty_string_returns_empty(self):
        assert _split_suggested_tags("") == []

    def test_basic_csv(self):
        assert _split_suggested_tags("Vertrag, Industrie, Bauwesen") == [
            "Vertrag",
            "Industrie",
            "Bauwesen",
        ]

    def test_filters_lifecycle_tags(self):
        # The model could accidentally suggest a lifecycle tag — filtering
        # prevents it from triggering re-propagation or breaking state.
        result = _split_suggested_tags(
            "Vertrag, ai-approved, Industrie, ai-error, ai-pending"
        )
        assert "ai-approved" not in result
        assert "ai-error" not in result
        assert "ai-pending" not in result
        assert result == ["Vertrag", "Industrie"]

    def test_drops_truncation_artifacts(self):
        # 128-char string-field limit produces a trailing "…" via
        # _truncate_string_field; those tags are partial and worthless.
        assert _split_suggested_tags("Vertrag, Indus…") == ["Vertrag"]

    def test_strips_whitespace_and_skips_empty(self):
        assert _split_suggested_tags("  Vertrag  ,  ,  Industrie  ") == [
            "Vertrag",
            "Industrie",
        ]

    def test_preserves_non_lifecycle_tags_with_ai_prefix(self):
        # Only EXACT lifecycle names are filtered; "ai-something-else" passes.
        result = _split_suggested_tags("Vertrag, ai-custom, ai-pending")
        assert result == ["Vertrag", "ai-custom"]
