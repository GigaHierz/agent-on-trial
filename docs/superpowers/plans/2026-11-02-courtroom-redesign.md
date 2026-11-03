# Courtroom Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the courtroom Next.js app in the Agentic Hub banner language with a shared nav, footer, speakers section and responsive layouts, without touching API routes or the terminal.

**Architecture:** A `(shell)` route group carries the nav and footer for the public and host pages; `/projector` and `/property` stay outside it. Theme tokens live in `globals.css` via Tailwind v4 `@theme`; a handful of small presentational components under `components/ui/` are reused by every page. Data fetching, polling and API contracts are unchanged.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind v4, `next/font/google` (JetBrains Mono), inline SVG.

**Spec:** `docs/superpowers/specs/2026-11-02-courtroom-redesign-design.md`

## Global Constraints

- Only files under `courtroom/` change. No edits to `courtroom/app/api/**`, `courtroom/lib/redis.ts`, `store.ts`, `chain.ts`, `host*.ts`, `middleware.ts`.
- Palette: background `#0b0f0d`, mint `#a8e6c3`, red stays `rose`, white headings, body 70 percent white, captions 45 percent white.
- Font: JetBrains Mono everywhere, system mono fallback.
- Headline copy: "An Agent on Trial"; subtitle "Can We Trust the Machines? A Live Trial"; date pill "4 NOVEMBER · 4:15 PM IST · JASMINE STAGE 4, DEVCON".
- Speakers exactly as the spec table (names, roles, companies, X links).
- `/projector` keeps `h-screen w-screen` with no scrolling at 1920x1080; `/property` gets no nav or footer.
- Host cookie gate stays.
- `pnpm --filter courtroom typecheck` and `pnpm --filter courtroom build` pass after every task.

## Review Focus

- A phone at 375px wide on `/vote`: both buttons visible without scrolling. Pinned in Task 5 by a Playwright screenshot at 375x667.
- `/projector` at 1920x1080 with 19 exhibits: no page scrollbar, columns scroll internally, band visible. Pinned in Task 7.
- Redis not configured: every shell page still renders nav and footer around the notice. Pinned in Task 3 by running the dev server with the KV variables unset once.
- Long exhibit titles and long tool-call lines on `/live`: wrap, never overflow horizontally. Pinned in Task 5 (live at 375px).
- Nav on phones: Evidence board link hidden below `md`, present at 1280px. Pinned in Task 3 screenshots.

---

### Task 1: Theme foundation

**Files:**
- Modify: `courtroom/app/globals.css`
- Modify: `courtroom/app/layout.tsx`
- Create: `courtroom/app/icon.svg`
- Modify: `courtroom/components/RedisNotice.tsx`

**Interfaces:**
- Produces: CSS custom properties via `@theme`: `--color-ink: #0b0f0d`, `--color-mint: #a8e6c3`, `--color-mint-deep: #5fbf8f`, `--color-line: rgba(255,255,255,0.12)`, `--color-fg: #ffffff`, `--color-fg-2: rgba(255,255,255,0.7)`, `--color-fg-3: rgba(255,255,255,0.45)`, `--font-mono: var(--font-jetbrains), ui-monospace, SFMono-Regular, Menlo, monospace`. Utility classes `bg-ink`, `text-mint`, `border-line`, `text-fg-2`, `text-fg-3` follow from Tailwind v4.
- Produces: class `grid-bg` on `body` (grid lines plus two radial mint glows, pure CSS gradients) and `.eyebrow` (uppercase, `letter-spacing: 0.18em`, 12px).

- [ ] **Step 1: Load the font in `layout.tsx`** with `JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })`, put `className={mono.variable}` on `<html>`, set body to `min-h-screen bg-ink font-mono text-fg antialiased grid-bg`. Update `metadata.title` to `'An Agent on Trial'`, description to `'Can We Trust the Machines? A Live Trial. A real agent earns, pays, gets disputed and is judged on Celo. The evidence is on chain. You decide.'`, `themeColor` to `#0b0f0d`.
- [ ] **Step 2: Rewrite `globals.css`**: keep `@import "tailwindcss"`, the scrollbar rules, `fade-in` and `.qr svg`; add the `@theme` block from Interfaces, `html, body { background: #0b0f0d; color: #fff }`, `.grid-bg` (background-image: two `radial-gradient` mint glows at 15 percent alpha, top right and bottom left, plus two `linear-gradient` 1px lines at 4 percent white with `background-size: 48px 48px`; `background-attachment: fixed`), and `.eyebrow`.
- [ ] **Step 3: Create `app/icon.svg`**: 64x64, dark circle background `#0b0f0d`, triangle edges stroke `#6b7a72` width 4, three white nodes radius 6 at the corners, one mint node radius 5 at the centroid. This becomes the favicon automatically.
- [ ] **Step 4: Update `RedisNotice.tsx`** to name both variable pairs: "Set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel Upstash) or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." Style: `rounded-xl border border-mint/40 bg-mint/10 px-5 py-4 text-left text-base text-mint`.
- [ ] **Step 5: Verify** `pnpm --filter courtroom typecheck` passes and `curl -s localhost:3000/ | grep -c jetbrains` is at least 1 with the dev server running.
- [ ] **Step 6: Commit** `style(courtroom): theme tokens, font, grid background, icon`.

### Task 2: UI primitives

**Files:**
- Create: `courtroom/components/ui/Logo.tsx`, `Pill.tsx`, `Card.tsx`, `Button.tsx`, `Avatar.tsx`, `LetterBadge.tsx`

**Interfaces:**
- `Logo({ size?: number, withText?: boolean })`: inline SVG mark (same geometry as the icon, transparent background) plus, when `withText`, "Agentic Hub" in `font-bold` and an `eyebrow` line "AN AGENT ON TRIAL". Server component.
- `Pill({ children, tone?: 'mint' | 'neutral' | 'rose' | 'amber' })`: `inline-flex items-center rounded-full border px-3 py-1 text-xs eyebrow`. Mint tone: `border-mint/60 text-mint bg-mint/10`.
- `Card({ children, className? })`: `rounded-2xl border border-line bg-white/[0.03] p-6`.
- `Button({ href?, variant?: 'primary' | 'secondary' | 'danger', size?: 'md' | 'xl', ...buttonProps })`: renders `<Link>` when `href` is set, else `<button>`. Primary: `bg-mint text-ink hover:bg-mint-deep`; secondary: `border border-line text-fg hover:bg-white/5`; danger: `bg-rose-500 text-ink`. `xl` is `py-6 text-3xl rounded-2xl`. Focus ring `focus-visible:ring-2 ring-mint`.
- `Avatar({ name, src?, size?: number })`: circle with `ring-2 ring-mint`; `<img>` when `src`, else initials (first letters of the first two words) on `bg-white/10`.
- `LetterBadge({ id })`: the exhibit id in `font-bold text-mint` with a fixed width, used in board rows and exhibit pages.

- [ ] **Step 1: Create the six components** with the signatures above. `Button` and `Avatar` need no `'use client'`.
- [ ] **Step 2: Verify** typecheck passes.
- [ ] **Step 3: Commit** `feat(courtroom): ui primitives`.

### Task 3: Shell, nav, footer, speakers data, route group

**Files:**
- Create: `courtroom/lib/speakers.ts`, `courtroom/components/Nav.tsx`, `courtroom/components/Footer.tsx`, `courtroom/app/(shell)/layout.tsx`
- Move (git mv): `app/page.tsx`, `app/live/`, `app/vote/`, `app/exhibit/`, `app/cross/`, `app/bench/` into `app/(shell)/`. `app/projector/`, `app/property/`, `app/api/`, `app/agent/`, `app/.well-known/` stay.

**Interfaces:**
- `lib/speakers.ts` exports `SPEAKERS: { name: string; role: string; company: string; x: string; handle: string; photo?: string }[]` with the three spec rows (handle shown as `@GigaHierz`, `@fortuvp`, `@ethswarm`) and `BUILT_WITH: { name: string; href: string }[]` for Celo `https://celo.org`, Swarm `https://www.ethswarm.org`, Kleros `https://kleros.io`, askbots.ai `https://askbots.ai`, usebuy.ai `https://usebuy.ai`, x402.celo.org `https://x402.celo.org`, and `REPO_URL = 'https://github.com/GigaHierz/agent-on-trial'`.
- `Nav()`: server component. `<header className="sticky top-0 z-40 border-b border-line bg-ink/80 backdrop-blur">` with inner `mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6`. Left `<Link href="/"><Logo withText /></Link>`. Right links: Home `/`, Live log `/live`, Evidence board `/projector` with `hidden md:inline-flex`, Vote `/vote`. Text `text-sm text-fg-2 hover:text-fg`. On screens below `sm`, the wordmark text hides and links stay as a compact row.
- `Footer()`: server component. Three rows in `mx-auto max-w-6xl px-4 py-10 sm:px-6`: "SPEAKERS" eyebrow with the three names linking to `x` showing `handle`; "BUILT WITH" eyebrow with `BUILT_WITH` links; small print `text-fg-3 text-xs` with "Code on GitHub" linking `REPO_URL` and "Mainnet only. Nothing is simulated."
- `(shell)/layout.tsx`: `<Nav /><div className="flex-1">{children}</div><Footer />` inside `flex min-h-screen flex-col`.

- [ ] **Step 1: Create `lib/speakers.ts`, `Nav.tsx`, `Footer.tsx`, `(shell)/layout.tsx`** as specified.
- [ ] **Step 2: Move the six routes** into `app/(shell)/` with `git mv`. Fix any `@/` imports (they are absolute, so none should break).
- [ ] **Step 3: Verify** typecheck passes; with the dev server, `curl -s -o /dev/null -w '%{http_code}' localhost:3000/live` is 200 and `/projector` HTML does not contain `SPEAKERS`. Playwright: screenshot `/` at 1280x800 shows the Evidence board link; at 375x667 it does not.
- [ ] **Step 4: Verify the Redis-off case**: run `pnpm --filter courtroom dev` once with `KV_REST_API_URL= KV_REST_API_TOKEN=` on a spare port and confirm `/live` renders the notice inside the shell. Stop it.
- [ ] **Step 5: Commit** `feat(courtroom): shell layout with nav, footer and speakers`.

### Task 4: Home page

**Files:**
- Modify: `courtroom/app/(shell)/page.tsx`
- Create: `courtroom/components/SpeakerCard.tsx`, `courtroom/components/Acts.tsx`

**Interfaces:**
- `SpeakerCard({ speaker })` takes one `SPEAKERS` entry: `Card` with `Avatar` size 72, name `font-bold`, `role · company` in `text-fg-2 text-sm`, handle link in `text-mint text-sm`.
- `Acts()`: five rows (1 Identity "mints an ERC-8004 identity", 2 Earn "reviews a website on askbots.ai, earns 0.10 USD₮", 3 Spend "pays for an API through x402", 4 Dispute "gets sold junk, opens a dispute, the ruling lands as feedback", 5 Verdict "you vote, the jury writes it on chain") as a responsive grid `grid gap-4 sm:grid-cols-2 lg:grid-cols-5`, number in `text-mint font-bold`.

- [ ] **Step 1: Rewrite `page.tsx`** keeping the server-side round and QR logic. Sections, top to bottom, inside `mx-auto max-w-6xl px-4 sm:px-6`: hero (`Pill` with the date text; `h1` "An Agent on Trial" `text-5xl sm:text-7xl font-bold tracking-tight`; `p` subtitle `text-2xl text-mint`; `p` pitch `text-fg-2 max-w-2xl`; buttons `Button primary size xl href=/vote?r=` "Vote" and `Button secondary href=/live` "Watch live"); beside it on `lg` the QR `Card` with `w-[min(70vw,320px)]` and the URL in `text-fg-3 text-sm break-all`; "THE SPEAKERS" eyebrow and three `SpeakerCard`s in `grid gap-4 md:grid-cols-3`; "HOW IT WORKS" eyebrow and `<Acts />`; `RedisNotice` when Redis is off.
- [ ] **Step 2: Verify** screenshots at 1280x800 and 375x667 under `.context/redesign/home-*.png`; headline, pill, buttons, three speaker cards visible; no horizontal scroll at 375 (`document.documentElement.scrollWidth <= 375`).
- [ ] **Step 3: Commit** `feat(courtroom): home page with speakers and acts`.

### Task 5: Live log and vote

**Files:**
- Modify: `courtroom/components/LiveClient.tsx`, `courtroom/components/VoteClient.tsx`, `courtroom/components/TallyBar.tsx`

- [ ] **Step 1: `TallyBar`**: fill `bg-mint`, track `bg-rose-500/70`, labels Trust in `text-mint` and Don't trust in `text-rose-400`, rounded-full bar. Keep the `size` prop.
- [ ] **Step 2: `LiveClient`**: outer `mx-auto flex h-[calc(100vh-57px)] max-w-4xl flex-col px-4 sm:px-6` (57px is the nav height; keep the inner log scrolling). Header as a `Card` with title "Live transcript", round pill and the `TallyBar`. Log lines `break-words` with a small `Pill` per kind (host mint, tool call neutral, tx mint, warn amber, error rose).
- [ ] **Step 3: `VoteClient`**: `main` `mx-auto flex min-h-[calc(100vh-57px)] max-w-md flex-col justify-center gap-6 px-4 py-6`; question `text-3xl sm:text-4xl font-bold`; buttons `Button variant primary size xl` "Trust" and `variant danger size xl` "Don't trust" in `grid gap-4 sm:grid-cols-2`; status line `text-fg-2`; `TallyBar` below. Copy unchanged.
- [ ] **Step 4: Verify** screenshots at 375x667 for `/vote?r=test` (both buttons fully visible, `scrollHeight <= innerHeight + 8`) and `/live` (no horizontal overflow).
- [ ] **Step 5: Commit** `style(courtroom): live log and vote`.

### Task 6: Exhibit, property and host pages

**Files:**
- Modify: `courtroom/app/(shell)/exhibit/[id]/page.tsx`, `courtroom/components/VerifyButton.tsx`, `courtroom/components/Cited.tsx`, `courtroom/app/property/[runId]/page.tsx`, `courtroom/components/HostLogin.tsx`, `courtroom/components/BenchClient.tsx`, `courtroom/components/CrossClient.tsx`

- [ ] **Step 1: Exhibit page**: `mx-auto max-w-3xl px-4 py-10 sm:px-6`; header with `LetterBadge` and the title; links row as `Pill`s (Celoscan, Open stored file, Service link) and "Back to the board" with `hidden md:inline-flex`; `VerifyButton` as `Button secondary`; JSON `pre` in a `Card` with `overflow-x-auto text-sm`. Verify result boxes mint or rose.
- [ ] **Step 2: Property page**: same content and JSON-LD; only swap to `bg-ink`-friendly classes (`text-fg-2` for body, `border-line` for the menu table). No nav, no footer, no shell link.
- [ ] **Step 3: Host pages**: `HostLogin` as a centred `Card`; `BenchClient` and `CrossClient` use `Card` for sections, `Button` for actions, inputs `rounded-xl border border-line bg-white/5 px-3 py-2`. Keep every handler and fetch as is. `Cited` chips `bg-white/10 text-mint`.
- [ ] **Step 4: Verify** typecheck; `/exhibit/A1?round=test` renders at 375 and 1280; `/property/test-2026-11-02` HTML has no `SPEAKERS`; `/bench` without the cookie shows the login card.
- [ ] **Step 5: Commit** `style(courtroom): exhibit, property and host pages`.

### Task 7: Projector board and band toggle

**Files:**
- Modify: `courtroom/components/ProjectorClient.tsx`

**Interfaces:**
- Band state: `const [bandOpen, setBandOpen] = useState(true)`, persisted in `localStorage` key `projector.band` (`'open' | 'closed'`), read in a `useEffect` after mount to avoid hydration mismatch.

- [ ] **Step 1: Header**: `Logo` mark (no text) before "The evidence"; round and agent in a `Pill`. Column titles with the letter in `text-mint`. Rows use `LetterBadge`; badges (data, recorded, swarm) use `Pill` tones.
- [ ] **Step 2: Band**: keep the three-column grid. Add a `button` absolutely positioned at the band's top right edge, `aria-label` "Hide tally" / "Show tally", rendering `▾` / `▴`. When closed, the footer collapses to a `h-10` strip showing only "Trust N · Don't trust M · verdict" in one line and the toggle. The outer grid stays `grid-rows-[auto_1fr_auto]`.
- [ ] **Step 3: Verify** Playwright at 1920x1080 on `/projector`: `document.documentElement.scrollHeight <= 1080`, band visible, toggle collapses it, reload keeps the state. Screenshot to `.context/redesign/projector.png`.
- [ ] **Step 4: Commit** `feat(courtroom): projector board styling and tally band toggle`.

### Task 8: Build, deploy, PR

- [ ] **Step 1:** `pnpm --filter courtroom build` passes.
- [ ] **Step 2:** Full-page screenshots of `/`, `/live`, `/vote`, `/exhibit/A1?round=test`, `/projector` at desktop and 375 widths into `.context/redesign/`.
- [ ] **Step 3:** `vercel deploy --prod --yes --scope gigahierzs-projects`; curl `/`, `/vote`, `/projector`, `/api/round` return 200 on `https://agent-on-trial.xyz`.
- [ ] **Step 4:** Push the branch, open a PR to main with the screenshots embedded, body from a file.
