#!/usr/bin/env python3
"""Generate the legal pages (eula/terms/privacy .html) from the canonical
markdown in /EULA.md and /legal/*.md. The .md files are the source of truth —
edit those, then rerun:  python3 scripts/gen-legal-pages.py

Two output sets:
  - website3/            (marketing site template — deploys when vodou.ai launches)
  - app-vodou-ai/frontend/public/  (self-contained pages — CRA copies them to the
    build root, so they serve at https://app.vodou.ai/terms.html etc. TODAY; this
    is the live canonical location until vodou.ai exists)
"""
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "website3"
APP_PUBLIC = ROOT / "app-vodou-ai" / "frontend" / "public"

PAGES = [
    {
        "md": ROOT / "EULA.md",
        "out": SITE / "eula.html",
        "title": "End User License Agreement — Vodou",
        "hero": "End User License Agreement",
        "tagline": "The license for the proprietary Vodou binaries. Open-source components are governed by their own licenses.",
    },
    {
        "md": ROOT / "legal" / "TERMS-OF-SERVICE.md",
        "out": SITE / "terms.html",
        "title": "Terms of Service — Vodou",
        "hero": "Terms of Service",
        "tagline": "The agreement covering your Vodou account and our hosted services.",
    },
    {
        "md": ROOT / "legal" / "PRIVACY-POLICY.md",
        "out": SITE / "privacy.html",
        "title": "Privacy Policy — Vodou",
        "hero": "Privacy Policy",
        "tagline": "Local-first by design: your conversations and memory stay on your device.",
    },
]

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link rel="stylesheet" href="css/base.css">
  <link rel="stylesheet" href="css/components.css">
  <link rel="stylesheet" href="css/animations.css">
</head>
<body>
  <nav class="nav">
    <div class="container">
      <a href="index.html" class="nav-logo"><span class="nav-logo-icon">🔮</span>Vodou</a>
      <div class="nav-links">
        <a href="index.html">Home</a><a href="features.html">Features</a><a href="pricing.html">Pricing</a>
        <a href="mcp.html">MCP Catalog</a><a href="docs.html">Docs</a>
      </div>
      <div class="nav-cta"><a href="support.html" class="btn btn-secondary">Support</a><a href="https://github.com/vodou/open-intelligence" target="_blank" class="btn btn-primary">GitHub</a></div>
      <div class="nav-hamburger" role="button" aria-label="Toggle menu"><span></span><span></span><span></span></div>
    </div>
    <div class="nav-mobile">
      <a href="index.html">Home</a><a href="features.html">Features</a><a href="pricing.html">Pricing</a>
      <a href="mcp.html">MCP Catalog</a><a href="docs.html">Docs</a><a href="about.html">About</a><a href="support.html">Support</a>
    </div>
  </nav>

  <section class="hero" style="padding:6rem 0 2rem;">
    <div class="container">
      <h1><span class="text-gradient">{hero}</span></h1>
      <p style="max-width:640px;margin:0 auto;">{tagline}</p>
    </div>
  </section>

  <section class="section">
    <div class="container">
      <div class="legal-doc" style="max-width:820px;margin:0 auto;color:var(--text-secondary);line-height:1.7;">
{body}
      </div>
    </div>
  </section>

  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div><div class="footer-brand"><span class="footer-brand-icon">🔮</span>Vodou</div><p class="footer-desc">Open Intelligence. Local-first AI with real system access.</p></div>
        <div class="footer-col"><h4>Product</h4><ul><li><a href="features.html">Features</a></li><li><a href="pricing.html">Pricing</a></li><li><a href="mcp.html">MCP Catalog</a></li><li><a href="docs.html">Docs</a></li></ul></div>
        <div class="footer-col"><h4>Resources</h4><ul><li><a href="blog.html">Blog</a></li><li><a href="docs.html">Quick Start</a></li><li><a href="https://github.com/vodou/open-intelligence" target="_blank">GitHub</a></li><li><a href="about.html">About</a></li></ul></div>
        <div class="footer-col"><h4>Legal</h4><ul><li><a href="terms.html">Terms of Service</a></li><li><a href="privacy.html">Privacy Policy</a></li><li><a href="eula.html">EULA</a></li></ul></div>
      </div>
      <div class="footer-bottom"><span>© 2026 Vodou Inc. All rights reserved.</span><span>Built with 🔮 locally · <a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a> · <a href="eula.html">EULA</a></span></div>
    </div>
  </footer>
  <script src="js/main.js"></script>
</body>
</html>
"""


# app.vodou.ai legal pages, styled as vodou.ai (header, footer, colors, Geist).
# Self-contained: no framework, and the only script is the analytics consent
# file. Fonts and the logo are served from app.vodou.ai itself, because its
# Content-Security-Policy allows fonts and scripts only from 'self' (plus
# googletagmanager.com for analytics). Copy of vodou.ai's design tokens from
# vodou-alpha-launch src/styles.css; keep them in step if the site's change.
SOCIAL_ICONS_HTML = """<a class="social" href="https://discord.gg/BmushMcpV9" target="_blank" rel="noreferrer" aria-label="Discord" title="Discord" style="--brand-color:#5865F2"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg></a>
            <a class="social" href="https://github.com/VodouAI" target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub" style="--brand-color:#E8ECF5"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg></a>
            <a class="social" href="https://blog.vodou.ai/" target="_blank" rel="noreferrer" aria-label="Blog" title="Blog" style="--brand-color:#4A7BFF"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg></a>
            <a class="social" href="https://www.reddit.com/user/VodouAI/" target="_blank" rel="noreferrer" aria-label="Reddit" title="Reddit" style="--brand-color:#FF4500"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/></svg></a>
            <a class="social" href="https://www.facebook.com/profile.php?id=61593123341522" target="_blank" rel="noreferrer" aria-label="Facebook" title="Facebook" style="--brand-color:#0866FF"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg></a>
            <a class="social" href="https://www.youtube.com/@VodouAI" target="_blank" rel="noreferrer" aria-label="YouTube" title="YouTube" style="--brand-color:#FF0000"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
            <a class="social" href="https://x.com/VodouAI" target="_blank" rel="noreferrer" aria-label="X" title="X" style="--brand-color:#E8ECF5"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg></a>
            <a class="social" href="https://www.tiktok.com/@vodou.ai" target="_blank" rel="noreferrer" aria-label="TikTok" title="TikTok" style="--brand-color:#E8ECF5"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg></a>
            <a class="social" href="https://www.linkedin.com/company/vodou-ai" target="_blank" rel="noreferrer" aria-label="LinkedIn" title="LinkedIn" style="--brand-color:#0A66C2"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>"""

APP_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <meta name="theme-color" content="#07090F">
  <!-- /favicon.ico was a 404 on app.vodou.ai until 2026-09-18: browsers ask for
       it by default, and so do crawlers and link unfurlers that ignore <link>.
       The file is the same Vodou mark as favicon-32.png. -->
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="apple-touch-icon" href="/vodou-192.png">
  <link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
  <style>
    @font-face {{ font-family: "Geist"; src: url("/fonts/Geist-Variable.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }}
    @font-face {{ font-family: "Geist Mono"; src: url("/fonts/GeistMono-Variable.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }}
    :root {{
      --background: #07090F; --bg-2: #0B0F1A; --bg-3: #111726;
      --line: rgba(255,255,255,0.06); --line-strong: rgba(255,255,255,0.12);
      --ink: #E8ECF5; --ink-dim: #9AA3B8; --ink-faint: #5A6478;
      --brand: #2E5BFF; --brand-2: #4A7BFF; --brand-glow: rgba(46,91,255,0.35);
      --font-sans: "Geist", system-ui, -apple-system, sans-serif;
      --font-mono: "Geist Mono", ui-monospace, monospace;
      /* read by the body markup (md_to_html) and the cookie notice */
      --text-primary: var(--ink);
      --toast-surface: var(--bg-2); --toast-ink: var(--ink); --toast-border: var(--line-strong);
      --tw-accent: 46 91 255;
    }}
    *, *::before, *::after {{ box-sizing: border-box; }}
    html {{ scroll-padding-top: 96px; }}
    body {{ margin: 0; background: var(--background); color: var(--ink); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; line-height: 1.7; min-height: 100vh; }}
    body::before {{ content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; will-change: transform;
      background-image: linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
      background-size: 64px 64px;
      mask-image: radial-gradient(ellipse at 50% 0%, #000 0%, rgba(0,0,0,0.4) 60%, transparent 100%);
      -webkit-mask-image: radial-gradient(ellipse at 50% 0%, #000 0%, rgba(0,0,0,0.4) 60%, transparent 100%); }}
    header, main, footer {{ position: relative; z-index: 1; }}
    a {{ color: var(--brand-2); }}
    .container-x {{ max-width: 1240px; margin: 0 auto; padding: 0 32px; }}
    .chip {{ display: inline-flex; align-items: center; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(74,123,255,0.4); color: var(--ink); background: linear-gradient(135deg, rgba(46,91,255,0.18), rgba(74,123,255,0.08)); }}
    .mono-label {{ font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-faint); }}
    .btn-primary {{ display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 600; color: var(--ink); text-decoration: none; white-space: nowrap;
      background: linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 100%); border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 8px 30px var(--brand-glow), inset 0 1px 0 rgba(255,255,255,0.15); transition: transform .15s ease, box-shadow .2s ease; }}
    .btn-primary:hover {{ transform: translateY(-1px); box-shadow: 0 12px 40px var(--brand-glow), inset 0 1px 0 rgba(255,255,255,0.2); }}

    .site-header {{ position: sticky; top: 0; z-index: 50; background: rgba(7,9,15,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }}
    .site-header .bar {{ display: flex; align-items: center; justify-content: space-between; height: 80px; gap: 16px; }}
    .brand {{ display: flex; align-items: center; gap: 10px; text-decoration: none; }}
    .brand img {{ height: 48px; width: auto; display: block; }}
    .site-nav {{ display: flex; align-items: center; gap: 28px; }}
    .site-nav a {{ color: var(--ink-dim); font-size: 14px; font-weight: 500; text-decoration: none; transition: color .15s; }}
    .site-nav a:hover {{ color: var(--ink); }}

    main {{ max-width: 820px; margin: 0 auto; padding: 56px 32px 24px; }}
    .doc-hero h1 {{ font-size: clamp(2rem, 4vw, 2.75rem); line-height: 1.15; letter-spacing: -0.02em; font-weight: 700; margin: 14px 0 12px; color: var(--ink); }}
    .doc-hero .tagline {{ color: var(--ink-dim); font-size: 17px; margin: 0 0 32px; }}
    main p, main li {{ color: var(--ink-dim); font-size: 15.5px; }}
    main strong {{ color: var(--ink); font-weight: 600; }}
    main h2 {{ font-size: 1.35rem; letter-spacing: -0.01em; font-weight: 650; }}
    main h3 {{ font-size: 1.08rem; font-weight: 600; }}
    main ul {{ padding-left: 1.25rem; }}
    main li {{ margin: 0.45rem 0; }}
    main li::marker {{ color: var(--brand-2); }}
    main code {{ font-family: var(--font-mono); font-size: 0.86em; background: var(--bg-3); border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; color: var(--ink); }}
    main a {{ text-decoration: underline; text-decoration-color: rgba(74,123,255,0.4); text-underline-offset: 4px; }}
    main a:hover {{ color: var(--ink); }}
    main hr {{ border: none; border-top: 1px solid var(--line-strong); margin: 2rem 0; }}

    .site-footer {{ border-top: 1px solid var(--line); padding: 64px 0; margin-top: 64px; }}
    .footer-top {{ display: flex; justify-content: space-between; align-items: flex-start; gap: 40px; flex-wrap: wrap; }}
    .footer-brand img {{ height: 40px; width: auto; display: block; }}
    .footer-brand p {{ margin: 16px 0 0; max-width: 28rem; color: var(--ink-dim); font-size: 15px; line-height: 1.6; }}
    .footer-col {{ display: flex; flex-direction: column; gap: 12px; }}
    .socials {{ display: flex; flex-wrap: wrap; gap: 16px; max-width: 240px; }}
    .social {{ display: inline-flex; color: var(--ink-dim); transition: color .2s ease, transform .2s ease; }}
    .social:hover {{ color: var(--brand-color, var(--ink)); transform: translateY(-2px); }}
    .account-link {{ color: var(--ink); font-size: 18px; text-decoration: none; transition: color .2s; }}
    .account-link:hover {{ color: var(--brand-2); }}
    .glow-divider {{ height: 1px; margin: 40px 0; background: linear-gradient(90deg, transparent, var(--line-strong), transparent); }}
    .footer-bottom {{ display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); }}
    .footer-bottom nav {{ display: flex; gap: 24px; flex-wrap: wrap; }}
    .footer-bottom a, .footer-bottom button {{ color: var(--ink-faint); text-decoration: none; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }}
    .footer-bottom a:hover, .footer-bottom button:hover, .footer-bottom a[aria-current="page"] {{ color: var(--ink-dim); }}

    @media (max-width: 860px) {{ .site-nav {{ display: none; }} }}
    @media (max-width: 720px) {{
      .container-x {{ padding: 0 16px; }}
      main {{ padding: 40px 16px 16px; }}
      .brand img {{ height: 40px; }}
      .site-header .bar {{ height: 68px; }}
    }}
  </style>
  <script src="/analytics-consent.js"></script>
</head>
<body>
  <header class="site-header">
    <div class="container-x bar">
      <a class="brand" href="https://vodou.ai/"><img src="/images/vodou-logo-full.png" alt="Vodou OS" width="182" height="48"><span class="chip">Alpha</span></a>
      <nav class="site-nav" aria-label="Site">
        <a href="https://vodou.ai/#how">How it Works</a>
        <a href="https://vodou.ai/#product">Product</a>
        <a href="https://vodou.ai/#compare">Compare</a>
        <a href="https://vodou.ai/#pricing">Pricing</a>
        <a href="https://vodou.ai/#enterprise">Enterprise</a>
        <a href="https://vodou.ai/#faq">FAQ</a>
      </nav>
      <a class="btn-primary" href="https://vodou.ai/#download">Download Vodou</a>
    </div>
  </header>
  <main>
    <div class="doc-hero">
      <span class="mono-label">Legal</span>
      <h1>{hero}</h1>
      <p class="tagline">{tagline}</p>
    </div>
{body}
  </main>
  <footer class="site-footer">
    <div class="container-x">
      <div class="footer-top">
        <div class="footer-brand">
          <a class="brand" href="https://vodou.ai/"><img src="/images/vodou-logo-full.png" alt="Vodou OS" width="152" height="40"><span class="chip">Alpha</span></a>
          <p>Local-first, model-independent agent harness with persistent memory, MCP orchestration, skills &amp; tools.</p>
        </div>
        <div class="footer-col">
          <span class="mono-label">Community</span>
          <div class="socials">
            """ + SOCIAL_ICONS_HTML.replace("{", "{{").replace("}", "}}") + """
          </div>
        </div>
        <div class="footer-col">
          <span class="mono-label">Account</span>
          <a class="account-link" href="/login">Login</a>
        </div>
      </div>
      <div class="glow-divider"></div>
      <div class="footer-bottom">
        <div>©2026 Vodou Inc. — All Rights Reserved.</div>
        <nav aria-label="Legal">
          <a href="/terms.html">Terms</a>
          <a href="/privacy.html">Privacy</a>
          <a href="/eula.html">EULA</a>
          <button type="button" data-cookie-settings>Cookie settings</button>
        </nav>
      </div>
    </div>
  </footer>
</body>
</html>
"""


def inline(text: str) -> str:
    """Escape, then apply **bold**, `code`, [text](url)."""
    text = html.escape(text, quote=False)
    # Pull `code` spans out first so literal ** inside them (e.g. `src/**`)
    # survives the bold pass.
    spans: list[str] = []

    def _stash(m: re.Match) -> str:
        spans.append(m.group(1))
        return f"\x00CODE{len(spans) - 1}\x00"

    text = re.sub(r"`([^`]+)`", _stash, text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    # bare canonical URLs (not already inside a tag)
    text = re.sub(r"(?<![\"=>])(https://(?:app\.)?vodou\.ai/[\w.\-/]+)", r'<a href="\1">\1</a>', text)
    for i, code in enumerate(spans):
        text = text.replace(f"\x00CODE{i}\x00", f"<code>{code}</code>")
    return text


# A list item may wrap onto indented continuation lines, and may hold more than
# one paragraph (a blank line, then more indented text). The converter used to
# treat each wrapped line as a new paragraph, which closed the list after the
# item's first line and printed the rest as loose paragraphs: the privacy
# policy's version history rendered that way from 1.5 to 1.8.
PARA_BREAK = "\x00PARA\x00"


def join_wrapped_list_items(md: str) -> list[str]:
    out: list[str] = []
    blanks = 0
    for line in md.splitlines():
        if not line.strip():
            blanks += 1
            continue
        continues_item = (
            line.startswith("  ")
            and not line.lstrip().startswith("- ")
            and bool(out)
            and out[-1].lstrip().startswith("- ")
        )
        if continues_item:
            out[-1] += (PARA_BREAK if blanks else " ") + line.strip()
        else:
            out.extend([""] * blanks)
            out.append(line)
        blanks = 0
    out.extend([""] * blanks)
    return out


def md_to_html(md: str) -> str:
    lines = join_wrapped_list_items(md)
    out: list[str] = []
    para: list[str] = []
    in_list = False

    def flush_para():
        nonlocal para
        if para:
            out.append(f"        <p>{inline(' '.join(para))}</p>")
            para = []

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("        </ul>")
            in_list = False

    for line in lines:
        s = line.strip()
        if s.startswith("# "):  # H1 → rendered as page hero, skip
            continue
        if s.startswith("## "):
            flush_para(); close_list()
            out.append(f'        <h2 style="color:var(--text-primary);margin:2.2rem 0 0.8rem;">{inline(s[3:])}</h2>')
        elif s.startswith("### "):
            flush_para(); close_list()
            out.append(f'        <h3 style="color:var(--text-primary);margin:1.6rem 0 0.6rem;">{inline(s[4:])}</h3>')
        elif s == "---":
            flush_para(); close_list()
            out.append('        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:2rem 0;">')
        elif s.startswith("- "):
            flush_para()
            if not in_list:
                out.append("        <ul>")
                in_list = True
            out.append(f"          <li>{inline(s[2:]).replace(PARA_BREAK, '<br><br>')}</li>")
        elif s == "":
            flush_para(); close_list()
        else:
            if in_list:
                close_list()
            para.append(s)
    flush_para(); close_list()
    return "\n".join(out)


def main() -> None:
    for page in PAGES:
        md = page["md"].read_text(encoding="utf-8")
        body = md_to_html(md)
        html_out = TEMPLATE.format(title=page["title"], hero=page["hero"], tagline=page["tagline"], body=body)
        page["out"].write_text(html_out, encoding="utf-8")
        print(f"✓ {page['out'].relative_to(ROOT)}  ({len(html_out)//1024} KB)")

        # Self-contained copy for app.vodou.ai (live canonical until vodou.ai exists)
        app_out = APP_PUBLIC / page["out"].name
        app_html = APP_TEMPLATE.format(title=page["title"], hero=page["hero"], tagline=page["tagline"], body=body)
        app_out.write_text(app_html, encoding="utf-8")
        print(f"✓ {app_out.relative_to(ROOT)}  ({len(app_html)//1024} KB)")


if __name__ == "__main__":
    main()
