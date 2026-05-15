import re
from datetime import datetime

_CURRENCY_CODES = ("EUR", "USD", "GBP", "CHF", "JPY")
_CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}

# Paperless `string` custom fields are backed by a 128-char DB column.
# Anything longer is rejected with a 400. We truncate with an ellipsis so the
# PATCH still succeeds. The complementary `longtext` data_type (Paperless 2.x+)
# has no length limit; fields backed by it must NOT be truncated, otherwise
# multi-sentence summaries get clipped to 128 chars.
_PAPERLESS_STRING_MAX = 128

# AI custom-field names whose Paperless data_type is `longtext`. Listed
# explicitly so the truncation helpers stay pure / context-free — callers do
# not need to pass field metadata. Update this set whenever a new longtext
# AI field is introduced (or the bootstrap script is changed).
LONGTEXT_FIELDS = frozenset({"ai_summary_de", "ai_error_message"})


def _truncate_string_field(value: str | None) -> str | None:
    if value is None:
        return None
    if len(value) <= _PAPERLESS_STRING_MAX:
        return value
    return value[: _PAPERLESS_STRING_MAX - 1] + "…"


def truncate_for_field(name: str, value: str | None) -> str | None:
    """Apply the 128-char truncation only when the field is backed by `string`.

    Use this from any boundary that writes to Paperless's custom_fields PATCH
    so longtext fields (like `ai_summary_de`) survive intact.
    """
    if name in LONGTEXT_FIELDS:
        return value
    return _truncate_string_field(value)


# Paperless's `date` custom field requires strict YYYY-MM-DD; the LLM mostly
# obeys the system prompt but occasionally emits German DD.MM.YYYY or partial
# month-year values. We try a small set of common formats and drop the field
# (return None) if none parse — better to lose a date than fail the whole PATCH.
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
    "%d.%m.%y",
    "%m.%Y",
    "%m/%Y",
    "%Y-%m",
)


def _normalize_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        # For month-year-only formats, anchor the day to the 1st so Paperless
        # still gets a valid date. Acceptable approximation for documents that
        # only specify a month (e.g. Lohnsteuerbescheinigung "12-2024").
        return parsed.strftime("%Y-%m-%d")
    return None


def _normalize_monetary(value: str | None) -> str | None:
    """Convert a freeform monetary string to Paperless format (e.g. 'EUR149.99').

    Paperless's `monetary` custom field requires a 3-letter ISO code prefix and
    dot-decimal amount. The LLM emits German-style formats like '149,99 EUR'.
    Returns None if parsing fails (the field is then dropped from the PATCH).
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None

    code: str | None = None
    upper = text.upper()
    for c in _CURRENCY_CODES:
        if c in upper:
            code = c
            break
    if code is None:
        for sym, c in _CURRENCY_SYMBOLS.items():
            if sym in text:
                code = c
                break
    if code is None:
        code = "EUR"

    num_str = re.sub(r"[^\d.,\-]", "", text)
    if not num_str:
        return None

    # Disambiguate decimal separator. Both present: the rightmost is the
    # decimal (handles "1.234,56" German and "1,234.56" Anglophone).
    if "," in num_str and "." in num_str:
        if num_str.rfind(",") > num_str.rfind("."):
            num_str = num_str.replace(".", "").replace(",", ".")
        else:
            num_str = num_str.replace(",", "")
    elif "," in num_str:
        num_str = num_str.replace(",", ".")

    try:
        amount = float(num_str)
    except ValueError:
        return None
    return f"{code}{amount:.2f}"
