// Mirrors aktenraum_core.paperless.normalisers.

const CURRENCY_CODES = ["EUR", "USD", "GBP", "CHF", "JPY"] as const;
const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
};

// Paperless `string` custom fields are backed by a 128-char DB column.
// Anything longer is rejected with a 400. We truncate with an ellipsis so the
// PATCH still succeeds. The complementary `longtext` data_type (Paperless
// 2.x+) has no length limit; fields backed by it must NOT be truncated,
// otherwise multi-sentence summaries get clipped to 128 chars.
const PAPERLESS_STRING_MAX = 128;

// AI custom-field names whose Paperless data_type is `longtext`. Listed
// explicitly so the truncation helpers stay pure / context-free — callers do
// not need to pass field metadata. Update this set whenever a new longtext
// AI field is introduced (or the bootstrap script is changed).
export const LONGTEXT_FIELDS: ReadonlySet<string> = new Set([
  "ai_summary_de",
  "ai_error_message",
  "ai_confidence_reason",
]);

function truncateStringField(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= PAPERLESS_STRING_MAX) return value;
  return value.slice(0, PAPERLESS_STRING_MAX - 1) + "…";
}

/**
 * Apply the 128-char truncation only when the field is backed by `string`.
 * Use this from any boundary that writes to Paperless's custom_fields PATCH
 * so longtext fields (like `ai_summary_de`) survive intact.
 */
export function truncateForField(name: string, value: string | null): string | null {
  if (LONGTEXT_FIELDS.has(name)) return value;
  return truncateStringField(value);
}

// Paperless's `date` custom field requires strict YYYY-MM-DD; the LLM mostly
// obeys the system prompt but occasionally emits German DD.MM.YYYY or partial
// month-year values. We try a small set of common formats (same order as the
// Python side) and drop the field (return null) if none parse — better to
// lose a date than fail the whole PATCH.
type DateParser = (text: string) => { y: number; m: number; d: number } | null;

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Python strptime %y: 00-68 -> 2000-2068, 69-99 -> 1969-1999.
function expandTwoDigitYear(yy: number): number {
  return yy <= 68 ? 2000 + yy : 1900 + yy;
}

const DATE_PARSERS: DateParser[] = [
  // %Y-%m-%d
  (text) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  },
  // %d.%m.%Y
  (text) => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
    return m ? { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) } : null;
  },
  // %d/%m/%Y
  (text) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    return m ? { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) } : null;
  },
  // %Y/%m/%d
  (text) => {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  },
  // %d.%m.%y
  (text) => {
    const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(text);
    return m ? { y: expandTwoDigitYear(Number(m[3])), m: Number(m[2]), d: Number(m[1]) } : null;
  },
  // %m.%Y (day anchored to the 1st)
  (text) => {
    const m = /^(\d{2})\.(\d{4})$/.exec(text);
    return m ? { y: Number(m[2]), m: Number(m[1]), d: 1 } : null;
  },
  // %m/%Y (day anchored to the 1st)
  (text) => {
    const m = /^(\d{2})\/(\d{4})$/.exec(text);
    return m ? { y: Number(m[2]), m: Number(m[1]), d: 1 } : null;
  },
  // %Y-%m (day anchored to the 1st)
  (text) => {
    const m = /^(\d{4})-(\d{2})$/.exec(text);
    return m ? { y: Number(m[1]), m: Number(m[2]), d: 1 } : null;
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeDate(value: string | null): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  for (const parse of DATE_PARSERS) {
    const parsed = parse(text);
    if (parsed === null) continue;
    if (parsed.m < 1 || parsed.m > 12) continue;
    if (!isValidCalendarDate(parsed.y, parsed.m, parsed.d)) continue;
    return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
  }
  return null;
}

/**
 * Convert a freeform monetary string to Paperless format (e.g. 'EUR149.99').
 * Paperless's `monetary` custom field requires a 3-letter ISO code prefix and
 * dot-decimal amount. The LLM emits German-style formats like '149,99 EUR'.
 * Returns null if parsing fails (the field is then dropped from the PATCH).
 */
export function normalizeMonetary(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim();
  if (!text) return null;

  let code: string | null = null;
  const upper = text.toUpperCase();
  for (const c of CURRENCY_CODES) {
    if (upper.includes(c)) {
      code = c;
      break;
    }
  }
  if (code === null) {
    for (const [sym, c] of Object.entries(CURRENCY_SYMBOLS)) {
      if (text.includes(sym)) {
        code = c;
        break;
      }
    }
  }
  if (code === null) code = "EUR";

  let numStr = text.replace(/[^\d.,-]/g, "");
  if (!numStr) return null;

  // Disambiguate decimal separator. Both present: the rightmost is the
  // decimal (handles "1.234,56" German and "1,234.56" Anglophone).
  if (numStr.includes(",") && numStr.includes(".")) {
    if (numStr.lastIndexOf(",") > numStr.lastIndexOf(".")) {
      numStr = numStr.replace(/\./g, "").replace(",", ".");
    } else {
      numStr = numStr.replace(/,/g, "");
    }
  } else if (numStr.includes(",")) {
    numStr = numStr.replace(",", ".");
  }

  const amount = Number(numStr);
  if (Number.isNaN(amount)) return null;
  return `${code}${amount.toFixed(2)}`;
}
