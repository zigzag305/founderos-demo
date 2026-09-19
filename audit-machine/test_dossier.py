"""Tests for the Audit Machine dossier builder.

The ranking, extraction and rendering logic is pure, so it is tested directly.
The one end-to-end test drives the real crawl4ai engine against inline HTML
(`raw:`), which exercises the browser and the markdown pipeline without needing
network access — so this suite passes in CI and in a locked-down container.
"""

import asyncio
import json

import pytest

from dossier import (
    Page,
    build_intake,
    classify,
    extract,
    normalise,
    pick_pages,
    render_dossier,
    same_site,
)

ACME_HTML = """<html><head><title>Acme Plumbing</title>
<meta name="description" content="Emergency plumbers in Leeds, 24/7 callout">
</head><body>
<nav><a href="/pricing">Pricing</a><a href="/about">About</a></nav>
<h1>Leeds' fastest emergency plumbers</h1>
<p>Book a same-day visit from &pound;89. No call-out fee, ever.</p>
<h2>Our pricing</h2><ul><li>Callout &pound;89</li><li>Boiler service &pound;140</li></ul>
<a href="https://www.instagram.com/acmeplumbing">Instagram</a>
<a href="https://www.linkedin.com/company/acme-plumbing">LinkedIn</a>
<footer>hello@acmeplumbing.example &middot; 0113 496 0123</footer>
</body></html>"""


# --- URL handling ---------------------------------------------------------


def test_normalise_strips_tracking_fragments_and_trailing_slash():
    assert normalise("https://A.com/Path/?utm_source=x&id=7#top") == "https://a.com/Path?id=7"


def test_normalise_rejects_schemeless_input():
    assert normalise("/relative/only") == ""


def test_same_site_ignores_www():
    assert same_site("https://acme.com/a", "https://www.acme.com/b")
    assert not same_site("https://acme.com", "https://competitor.com")


@pytest.mark.parametrize(
    "url,role",
    [
        ("https://a.com/", "home"),
        ("https://a.com/pricing", "pricing"),
        ("https://a.com/services/boilers", "offer"),
        ("https://a.com/case-studies", "proof"),
        ("https://a.com/about-us", "about"),
        ("https://a.com/book-a-visit", "conversion"),
        ("https://a.com/blog/why-pipes-freeze", "content"),
        ("https://a.com/random", "other"),
    ],
)
def test_classify_assigns_expected_roles(url, role):
    assert classify(url)[1] == role


def test_classify_prefers_shallow_pages():
    assert classify("https://a.com/pricing")[0] > classify("https://a.com/x/y/pricing")[0]


def test_classify_ranks_commercial_above_editorial():
    assert classify("https://a.com/pricing")[0] > classify("https://a.com/blog")[0]


# --- page selection -------------------------------------------------------


def test_pick_pages_always_includes_home_first():
    picked = pick_pages("https://a.com", ["/blog"], budget=5)
    assert picked[0] == ("https://a.com/", "home")


def test_pick_pages_ranks_pricing_above_blog():
    picked = pick_pages("https://a.com", ["/blog/one", "/pricing"], budget=5)
    assert [r for _, r in picked] == ["home", "pricing", "content"]


def test_pick_pages_respects_budget():
    links = [f"/services/{i}" for i in range(20)]
    assert len(pick_pages("https://a.com", links, budget=4)) == 4


def test_pick_pages_caps_pages_per_role_so_a_blog_cannot_eat_the_budget():
    links = [f"/blog/post-{i}" for i in range(30)]
    roles = [r for _, r in pick_pages("https://a.com", links, budget=12)]
    assert roles.count("content") <= 2


def test_pick_pages_drops_offsite_assets_and_boilerplate():
    links = [
        "https://elsewhere.com/pricing",  # off-site
        "/brochure.pdf",                  # asset
        "/privacy-policy",                # boilerplate
        "/pricing",                       # keep
    ]
    urls = [u for u, _ in pick_pages("https://a.com", links, budget=10)]
    assert urls == ["https://a.com/", "https://a.com/pricing"]


def test_pick_pages_deduplicates_tracking_variants():
    links = ["/pricing", "/pricing/", "/pricing?utm_source=ads"]
    assert len(pick_pages("https://a.com", links, budget=10)) == 2


# --- extraction -----------------------------------------------------------


def _acme_page() -> Page:
    md = (
        "# Leeds' fastest emergency plumbers\n"
        "Book a same-day visit from £89. No call-out fee, ever.\n"
        "## Our pricing\n* Callout £89\n* Boiler service £140\n"
        "https://www.instagram.com/acmeplumbing\n"
        "hello@acmeplumbing.example 0113 496 0123\n"
    )
    return extract("https://a.com/", "home", md, {"title": "Acme", "description": "Emergency plumbers"})


def test_extract_pulls_prices_ctas_and_contacts():
    p = _acme_page()
    assert "£89" in p.prices and "£140" in p.prices
    assert any(c.lower().startswith("book") for c in p.ctas)
    assert p.emails == ["hello@acmeplumbing.example"]
    assert p.phones == ["0113 496 0123"]


def test_extract_keeps_full_social_urls_not_just_the_network_name():
    assert _acme_page().socials == ["https://www.instagram.com/acmeplumbing"]


def test_extract_keeps_the_whole_cta_phrase_not_just_the_verb():
    # Regression: a capture group in the CTA pattern used to reduce
    # "Book a same-day visit from £89" to the single word "Book".
    p = _acme_page()
    assert any(len(c.split()) > 2 for c in p.ctas), p.ctas
    assert "Book a same-day visit" in " | ".join(p.ctas)


def test_build_intake_falls_back_to_homepage_headings_for_one_page_sites():
    # Regression: a site with no /services page used to produce an empty
    # offer list, which made the dossier look like the crawl had failed.
    intake = build_intake("acme", "https://a.com", [_acme_page()], [])
    assert "Our pricing" in intake["offers"]["value"]


def test_extract_separates_headings_from_body_excerpt():
    p = _acme_page()
    assert "Our pricing" in p.headings
    assert "Our pricing" not in p.excerpt


def test_extract_survives_an_empty_page():
    p = extract("https://a.com/x", "other", "", {})
    assert p.word_count == 0 and p.prices == []


# --- intake ---------------------------------------------------------------


def test_build_intake_prefills_pitch_from_meta_description():
    pages = [_acme_page()]
    intake = build_intake("acme", "https://a.com", pages, [])
    assert intake["elevator_pitch"]["value"] == "Emergency plumbers"
    assert intake["elevator_pitch"]["source"] == "https://a.com/"


def test_build_intake_flags_what_the_website_cannot_answer():
    intake = build_intake("acme", "https://a.com", [_acme_page()], [])
    assert "target_audience_detail" in intake["needs_human"]
    assert "brand_voice_words" in intake["needs_human"]


def test_build_intake_flags_missing_public_pricing_as_a_finding():
    bare = extract("https://a.com/", "home", "# Hello\nWe do things.", {"title": "X"})
    intake = build_intake("acme", "https://a.com", [bare], [])
    assert "pricing_not_public" in intake["needs_human"]


def test_build_intake_never_invents_a_pitch_it_did_not_find():
    bare = extract("https://a.com/", "home", "", {})
    intake = build_intake("acme", "https://a.com", [bare], [])
    assert intake["elevator_pitch"]["value"] == ""
    assert "elevator_pitch" in intake["needs_human"]


def test_build_intake_lists_observed_channels():
    intake = build_intake("acme", "https://a.com", [_acme_page()], [])
    assert intake["channels_observed"]["value"] == ["instagram"]


def test_intake_is_json_serialisable():
    intake = build_intake("acme", "https://a.com", [_acme_page()], ["https://b.com"])
    assert json.loads(json.dumps(intake))["competitors"] == ["https://b.com"]


# --- rendering ------------------------------------------------------------


def test_render_dossier_includes_evidence_urls_and_human_checklist():
    pages = [_acme_page()]
    intake = build_intake("acme", "https://a.com", pages, [])
    md = render_dossier("acme", "https://a.com", pages, {}, intake)
    assert md.startswith("# Audit dossier — acme")
    assert "https://a.com/" in md
    assert "- [ ] target audience detail" in md


def test_render_dossier_calls_out_absent_pricing_rather_than_staying_silent():
    bare = extract("https://a.com/", "home", "# Hi", {"title": "X"})
    intake = build_intake("acme", "https://a.com", [bare], [])
    md = render_dossier("acme", "https://a.com", [bare], {}, intake)
    assert "No public pricing" in md


def test_render_dossier_reports_a_failed_page_instead_of_hiding_it():
    failed = Page(url="https://a.com/gone", role="offer", ok=False, error="timeout")
    intake = build_intake("acme", "https://a.com", [_acme_page()], [])
    md = render_dossier("acme", "https://a.com", [_acme_page(), failed], {}, intake)
    assert "Failed: timeout" in md


def test_render_dossier_contrasts_competitor_pricing():
    comp = extract("https://b.com/", "home", "# Rival\nFrom £299 a month", {"title": "Rival"})
    intake = build_intake("acme", "https://a.com", [_acme_page()], ["https://b.com"])
    md = render_dossier("acme", "https://a.com", [_acme_page()], {"https://b.com": [comp]}, intake)
    assert "£299" in md


# --- end to end through the real engine -----------------------------------


@pytest.mark.engine
def test_engine_produces_a_dossier_from_real_html():
    """Starts the real browser and runs the real scrape/markdown pipeline.

    `raw:` bypasses navigation, so this proves the engine and our extraction
    agree without needing network access. Live fetching is covered by running
    the CLI against a real site, which a sandbox cannot do.
    """
    from dossier import crawl

    pages = asyncio.run(crawl([(f"raw:{ACME_HTML}", "home")]))
    assert pages[0].ok, pages[0].error
    assert "£89" in pages[0].prices
    intake = build_intake("acme-plumbing", "https://acme.example", pages, [])
    md = render_dossier("acme-plumbing", "https://acme.example", pages, {}, intake)
    assert "Emergency plumbers in Leeds" in md


def test_build_intake_does_not_list_the_company_name_as_an_offer():
    # Regression: the homepage h1 is the brand, not something it sells, and
    # "Harbour Legal" appearing under Offers reads as a broken crawl.
    page = extract(
        "https://a.com/", "home",
        "# Harbour Legal\n## Commercial property\n## Employment law",
        {"title": "Harbour Legal"},
    )
    offers = build_intake("harbour-legal", "https://a.com", [page], [])["offers"]["value"]
    assert offers == ["Commercial property", "Employment law"]


def test_build_intake_still_keeps_offers_that_merely_contain_the_brand_word():
    page = extract(
        "https://a.com/", "home",
        "# Acme\n## Acme boiler cover",
        {"title": "Acme"},
    )
    offers = build_intake("acme", "https://a.com", [page], [])["offers"]["value"]
    assert offers == ["Acme boiler cover"]
