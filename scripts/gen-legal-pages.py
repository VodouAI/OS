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


APP_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fff; color: #343a40; line-height: 1.7; }}
    .topbar {{ background: #111317; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }}
    .topbar a {{ color: #fff; text-decoration: none; font-weight: 700; }}
    .topbar .links a {{ font-weight: 400; font-size: 14px; opacity: 0.85; margin-left: 16px; }}
    .topbar .links a:hover {{ opacity: 1; }}
    main {{ max-width: 820px; margin: 0 auto; padding: 32px 20px 64px; }}
    h1 {{ font-size: 1.9rem; color: #111317; margin: 0.5rem 0 0.4rem; }}
    .tagline {{ color: #6b7280; margin: 0 0 1.5rem; }}
    h2 {{ color: #111317; margin: 2.2rem 0 0.8rem; font-size: 1.25rem; }}
    h3 {{ color: #111317; margin: 1.6rem 0 0.6rem; font-size: 1.05rem; }}
    a {{ color: #2563EB; }}
    code {{ background: #f1f3f5; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }}
    hr {{ border: none; border-top: 1px solid #e5e7eb; margin: 2rem 0; }}
    footer {{ border-top: 1px solid #e5e7eb; margin-top: 48px; padding: 20px 24px; font-size: 13px; color: #6b7280; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }}
  </style>
</head>
<body>
  <nav class="topbar">
    <a href="/">🔮 Vodou</a>
    <span class="links"><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><a href="/eula.html">EULA</a></span>
  </nav>
  <main>
    <h1>{hero}</h1>
    <p class="tagline">{tagline}</p>
{body}
  </main>
  <footer>
    <span>© 2026 Vodou Inc. All rights reserved.</span>
    <span><a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy</a> · <a href="/eula.html">EULA</a></span>
  </footer>
</body>
</html>
"""


def inline(text: str) -> str:
    """Escape, then apply **bold**, `code`, [text](url)."""
    text = html.escape(text, quote=False)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    # bare canonical URLs (not already inside a tag)
    text = re.sub(r"(?<![\"=>])(https://(?:app\.)?vodou\.ai/[\w.\-/]+)", r'<a href="\1">\1</a>', text)
    return text


def md_to_html(md: str) -> str:
    lines = md.splitlines()
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
            out.append(f"          <li>{inline(s[2:])}</li>")
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
