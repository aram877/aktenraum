# WebAuthn spike

Throwaway test harness behind the spike results in [ADR-010](../../../docs/adr/010-auth-layer.md). It is not part of the pnpm workspace and never touches the live stack.

```bash
cd scripts/spikes/webauthn
npm install            # @simplewebauthn/server only; node_modules is gitignored
node server.mjs        # http://localhost:8790 and http://127.0.0.1:8790
```

Then open the page and follow the buttons. Each result is appended to `results.jsonl`, and the registered passkeys go to `credentials.json`. Both files are local and should not be committed.

| Test | How |
| --- | --- |
| Browser + platform passkey, PRF stability | `http://localhost:8790`: register once, sign in twice; the PRF fingerprint must stay the same |
| RP-ID binding | `http://127.0.0.1:8790`: both sign-in buttons must fail with `SecurityError` |
| Phone (hybrid) | Register and choose "another device", then scan the QR code |
| WebView2 (Tauri's engine on Windows) | `pip install pywebview`, then `python webview2.py` |
| Still open | A Mac (Safari, plus a WKWebView/Tauri build) and an HTTPS hostname via Tailscale (`tailscale serve` to port 8790) |

Clean up afterwards: delete the test passkeys in the browser's password manager ("localhost") or under Windows Settings → Accounts → Passkeys.
