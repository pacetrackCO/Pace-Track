import { useRef, useState } from "react";

const brandColors = `
  :root, html[data-theme="dark"] {
    --pt-ink: #0f172a;
    --pt-forest: #1e293b;
    --pt-paper: #f8fafc;
    --pt-panel: #ffffff;
    --pt-amber: #ffae42;
    --pt-orange: #d9480f;
    --pt-muted: #58677b;
    --pt-line: rgba(15, 23, 42, .16);
    --main: #e44812;
    --accent: #ff8c00;
    --dark: #0f172a;
    --light: #f8fafc;
    --text-secondary: #cbd5e1;
    --border: rgba(255, 140, 0, .27);
    --card-bg: rgba(255, 255, 255, .06);
    --hover-bg: rgba(255, 140, 0, .12);
    color-scheme: light;
  }
  html[data-theme="dark"] {
    --pt-ink: #f8fafc;
    --pt-paper: #151e2d;
    --pt-panel: #1d293a;
    --pt-muted: #cbd5e1;
    --pt-line: rgba(248, 250, 252, .17);
    --text-secondary: #cbd5e1;
    --card-bg: rgba(248, 250, 252, .06);
    color-scheme: dark;
  }
  body:has(#video-container) {
    background: #0f172a !important;
    color: #f8fafc !important;
    --overlay-bg: rgba(15, 23, 42, .93);
  }
  body:has(#video-container) #video-container {
    background: radial-gradient(ellipse at 50% 45%, rgba(255, 140, 0, .11), transparent 52%), #111c2d !important;
  }
  body:has(#video-container) #controls button,
  body:has(#video-container) button:not(#themeToggle) {
    background: #ffae42 !important;
    color: #0f172a !important;
    border-color: rgba(255, 255, 255, .28) !important;
  }
  body:has(#video-container) #controls button:hover,
  body:has(#video-container) button:hover:not(#themeToggle) {
    background: #ffc266 !important;
  }
  body:has(#video-container) #status-message,
  body:has(#video-container) #sensitivity-slider-container,
  body:has(#video-container) #laps-container,
  body:has(#video-container) #p2p-panel {
    background-color: rgba(15, 23, 42, .94) !important;
    border-color: rgba(255, 140, 0, .45) !important;
  }
  body:has(#video-container) .modal {
    background: rgba(15, 23, 42, .88) !important;
  }
  body:has(#video-container) .modal-content,
  body:has(#video-container) .message-box {
    background: #f8fafc !important;
    color: #0f172a !important;
  }
  html[data-theme="dark"] body:has(#video-container) .modal-content,
  html[data-theme="dark"] body:has(#video-container) .message-box {
    background: #1d293a !important;
    color: #f8fafc !important;
    border-color: rgba(255, 140, 0, .42) !important;
  }
  body:has(#video-container) .modal-content button,
  body:has(#video-container) .modal-buttons button,
  body:has(#video-container) .message-box button {
    background: #ffae42 !important;
    background-image: none !important;
    color: #0f172a !important;
  }
  body:not(:has(#video-container)) .home-hero h1 span {
    color: #d9480f !important;
    -webkit-text-fill-color: #d9480f !important;
  }
  body:not(:has(#video-container)) .track-readout {
    background: #ffae42 !important;
    color: #0f172a !important;
  }
  body:not(:has(#video-container)) .track-graphic::before { border-color: #0f172a !important; }
  body:not(:has(#video-container)) .track-graphic::after { border-color: #ff8c00 !important; }
  body:not(:has(#video-container)) .site-nav-links a:hover,
  body:not(:has(#video-container)) .site-brand b,
  body:not(:has(#video-container)) .card-icon,
  body:not(:has(#video-container)) .icon,
  body:not(:has(#video-container)) .hero-index { color: #d9480f !important; }
  body:not(:has(#video-container)) .card:hover,
  body:not(:has(#video-container)) .item:hover { border-color: #ff8c00 !important; }
  body:not(:has(#video-container)) .item { border-left-color: #ff8c00 !important; }
  body:not(:has(#video-container)) .btn,
  body.construction-page .btn {
    background: linear-gradient(110deg, #d9480f, #ff8c00) !important;
    color: #0f172a !important;
  }
  body:not(:has(#video-container)) .btn:hover,
  body.construction-page .btn:hover {
    background: linear-gradient(110deg, #c13b0c, #eb7900) !important;
  }
  body:has(#qrcode) header { border-bottom: 3px solid #ff8c00; }
  body:has(#qrcode) #status-message { border-left: 3px solid #ff8c00; }
  :focus-visible { outline-color: #ff8c00 !important; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
    }
  }
`;

const pages = [
  { key: "home", label: "Inicio", path: "/__mockup/pacetrack-refresh/index.html" },
  { key: "timer", label: "Cronómetro", path: "/__mockup/pacetrack-refresh/timer/timer.html" },
  { key: "loop", label: "Loop", path: "/__mockup/pacetrack-refresh/timer_loop/timer_loop.html" },
  { key: "sector", label: "Sector", path: "/__mockup/pacetrack-refresh/timer_sector/timer_sector.html" },
  { key: "events", label: "Eventos", path: "/__mockup/pacetrack-refresh/events/events.html" },
  { key: "pc", label: "Pantalla PC", path: "/__mockup/pacetrack-refresh/timer_PC/PC/PC.html" },
  { key: "mobilepc", label: "Móvil PC", path: "/__mockup/pacetrack-refresh/timer_PC/Mobil/timer.html" },
  { key: "construction", label: "En desarrollo", path: "/__mockup/pacetrack-refresh/Construccion/construccion.html" },
];

export function Refresh() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const params = new URLSearchParams(window.location.search);
  const initialKey = params.get("page");
  const [pageKey, setPageKey] = useState(
    pages.some((page) => page.key === initialKey) ? initialKey! : pages[0].key,
  );
  const mobileViewport = params.get("viewport") === "mobile";
  const activePage = pages.find((page) => page.key === pageKey) ?? pages[0];

  function selectPage(key: string) {
    setPageKey(key);
    const url = new URL(window.location.href);
    if (key === "home") url.searchParams.delete("page");
    else url.searchParams.set("page", key);
    window.history.replaceState(null, "", url);
  }

  function applyBrandPalette() {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.head) return;
    doc.getElementById("pacetrack-brand-palette")?.remove();
    const style = doc.createElement("style");
    style.id = "pacetrack-brand-palette";
    style.textContent = brandColors;
    doc.head.appendChild(style);
  }

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "auto", display: "flex", justifyContent: "center", background: "#0f172a", color: "#f8fafc", fontFamily: "'DM Sans', sans-serif" }}>
      <section style={{ width: mobileViewport ? 390 : "100%", maxWidth: "100vw", height: "100dvh", minHeight: "100dvh", display: "grid", gridTemplateRows: "56px minmax(0,1fr)", flex: "0 0 auto", background: "#0f172a" }}>
        <header style={{ minWidth: 0, display: "flex", alignItems: "center", gap: mobileViewport ? 8 : 14, padding: mobileViewport ? "0 10px" : "0 18px", borderBottom: "1px solid rgba(248,250,252,.17)", background: "#0f172a" }}>
          <span style={{ flex: "0 0 auto", fontWeight: 800, letterSpacing: ".1em", fontSize: mobileViewport ? 10 : 12 }}>PACETRACK <span style={{ color: "#ff8c00" }}>/ REFRESH</span></span>
          <label htmlFor="pacetrack-page" style={{ marginLeft: "auto", fontSize: 12, color: "#cbd5e1", whiteSpace: "nowrap", display: mobileViewport ? "none" : "block" }}>Vista previa ·</label>
          <select id="pacetrack-page" value={pageKey} onChange={(event) => selectPage(event.target.value)} style={{ flex: "0 1 auto", width: mobileViewport ? 150 : "min(220px,48vw)", minWidth: 0, padding: "8px 8px", borderRadius: 4, border: "1px solid rgba(255,140,0,.42)", background: "#1e293b", color: "#f8fafc", font: "600 12px 'DM Sans', sans-serif" }}>
            {pages.map((page) => <option key={page.key} value={page.key}>{page.label}</option>)}
          </select>
        </header>
        <iframe ref={frameRef} key={activePage.path} src={activePage.path} title={`Vista previa PaceTrack: ${activePage.label}`} onLoad={applyBrandPalette} allow="camera; microphone" style={{ width: "100%", height: "100%", minHeight: 0, border: 0, display: "block" }} />
      </section>
    </main>
  );
}