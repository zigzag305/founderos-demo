"""Audit Machine, step 1: turn a prospect's website into a strategy-ready dossier.

Crawls a target site (and any competitors you name), picks the pages that carry
commercial signal, and writes three files:

  dossier.md   one document you paste into the strategy step
  intake.json  pre-filled answers for /digital-marketing-pro:brand-setup
  pages.json   the raw per-page capture, so nothing is lost

Everything above the crawl itself is a pure function, so the interesting logic
is testable without touching the network (see test_dossier.py).
"""

import argparse
import asyncio
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse

# Pages worth spending a crawl budget on, highest commercial signal first. The
# weight is what ranks a discovered link; the label is what groups it in the
# dossier so a reader can find the pricing section without hunting.
PAGE_SIGNALS: list[tuple[str, int, str]] = [
    (r"/(pricing|prices|plans|packages|rates|cost)", 100, "pricing"),
    (r"/(services|solutions|what-we-do|offerings|products)", 90, "offer"),
    (r"/(case-stud|portfolio|our-work|results|clients)", 80, "proof"),
    (r"/(about|who-we-are|team|story)", 70, "about"),
    (r"/(contact|book|quote|consultation|demo|get-started)", 65, "conversion"),
    (r"/(testimonial|review)", 60, "proof"),
    (r"/(blog|insights|resources|guides|articles)", 30, "content"),
    (r"/(faq|help|support)", 25, "support"),
]

# Anything matching these is noise in a commercial audit.
EXCLUDE = re.compile(
    r"\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|css|js)$"
    r"|/(privacy|terms|cookie|legal|sitemap|login|signin|register|cart|checkout|wp-|tag/|author/|feed)",
    re.I,
)

PRICE = re.compile(r"[£$€]\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:k|m|per|/)\s?\w+)?", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")
PHONE = re.compile(r"(?:\+\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?){2,3}\d{3,4}")
SOCIAL = re.compile(
    r"https?://(?:www\.)?(linkedin|twitter|x|facebook|instagram|youtube|tiktok)\.com/[^\s\"'<>)]+",
    re.I,
)
# Verbs that front a call to action. Deliberately short: a long list starts
# matching body copy and the signal drowns.
CTA = re.compile(
    r"\b(book|get|start|claim|request|schedule|call|try|download|join|talk to)\b[^.!?\n]{3,45}",
    re.I,
)


@dataclass
class Page:
    """One captured page, reduced to the parts an audit actually reads."""

    url: str
    role: str = "other"
    ok: bool = True
    title: str = ""
    description: str = ""
    headings: list[str] = field(default_factory=list)
    prices: list[str] = field(default_factory=list)
    ctas: list[str] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    socials: list[str] = field(default_factory=list)
    word_count: int = 0
    excerpt: str = ""
    error: str = ""


def classify(url: str) -> tuple[int, str]:
    """Score a URL's commercial signal and name the section it belongs to."""
    path = urlparse(url).path.lower().rstrip("/") or "/"
    if path == "/":
        return 110, "home"
    for pattern, weight, label in PAGE_SIGNALS:
        if re.search(pattern, path):
            # Shallow pages beat deep ones: /pricing outranks /blog/x/pricing-2.
            return weight - path.count("/"), label

    return 10 - path.count("/"), "other"


def same_site(a: str, b: str) -> bool:
    """True when two URLs share a registrable-ish host (www is not a subdomain)."""
    ha = urlparse(a).netloc.lower().removeprefix("www.")
    hb = urlparse(b).netloc.lower().removeprefix("www.")
    return ha == hb


def normalise(url: str) -> str:
    """Drop fragments, tracking params and trailing slashes so we crawl once."""
    p = urlparse(url)
    if not p.scheme:
        return ""
    query = "&".join(
        q
        for q in p.query.split("&")
        if q and not q.lower().startswith(("utm_", "fbclid", "gclid", "ref="))
    )
    path = p.path.rstrip("/") or "/"
    return f"{p.scheme}://{p.netloc.lower()}{path}" + (f"?{query}" if query else "")


def pick_pages(home: str, links: list[str], budget: int) -> list[tuple[str, str]]:
    """Choose which discovered links to crawl, best commercial signal first.

    Returns (url, role) pairs including the homepage, capped at `budget`, with
    at most two pages per role so one fat blog doesn't eat the whole crawl.
    """
    seen: set[str] = set()
    scored: list[tuple[int, str, str]] = []
    for raw in links:
        url = normalise(urljoin(home, raw))
        if not url or url in seen or not same_site(home, url) or EXCLUDE.search(url):
            continue
        seen.add(url)
        score, role = classify(url)
        scored.append((score, url, role))

    scored.sort(key=lambda s: (-s[0], s[1]))

    chosen: list[tuple[str, str]] = [(normalise(home), "home")]
    per_role: dict[str, int] = {}
    for _, url, role in scored:
        if len(chosen) >= budget:
            break
        if url == chosen[0][0]:
            continue
        cap = 3 if role in ("offer", "pricing") else 2
        if per_role.get(role, 0) >= cap:
            continue
        per_role[role] = per_role.get(role, 0) + 1
        chosen.append((url, role))
    return chosen


def _dedupe(values, limit: int) -> list[str]:
    """Order-preserving dedupe, trimmed and capped."""
    out: list[str] = []
    for v in values:
        v = " ".join(str(v).split())
        if v and v not in out:
            out.append(v)
        if len(out) >= limit:
            break
    return out


def extract(url: str, role: str, markdown: str, metadata: dict) -> Page:
    """Reduce one page's markdown into the audit signals we care about."""
    text = markdown or ""
    headings = [
        line.lstrip("#").strip()
        for line in text.splitlines()
        if line.startswith("#") and len(line.strip()) > 2
    ]
    body = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
    return Page(
        url=url,
        role=role,
        title=(metadata or {}).get("title", "") or "",
        description=(metadata or {}).get("description", "") or "",
        headings=_dedupe(headings, 12),
        prices=_dedupe(PRICE.findall(text), 12),
        ctas=_dedupe((m.group(0) for m in CTA.finditer(text)), 8),
        emails=_dedupe(EMAIL.findall(text), 5),
        phones=_dedupe((m for m in PHONE.findall(text) if len(re.sub(r"\D", "", m)) >= 9), 3),
        socials=_dedupe((m.group(0) for m in SOCIAL.finditer(text)), 6),
        word_count=len(text.split()),
        excerpt=" ".join(body.split())[:600],
    )


def build_intake(brand: str, site: str, pages: list[Page], competitors: list[str]) -> dict:
    """Pre-fill the five questions /digital-marketing-pro:brand-setup asks.

    Every value carries the URL it came from, so the operator can check a claim
    in one click instead of trusting the crawl. Anything the site does not say
    is left empty and flagged in `needs_human` — never guessed.
    """
    home = next((p for p in pages if p.role == "home"), pages[0] if pages else None)
    offers = [p for p in pages if p.role in ("offer", "pricing")]
    # A one-page site has no /services URL, but its homepage headings are the
    # offer list. Falling back keeps small local businesses from coming out blank.
    if not offers and home:
        offers = [home]

    # The homepage h1 is usually the company name, not something it sells.
    # Listing "Harbour Legal" as an offer reads as a broken crawl in a
    # deliverable, so drop headings that just restate the brand or title.
    not_an_offer = {
        n.lower()
        for n in (brand, brand.replace("-", " "), home.title if home else "")
        if n
    }
    offer_headings = [
        h for p in offers for h in p.headings if h.lower().strip() not in not_an_offer
    ]
    pitch = (home.description or (home.headings[0] if home.headings else "")) if home else ""

    intake = {
        "brand_name": brand,
        "site": site,
        "captured": date.today().isoformat(),
        "elevator_pitch": {"value": pitch, "source": home.url if home else site},
        "offers": {
            "value": _dedupe(offer_headings, 12),
            "source": [p.url for p in offers],
        },
        "pricing_signals": {
            "value": _dedupe([pr for p in pages for pr in p.prices], 15),
            "source": [p.url for p in pages if p.prices],
        },
        "calls_to_action": {
            "value": _dedupe([c for p in pages for c in p.ctas], 10),
            "source": [p.url for p in pages if p.ctas],
        },
        "channels_observed": {
            "value": sorted({
                re.search(SOCIAL, s).group(1).lower()
                for p in pages
                for s in p.socials
                if re.search(SOCIAL, s)
            }),
            "source": [p.url for p in pages if p.socials],
        },
        "contact": {
            "emails": _dedupe([e for p in pages for e in p.emails], 5),
            "phones": _dedupe([t for p in pages for t in p.phones], 3),
        },
        "competitors": competitors,
        "pages_captured": len([p for p in pages if p.ok]),
    }

    # Things the website cannot tell you. Naming them is the point: it stops the
    # strategy step inventing an audience it has no evidence for.
    needs_human = ["target_audience_detail", "brand_voice_words", "budget_and_targets"]
    if not intake["elevator_pitch"]["value"]:
        needs_human.append("elevator_pitch")
    if not intake["pricing_signals"]["value"]:
        needs_human.append("pricing_not_public")
    intake["needs_human"] = needs_human
    return intake


def render_dossier(brand: str, site: str, pages: list[Page], competitors: dict[str, list[Page]], intake: dict) -> str:
    """Render the single Markdown file the strategy step consumes."""
    out: list[str] = [
        f"# Audit dossier — {brand}",
        "",
        f"- **Site:** {site}",
        f"- **Captured:** {intake['captured']}",
        f"- **Pages captured:** {intake['pages_captured']}",
        f"- **Competitors crawled:** {len(competitors)}",
        "",
        "> Generated by the Audit Machine. Every claim below is quoted from the",
        "> public website at the URL given. Nothing here is inferred.",
        "",
        "## What the site says it sells",
        "",
    ]
    pitch = intake["elevator_pitch"]["value"]
    out.append(f"{pitch}  \n*— {intake['elevator_pitch']['source']}*" if pitch else "*No elevator pitch found on the homepage — this is itself a finding.*")
    out += ["", "### Offers named on the site", ""]
    out += [f"- {o}" for o in intake["offers"]["value"]] or ["- *None found.*"]

    out += ["", "### Public pricing", ""]
    out += [f"- `{p}`" for p in intake["pricing_signals"]["value"]] or [
        "- *No public pricing. Note this — it shapes the whole funnel recommendation.*"
    ]

    out += ["", "### Calls to action in use", ""]
    out += [f"- {c}" for c in intake["calls_to_action"]["value"]] or ["- *No clear CTA found.*"]

    channels = intake["channels_observed"]["value"]
    out += ["", "### Channels the site links to", "", ", ".join(channels) if channels else "*None linked.*"]

    out += ["", "## Page-by-page capture", ""]
    for p in pages:
        if not p.ok:
            out += [f"### ~~{p.url}~~ ({p.role})", "", f"Failed: {p.error}", ""]
            continue
        out += [
            f"### {p.title or p.url}",
            "",
            f"`{p.role}` · {p.url} · {p.word_count} words",
            "",
        ]
        if p.description:
            out += [f"**Meta:** {p.description}", ""]
        if p.headings:
            out += ["**Headings:** " + " · ".join(p.headings[:8]), ""]
        if p.excerpt:
            out += [f"> {p.excerpt}", ""]

    if competitors:
        out += ["## Competitors", ""]
        for curl, cpages in competitors.items():
            chome = next((c for c in cpages if c.role == "home"), None)
            out += [f"### {curl}", ""]
            if chome:
                out += [f"**Positioning:** {chome.description or (chome.headings[0] if chome.headings else '—')}", ""]
            cprices = _dedupe([pr for c in cpages for pr in c.prices], 8)
            out += ["**Pricing on show:** " + (", ".join(f"`{x}`" for x in cprices) if cprices else "none public"), ""]
            coffers = _dedupe([h for c in cpages for h in c.headings], 10)
            if coffers:
                out += ["**Offers:** " + " · ".join(coffers), ""]

    out += [
        "## What the website cannot tell you",
        "",
        "Answer these from the client before the strategy run, or the output will",
        "be confidently wrong:",
        "",
    ]
    out += [f"- [ ] {item.replace('_', ' ')}" for item in intake["needs_human"]]
    out += [""]
    return "\n".join(out)


async def crawl(urls: list[tuple[str, str]], proxy: str | None = None) -> list[Page]:
    """Fetch pages and reduce each to a Page. Import is local so the pure
    functions above can be tested without crawl4ai installed."""
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    browser = BrowserConfig(headless=True, verbose=False, proxy=proxy)
    run = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=45_000)
    pages: list[Page] = []
    async with AsyncWebCrawler(config=browser) as crawler:
        for url, role in urls:
            try:
                res = await crawler.arun(url, config=run)
                if not res.success:
                    pages.append(Page(url=url, role=role, ok=False, error=res.error_message or "crawl failed"))
                    continue
                md = res.markdown.raw_markdown if res.markdown else ""
                pages.append(extract(url, role, md, res.metadata or {}))
            except Exception as exc:  # one bad page must not lose the run
                pages.append(Page(url=url, role=role, ok=False, error=str(exc)[:300]))
    return pages


async def discover(home: str, budget: int, proxy: str | None) -> list[tuple[str, str]]:
    """Crawl the homepage once to find its internal links, then rank them."""
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    async with AsyncWebCrawler(config=BrowserConfig(headless=True, verbose=False, proxy=proxy)) as c:
        res = await c.arun(home, config=CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=45_000))
        links = [l.get("href", "") for l in (res.links or {}).get("internal", [])] if res.success else []
    return pick_pages(home, links, budget)


async def run(args) -> int:
    site = normalise(args.site)
    out_dir = Path(args.out) / args.brand / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[1/3] discovering pages on {site}", file=sys.stderr)
    targets = await discover(site, args.max_pages, args.proxy)
    print(f"      {len(targets)} pages selected: {', '.join(r for _, r in targets)}", file=sys.stderr)

    print("[2/3] capturing target", file=sys.stderr)
    pages = await crawl(targets, args.proxy)

    competitors: dict[str, list[Page]] = {}
    for comp in args.competitor:
        curl = normalise(comp)
        print(f"[2/3] capturing competitor {curl}", file=sys.stderr)
        ctargets = await discover(curl, args.competitor_pages, args.proxy)
        competitors[curl] = await crawl(ctargets, args.proxy)

    print("[3/3] writing dossier", file=sys.stderr)
    intake = build_intake(args.brand, site, pages, [normalise(c) for c in args.competitor])
    (out_dir / "dossier.md").write_text(
        render_dossier(args.brand, site, pages, competitors, intake), encoding="utf-8"
    )
    (out_dir / "intake.json").write_text(json.dumps(intake, indent=2), encoding="utf-8")
    (out_dir / "pages.json").write_text(
        json.dumps(
            {
                "target": [asdict(p) for p in pages],
                "competitors": {k: [asdict(p) for p in v] for k, v in competitors.items()},
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    failed = [p for p in pages if not p.ok]
    print(f"\nWrote {out_dir}/dossier.md", file=sys.stderr)
    if failed:
        print(f"WARNING: {len(failed)} page(s) failed — see pages.json", file=sys.stderr)
    print(f"\nNext: /digital-marketing-pro:brand-setup  (answers in {out_dir}/intake.json)", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="dossier",
        description="Turn a prospect's website into a strategy-ready audit dossier.",
    )
    ap.add_argument("--brand", required=True, help="short slug, e.g. acme-plumbing")
    ap.add_argument("--site", required=True, help="the prospect's homepage URL")
    ap.add_argument("--competitor", action="append", default=[], help="repeatable")
    ap.add_argument("--max-pages", type=int, default=12, help="crawl budget for the target")
    ap.add_argument("--competitor-pages", type=int, default=5)
    ap.add_argument("--out", default="out", help="output directory")
    ap.add_argument("--proxy", default=None, help="http://host:port if you need one")
    args = ap.parse_args(argv)
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
