# Fonts

Two typefaces, self-hosted, because the console runs on a home server on a private network.

- **Geist** — the chrome: nav, headings, buttons, figures.
- **Inter** — everything inside a card.

Both are variable fonts covering weights 100–900, and the design uses non-integer weights
(520, 540, 560, 580, 620, 650) throughout. Loading a static cut instead would snap every one
of them to the nearest of four, which is most of the difference between this console and a
lookalike.

Two subsets of each are shipped: `latin` and `latin-ext`. The second is not optional here —
`ě ř š č ž ů` live in `latin-ext`, and a Czech operator reading a console that falls back
mid-word is a worse outcome than 100 KB.

## Why not a CDN

The app loads these through `next/font/google`. This console must not: it is served over
plain HTTP on a LAN address, often by a machine with no reason to reach the internet beyond
one LCD endpoint, and its content security policy names no remote origin at all. A font
request to a third party from a page that can set a signing key is a request worth not
making.

## Provenance

Extracted from the Google Fonts subsets that `next/font` had already fetched and cached for
`dscrt-app`, so the console and the app render from byte-identical files rather than from
two independently downloaded copies that could differ by a release.

Both families are licensed under the SIL Open Font License 1.1 — Geist by Vercel, Inter by
Rasmus Andersson. The licence travels with the fonts, not with this repository's Apache-2.0
code; see the upstream projects for the full text.
