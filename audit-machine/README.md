# The Audit Machine

Turn a prospect's website into a paid strategy audit, in three steps.

```
crawl4ai  ──►  digital-marketing-pro  ──►  founderos-demo
 step 1          step 2                     step 3
 evidence        strategy                   delivery
```

**What it replaces:** the discovery call you have to run before you can quote,
and the week of desk research after it. Step 1 answers four of the five
questions `brand-setup` would otherwise ask you to interview the client for —
from their own public website, with a source URL on every claim.

**What it costs to run:** a few minutes of crawling, plus roughly $15–40 of
API spend for the strategy step.

---

## Step 1 — Evidence (this directory)

### Install, once

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
crawl4ai-setup                 # downloads the matching browser
```

> **Why playwright is pinned.** `crawl4ai` doesn't pin it, and playwright only
> runs the exact Chromium build its own version expects. Unpinned, an install
> six weeks from now fails with `Executable doesn't exist at .../chromium-<n>`.
> If you hit that anyway, `crawl4ai-setup` re-fetches the right one.

### Run it

```bash
python dossier.py \
  --brand acme-plumbing \
  --site https://acmeplumbing.co.uk \
  --competitor https://rival-one.co.uk \
  --competitor https://rival-two.co.uk \
  --max-pages 12
```

It crawls the homepage, ranks the internal links by commercial signal
(pricing > services > case studies > about > blog), captures the best of them
within your page budget, and writes to `out/<brand>/<date>/`:

| File | What it's for |
|---|---|
| `dossier.md` | The one document you hand to step 2 |
| `intake.json` | Pre-filled `brand-setup` answers, each with its source URL |
| `pages.json` | The full raw capture, so nothing is lost |

**Flags worth knowing:** `--max-pages` (target budget, default 12),
`--competitor-pages` (per competitor, default 5), `--out`, `--proxy`.

### What it deliberately will not do

`intake.json` ends with a `needs_human` list. The crawler never guesses a
target audience, a brand voice or a budget, because a website doesn't state
them — and a strategy built on an invented audience is confidently wrong in a
way the client will notice. Absence is reported as a finding:

- no public pricing → flagged, because it shapes the whole funnel recommendation
- no elevator pitch on the homepage → flagged, because that *is* the finding
- a page that failed to load → printed in the dossier, never silently dropped

---

## Step 2 — Strategy (`digital-marketing-pro`)

Install the plugin in Claude Code, once:

```
/plugin marketplace add indranilbanerjee/neels-plugins
/plugin install digital-marketing-pro@neels-plugins
/digital-marketing-pro:doctor
```

Then, per prospect:

**a. Create the brand profile.** Run `/digital-marketing-pro:brand-setup` and
answer from `intake.json` rather than from memory. Quick Setup asks five
questions; the crawl has already answered the pitch, the offers, the pricing
and the channels. You supply the two it can't know — the target audience and
the voice — which is a five-minute conversation, not a discovery call.

The profile lands at `~/.claude-marketing/brands/<brand-slug>/profile.json`.
`engagement start` refuses to run without it.

**b. Run the engagement.**

```
/digital-marketing-pro:engagement start acme-plumbing 2026-q3
```

Paste `dossier.md` when it asks for context. It walks the 12-Part flow and
writes the canonical file set. If it's interrupted, `/digital-marketing-pro:resume`
picks it back up — the run is checkpointed per part.

**c. Check before you send.** `/digital-marketing-pro:check --full`, and
`/digital-marketing-pro:output-folder acme-plumbing` to find the files.

---

## Step 3 — Delivery (`founderos-demo`)

A PDF is a one-time $3k. The same work behind a login the client checks every
Monday is a retainer. Surface the engagement in the console:

```bash
npm install && npm run dev      # http://localhost:4100
```

Per this repo's architecture rule, audit data reaches a page through the
repository layer — never straight from disk into a component. Adding a view
means: a repo method in `lib/db.ts`, a Zod schema in `lib/schemas.ts`, a seed
entry in `lib/seed.ts`, and a test in `tests/`. See the root `CLAUDE.md`.

---

## Selling it

The chain is worth more than the parts, so price the outcome, never the tooling.

- **Paid discovery.** $1,500–5,000 for the audit, credited against the first
  month if they sign. It costs you an hour and ~$30, and it disqualifies bad
  fits before you've spent a week on them.
- **Never lead with the crawl.** Nobody buys a crawler. They buy knowing what
  their competitors charge and why their site doesn't convert.
- **The `needs_human` list is a sales asset.** Walking in with "here are four
  things your website doesn't tell your customers" is a better opening than
  any deck.

### Before the first paying client

- **Crawl politely.** Honour `robots.txt` and keep the page budget low. This
  tool reads public pages the way a browser does; that is not a licence to
  hammer someone's server.
- **Verify before you invoice.** Every figure in `dossier.md` carries a source
  URL. Open a few. A crawl reads what a page says, not whether it's current.
- **Know where the data lives.** You are holding a third party's site content
  and a client's strategy. Decide retention before you collect, not after.
- **The plugin is someone else's.** `digital-marketing-pro` is MIT-licensed and
  maintained upstream by Indranil Banerjee. Check the licence before reselling
  and expect it to change under you. Your moat is the assembled chain.

---

## Tests

```bash
source .venv/bin/activate && python -m pytest -q
```

36 tests. The ranking, extraction, intake and rendering logic is pure and
tested directly; one `@pytest.mark.engine` test drives the real crawl4ai
pipeline against inline HTML, so the suite needs no network and runs anywhere.
Live fetching is the one thing only a real run can prove — do that against a
site you own before you point it at a prospect.
