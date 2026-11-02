# Courtroom redesign

Design for restyling the courtroom web app (`courtroom/`) in the Agentic Hub visual language, with a shared nav bar, footer, speaker section and responsive layouts. Decided with the host on the day; the talk is on 5 November and the redesign ships tonight so it can be rehearsed on.

## Intent

The courtroom is the audience-facing half of the talk "Can We Trust the Machines? A Live Trial": a home page people land on from the QR code or a link, a live transcript, an evidence board on the projector, a vote page on phones, and exhibit pages with a verify button. Today it is functional but unstyled: default dark page, no navigation, no identity, no speakers, and the home page is a title and a QR code.

The Agentic Hub programme already has a visual identity on its speaker banners. The app should look like it belongs to that programme, so a person who saw the banner on X and then scans the QR code in the room recognises it immediately.

## Goals

- Every public page shares one look: nav bar with the logo top left (always links to `/`), footer with the speakers' and companies' X accounts, one type system, one palette.
- Home page says "An Agent on Trial" as the headline, "Can We Trust the Machines? A Live Trial" as the subtitle, and presents the three speakers.
- Works on phones (the vote page is used on phones in the room), laptops and the 1920x1080 projector.
- Good UI/UX quality: consistent spacing, readable type, focus states, no layout shifts while polling.

## Non-goals

- No change to the terminal agent, the acts, the chain code or the API routes. The redesign touches only pages, components and styles under `courtroom/`, plus static assets. The terminal keeps posting to the same endpoints and the data contracts stay the same.
- No new features beyond navigation, footer, speakers and the projector band toggle.
- No light theme.

## Anti-goals (what would make it a failure)

- A projector page that no longer fits 1920x1080 without scrolling, or that loses the big tally and verdict.
- A vote page that needs scrolling on a phone before the two buttons are visible.
- Polling pages that jump or flicker as data arrives.
- Any secret or host control exposed to the public.

## Visual language (from the speaker banner S52)

- **Background:** near-black with a green cast, about `#0b0f0d`, with a faint square grid (1px lines, roughly 4 percent white) and soft mint glows in the corners.
- **Accent:** mint `#a8e6c3` (the centre node of the logo; the date pill border and the location line on the banner). Used for pills, links, active states, the Trust side of the tally.
- **Negative:** keep the current red for Don't trust and failures, tuned to sit with the mint.
- **Text:** white for headings, about 70 percent white for body, about 45 percent for captions.
- **Type:** everything monospace, as on the banner. Headlines bold and tight, captions letter-spaced uppercase for labels and the date pill. Web font: JetBrains Mono via `next/font/google` (builder's call; the banner's exact font is not confirmed as licensed for the web). Fallback to the system mono stack.
- **Shapes:** rounded pills (full radius) for labels, 12 to 16px radius for cards, 1px borders at about 12 percent white. Circular avatars with a mint ring.
- **Logo:** the Agentic Hub mark, a triangle of three white nodes with a mint node in the centre and grey edges. Recreated as an inline SVG from the attached image so it is crisp at any size (builder's call; the attached file is a raster screenshot with background). Wordmark next to it: "Agentic Hub" bold mono, with "AN AGENT ON TRIAL" as the small letter-spaced line under it.

## Pages

**Shared shell** (all pages except `/projector` and `/property`): nav bar (logo left linking to `/`; links Home, Live log, Evidence board, Vote; on phones a compact row), content, footer. The Evidence board is a 1920x1080 layout, so its nav link and the exhibit page's "Back to the board" link are shown from the `md` breakpoint up and hidden on phones (builder's call). Footer: "Speakers" row with X links; "Built with" row: Celo, Swarm, Kleros, askbots.ai, usebuy.ai, x402.celo.org; small print with the GitHub repo link.

**Speakers** (from the speaker intake sheet and the banner):

| Name | Role | Company | X link |
|---|---|---|---|
| Lena Hierzi | DevRel Lead | Celo Core Co. | https://x.com/GigaHierz |
| Fortunato Cinquepalmi | Product Lead | Kleros | https://x.com/fortuvp |
| András Arányi | CTO | Solar Punk | https://x.com/ethswarm (Swarm's account; he has no personal one, host's choice) |

Photos: initials avatars with the mint ring by default. If headshot files are added to `public/speakers/` later, the cards use them. The banner crops are too low-resolution to ship (builder's call).

**Home `/`:** hero with the date pill "5 NOVEMBER · 1:20 PM IST · AGENTIC HUB, DEVCON", headline "An Agent on Trial", subtitle "Can We Trust the Machines? A Live Trial", one paragraph (the current copy: a real agent mints an identity, earns, pays, gets sold junk and disputes it, all on Celo; the evidence is on chain; you decide). Primary button "Vote" (to `/vote?r=<round>`), secondary "Watch live". QR code card with the vote URL under it. Then "The speakers": three cards, avatar, name, role, company, X link. Then "How it works": the five acts as a compact numbered row (Identity, Earn, Spend, Dispute, Verdict), one line each. Keeps the Redis notice when Redis is not configured.

**Live `/live`:** same transcript, styled: a card with the tally bar at the top, lines in mono with the type badges (host, tool call, result, tx, warn) as small coloured labels. Max width about 900px, full width on phones.

**Vote `/vote`:** centred card. Question "Do you trust this agent?", two large buttons stacked on phones and side by side on wider screens, Trust in mint and Don't trust in red, status line under them. Everything above the fold on a phone.

**Exhibit `/exhibit/[id]`:** card with the exhibit letter badge, title, the JSON in a scrollable mono block, links as pills, the Verify button with its result states, "Back to the board" link.

**Property `/property/[runId]`:** no shell. This page is what the agent reads and reviews during the earn act, and askbots fetches it; adding nav, footer or speaker links would change the content the agent reviews. Restyle it in the same palette and type only. (Builder's call after the review.)

**Projector `/projector`:** no nav, no footer, fills 1920x1080. Same four columns with the letter badges and the board styling, plus the fixed bottom band (QR, tally bar, verdict) kept as it is. Add a small "hide" control at the band's edge that collapses it to a thin strip and expands it back, so the board is usable on a laptop. Columns scroll independently (already in main).

**Host pages `/bench`, `/cross`:** styled with the shell. Not in the nav. The host cookie gate stays as it is (the host asked for no password gate; the cookie is set once from the terminal link and the API routes still need the secret, so removing it would expose the controls to the public; the builder keeps the gate and this is flagged back to the host).

## Constraints

- Next.js 15 App Router, React 19, Tailwind v4. No component library added; a handful of small shared components (Shell, Nav, Footer, Card, Pill, Badge, Avatar, Button) written in the repo.
- Speaker photos: the banner has Fortunato's and András's; Lena's photo is not in the repo. Builder ships initials avatars with the mint ring as the default and swaps in photos from `public/speakers/` when the files exist.
- `NEXT_PUBLIC_COURTROOM_URL` and the QR logic stay as they are.
- Must pass `pnpm --filter courtroom typecheck` and `next build`.

## Left to the builder

- Exact spacing scale, breakpoints and type sizes within the language above.
- Grid and glow implementation (CSS gradients, no images).
- Nav behaviour on phones (compact row vs menu).
- How the band toggle remembers its state (local storage is fine).
