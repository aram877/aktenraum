# Opens the spike page in a real WebView2 window (the engine Tauri uses on Windows).
import webview

window = webview.create_window(
    "WebAuthn-Spike (WebView2)",
    "http://localhost:8790/?client=webview2",
    width=900,
    height=800,
)
webview.start(gui="edgechromium")
