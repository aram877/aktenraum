# shellcheck shell=bash
# Shared helpers for the bash scripts that parse JSON with Python and pass
# files to curl. Source it:  . "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
#
# Why: on Windows (Git Bash) three things broke scripts/e2e-worker.sh —
#   1. `command -v python3` finds the Microsoft Store stub, which only prints
#      "Python was not found" (exit 49);
#   2. Windows Python decodes piped stdin as cp1252, mangling the umlauts in
#      document types (Behördenbrief, Kündigung, …) → the api answers 422;
#   3. curl from Git Bash can't open an MSYS path like /tmp/x inside
#      `-F document=@/tmp/x` (exit 26) — MSYS converts bare path arguments,
#      not ones embedded in a larger string.

# Prints the first Python interpreter that actually runs, or nothing.
find_python() {
  local candidate path
  for candidate in python3 python; do
    path="$(command -v "${candidate}" 2>/dev/null)" || continue
    if "${path}" -c 'import sys' >/dev/null 2>&1; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 1
}

# UTF-8 for stdin/stdout regardless of the Windows code page (no-op elsewhere).
export PYTHONUTF8=1

# A path a native (non-MSYS) program can open: C:/... on Git Bash, unchanged elsewhere.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}
