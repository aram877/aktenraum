## ADDED Requirements

### Requirement: Auto-tagger logs the routing-decision reason

`tagger._route_lifecycle_tags` SHALL return both the tag list AND a structured `reason` string explaining the auto-approve gate's decision. The caller (`process_document`) SHALL include this `reason` in the `routing_decision` log event alongside the existing `tags`, `confidence`, and `document_type` fields. Reasons SHALL be one of an enumerated set: `"auto_approved"`, `"allowlist_empty"`, `"type_not_in_allowlist"`, `"confidence_below_threshold"`.

The reason MUST NOT affect routing behaviour — this requirement is purely about observability. The auto-approve gate's logic (`bool(auto_approve_types) AND document_type ∈ allowlist AND confidence ≥ threshold`) stays unchanged.

#### Scenario: Auto-approve fires and logs `auto_approved`
- **WHEN** an extraction returns `document_type=Rechnung`, `confidence=0.98`, and the env sets `AUTO_APPROVE_TYPES=Rechnung,Kontoauszug` and `AUTO_APPROVE_CONFIDENCE=0.95`
- **THEN** `_route_lifecycle_tags` returns `(["ai-approved", "ai-auto-approved"], "auto_approved")` and the `routing_decision` log line carries `reason="auto_approved"`

#### Scenario: Empty allowlist logs `allowlist_empty`
- **WHEN** an extraction returns any document type and `AUTO_APPROVE_TYPES` is empty (the default)
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "allowlist_empty")` (or `(["ai-pending", "ai-low-confidence"], "allowlist_empty")` when confidence is below `LOW_CONFIDENCE_THRESHOLD`), and the log line carries `reason="allowlist_empty"`

#### Scenario: Doc type outside allowlist logs `type_not_in_allowlist`
- **WHEN** an extraction returns `document_type=Vertrag`, `confidence=0.99`, and `AUTO_APPROVE_TYPES=Rechnung,Kontoauszug`
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "type_not_in_allowlist")` and the log line carries `reason="type_not_in_allowlist"`

#### Scenario: Confidence below threshold logs `confidence_below_threshold`
- **WHEN** an extraction returns `document_type=Rechnung` (in allowlist), `confidence=0.80`, threshold 0.95
- **THEN** `_route_lifecycle_tags` returns `(["ai-pending"], "confidence_below_threshold")` (potentially with `ai-low-confidence` if also below `LOW_CONFIDENCE_THRESHOLD`) and the log line carries `reason="confidence_below_threshold"`
