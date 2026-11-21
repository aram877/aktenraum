/**
 * Passkey providers by AAGUID (auth-passkeys design §10), for display only —
 * no security decision depends on it (attestation is `none`, so the AAGUID is
 * self-reported). Taken from the WebAuthn spike's observations and the
 * community `passkey-authenticator-aaguids` list. Unknown → "Passkey".
 */
const PROVIDERS: Readonly<Record<string, string>> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Passwortmanager",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud-Schlüsselbund",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud-Schlüsselbund",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome auf dem Mac",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export const UNKNOWN_PROVIDER = "Passkey";

export function providerOf(aaguid: string | null | undefined): string {
  if (aaguid === null || aaguid === undefined) return UNKNOWN_PROVIDER;
  return PROVIDERS[aaguid.toLowerCase()] ?? UNKNOWN_PROVIDER;
}
