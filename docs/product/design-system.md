---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/app/globals.css
  - packages/frontend/tailwind.config.js
  - packages/frontend/src/components/ui/**
  - packages/frontend/src/app/layout.tsx
  - packages/frontend/src/app/page.tsx
  - packages/frontend/src/app/how-it-works/**
  - packages/frontend/src/app/protocols/**
  - packages/frontend/src/app/(authenticated)/design-system/**
  - packages/frontend/src/app/(authenticated)/accounts/[safeId]/AccountDetailClient.tsx
  - packages/frontend/src/components/marketing/**
  - packages/frontend/src/components/sidebar/**
  - packages/frontend/src/components/TopBar.tsx
  - packages/frontend/src/components/haven/TransactionActivityRow.tsx
  - packages/frontend/src/components/haven/TransactionMovement.tsx
  - packages/frontend/src/components/transactions/**
last-verified: "2026-09-03" # #2468: re-read the affected Button census, focus-ring anti-vacuity decision, marketing exemption, arrow census, tap-target guidance, and published grep after retiring /investor-briefing; the surviving scanner population is intentionally one BrandBandButton. Scope: those references only; the rest of this document was not re-read. Prior: #2374: § 3 *Buttons* — the FOURTH tap-target borrower loses half of itself. The `/accounts` card's `Set as default` star was removed by owner decision, so the paragraph that described a PAIR now carries a scoped note saying which of its claims are history and which still bind: the both-axes rule for an icon square STAYS (it is general, and `WalletButton.tsx:129` still borrows it — re-read against source in this pass), and the `gap-2.5` clearance bullet keeps its rule while losing its example. Also re-read in the same pass, against source: the whole of § *Tap targets* and the three OTHER borrowers, all still true; `AccountsOverviewClient.tsx` now renders one action, `Set active`, gated on `!isActive` alone. Scope: the fourth-borrower block and the two lines pointing at it. NOT re-verified: §§ 1-2, 4-9, § *Cards*, § *Transactions table*. Prior: #2325: § 3 *Cards* gains the narrow-header priority entry directly after the #2251 grid-track rule it leans on — at 390 the `/agents` header's `ml-auto shrink-0` stamp takes 118.8px of a 300px row and squeezes the MCP chip to 38.5px (`haven-research`, measured 113px, renders `haven…`); the fix is `flex-wrap` on the row plus `basis-full sm:basis-auto` on the stamp (stamp below the block under `sm`, on the line at `sm` and up), with the two measured dead ends (`flex-shrink: 1` on the stamp, `flex-wrap` alone) recorded, and the choice of `sm` itself justified by a sweep of the unwrapped layout (a 34-char slug is cut to 148.5px at 500 and 208.5px at 560, whole only from 639), so the 466-639 band's extra line is an accepted cost rather than an oversight; the wrapped line is left-aligned (`text-left sm:text-right`) on the rendered review's finding that right-flush over-weighted a deliberately demoted element. Verified against source: both spec files cited in the entry exist and their assertions match the prose — `e2e/agent-card-mcp-chip-measure.spec.ts` (chip >= own scrollWidth at 390, stamp below block, 768 control; revert turns the 390 arm red on the mechanism guard, stamp top 263px vs block bottom 347px) and `e2e/agent-card-fit-measure.spec.ts` (green alongside). Scope: § 3 *Cards* only — the new entry and nothing else; the *Tooltips* paragraphs were NOT re-read this pass. Prior: #2389: ONE body sentence under § *Transactions table* — the "what can and cannot see this class of defect" note at the end of the container-collapse discussion — re-verified against `packages/frontend/package.json` `test:visual`, `scripts/ci/visual-baseline-inventory.mjs` and the five `e2e/*.visual.spec.ts` on this branch. It said the gate renders `/design-system` at 1280/390 only, contradicting the § 9 row #2318 corrected in this same file (#2318's note was scoped to that row, which is why this survived). The gate compares every committed baseline (24 across 5 spec files, including whole-page `/dashboard` and `/transactions`), and the inventory script is now cited as the authority for what is compared instead of a restated scope. The viewport-band argument survives on its true premise: every visual spec takes its width from `scripts/evidence-viewports.mjs`, which holds exactly 1280 and 390, so no committed baseline exists at any width between them. Scope: that sentence only. NOT re-verified: the rest of § *Transactions table*, §§ 1-8, § 9. Prior: #2241: § 3 *Buttons* gains a FOURTH tap-target borrower — the `/accounts` card's `Set active` / `Set as default` pair — and with it the `opacity-0` hit-test lesson: an `opacity-0` control is invisible AND STILL LIVE (`elementFromPoint` at Pixel 5 returned both buttons on unchanged `dev`), so gate the hover treatment on `(hover: hover)` rather than adding a `(hover: none)` override, and note that revealing an already-in-flow `opacity-0` control on touch costs the layout nothing. Also records that the "8px between stacked controls" clearance rule bites BETWEEN two borrowers inside one wrapper, not only against a neighbouring bar. RE-READ in the same pass, against source: the whole of § *Tap targets* and all three prior borrowers. Every claim in them is STILL TRUE — `Button.tsx:40-41` still carries the `sm`/`md` overlay and `lg` still carries none; `WalletButton.tsx:129` still carries the `h-11 w-11` square form and still clears it at `sm:after:content-none`; `Sidebar.tsx:235` still has the overlay WITHOUT `relative`, which is what the "do not add `relative` to an already-positioned element" paragraph asserts, and it is still `fixed`; `investor-briefing/page.tsx:559` still paints `h-9` under a `h-11` overlay. Scope: § 3 *Buttons* only — NOTHING else in this file was re-verified, and `covers:` is deliberately unchanged: `app/(authenticated)/accounts/**` is a borrower, not a design-system surface, exactly as `WalletButton.tsx` and `investor-briefing/page.tsx` are already documented here without being covered. Prior: #2318: §9's Enforcement table described the visual-regression row as the "`/design-system` snapshot suite". That has been wrong since #1863 made `test:visual` select every `e2e/**/*.visual.spec.ts` (verified against `packages/frontend/package.json`, not from the issue text — the script carries no path filter, and there are five such specs today), and #2318 makes it doubly wrong by adding whole-page `/dashboard` and `/transactions` baselines. The row now points at `frontend.md` §4's table for scope — which §9 already declares authoritative — rather than restating a scope that drifts, and says plainly that a screen absent from the job's own printed baseline list is not covered. Found by `haven-doc-reviewer`, which also confirmed this doc's `covers:` does not list `ci.yml` or `e2e/**`, so the coupling gate correctly did NOT flag it — the sentence was stale without being coupled. Scope: the §9 Enforcement table's visual-regression ROW only. NOT re-verified: the rest of §9, or §§1-8. Prior: #2251: § 3 *Cards* gains the grid-track rule — a grid item's `min-width: auto` makes a card unable to shrink below its own min-content, so a `truncate` descendant widens the column instead of ellipsising, and Tailwind's `grid-cols-N` only overrides that at and above the breakpoint that declares it. Written as the card sibling of the existing `truncate`d-cell paragraph under *Transaction tables*, which it cites rather than restates. RE-READ in the same pass, against source: the *Tooltips* reachability paragraph's "`McpServerName` inside `AgentCard` is the live case" is STILL TRUE and is now load-bearing twice over — the same nesting that keeps that tooltip hover-only is the wrapper this new rule names as the broken link in the `min-w-0` chain. Nothing else in § 3 was re-verified. Prior: #2043: § 3 *Tooltips* gains *Essential vs elaboration, worked on one component* — the content rule the #2038 reachability limit forces, worked on `McpServerName`, whose two branches sit on opposite sides of it. RE-READ in the same pass, against source: the #2038 paragraph's "`McpServerName` inside `AgentCard` is the live case" is STILL TRUE — only the null branch's tooltip was removed, and the recorded-name tooltip (`McpServerName.tsx`'s recorded branch) is still nested in that composite `role="link"` card (`AgentCard.tsx:121-126`), so the sentence keeps its referent. Two COUNTED literals corrected rather than carried: the label was **169** characters, not 167 — measured on the string as it stood on `origin/dev` (`git show origin/dev:.../McpServerName.tsx`), and the wrong figure appeared twice in this section, once in the new paragraph and once in the pre-existing *Width* paragraph. The *Width* fix is outside #2043's diff and is taken anyway, because two paragraphs disagreeing about one string is worse than one being wrong. Scope: § 3 *Tooltips* only — the Reachability, Width and standalone-ring paragraphs were re-read; NOTHING else in this file was, and no other counted literal (§ Buttons' census included) is touched. Prior: #2231 (#2067): § 1 Tokens -> Shadows said `--v2-shadow-scroll-edge` had "one call site". False as of this diff: `WalletPopover` clamps its height to the viewport and now renders the same `.v2-scroll-edge-cue`, and the measurement behind both moved to `hooks/useScrollEdgeCue.ts` (the #901 pattern-absorption preflight on its 2nd occurrence). Corrected to name both call sites and the shared hook, and "dialog body" loosened to "overlay body" — a popover is not the Modal dialog body that sentence was written about. A line was added saying a third call site is a design decision rather than free reuse, because the count was load-bearing and its replacement should not read as an invitation. Scope: THAT PARAGRAPH ONLY. § 3 -> *Modal* still describes the cue as Modal's own and was NOT rewritten; § *Tooltips* was checked and is NOT stale (`VIEWPORT_MARGIN` went module-private -> exported, but the doc claims only the 8px gutter behaviour, which is unchanged). No other section of this file was re-read, and no counted literal was touched. Prior: #2002: § 6 gains § *Showcase copies of overlays* — the rule for a permanently-open showcase copy of a dialog/overlay primitive, which § 6 had no home for. RE-READ and re-verified in the same pass, against source rather than assumed: § 6's whole *Accessibility expectations for production primitives* bullet list, all six bullets STILL TRUE — Modal `role="dialog"`/`aria-modal`/Escape/focus trap/focus return (`ui/Modal.tsx:144-183`) and its scroll cue `aria-hidden` + `pointer-events-none` (:263), Toast polite/assertive live regions (`ui/Toast.tsx:216-243`), the #2038 Tooltip standalone condition (`ui/Tooltip.tsx:179-305`), `role="status"`/`aria-busy`/`aria-live` loading regions, and the shell skip link to `main#main-content` (`(authenticated)/layout.tsx:41,51`). The new subsection was written from a fresh census of every overlay showcase on `/design-system` (9 families; 8 trigger-driven and live, 1 — `WalletPopover`, two instances — permanently open) and its cited evidence re-checked: the `wrong_wallet` illustration (#2073) is hand-built markup whose copy MATCHES `OnchainActionGate`'s string today, so it is stated as a divergence risk and not as a divergence; #2204's `/design-system` exemption is the permanently-`aria-busy` skeleton showcase, not animation. Scope: § 6 only, and within it the bullet list plus the new subsection. § *Focus rings* was NOT re-read, and neither was any other section of this file — no counted literal (the § Buttons census included) is touched by this change. Prior: #2195/#2196/#2203: § Buttons — the Distribution paragraph RE-DERIVED by running its own published command, not reasoned about. Was "111 ghost, 9 tertiary, 6 danger, 2 primary — 128"; now 112/11/5/1 — 129. Attribution, because it matters who owes what: on unchanged `origin/dev` (7047dbc8) the same command already answered 111/11/5/1 — 128, so tertiary 9→11, danger 6→5 and primary 2→1 had drifted from earlier merged work and the doc's total was right for the wrong reasons; this branch causes exactly ghost 111→112 (one new `variant="ghost"` control in the recoverable-funds banner). The paragraph's two stated blind spots were re-checked in the same pass and BOTH were stale: it named three dynamic call sites and there are four (`ReplaceSigningKeyModal.tsx:933` was missing), and `DashboardClient.tsx` had moved :336→:334. Scope: that ONE paragraph and its caveat sentence. The rest of § Buttons and the whole rest of this file were NOT re-read. Prior: #2097: § Transaction tables (a section backed by `packages/frontend/src/components/transactions/**`, which this doc `covers:` by glob) gains the Initiator-semantics rule — the Initiator column and the detail panel's Initiator row both read the record's `initiatedBy`, render `You` ONLY for `'human'`, and fall back to an explicit unknown rather than `You`; the three `?? 'You'` fallbacks in `transaction-presentation.tsx`/`TransactionDetailPanel.tsx` are gone. Verified ONLY that §'s column list and the shared `transactionInitiator` helper; the rest of this file was NOT re-read, and the authoring-side sections it touches are verified by their own tests. Prior: #1947: the danger-variant use census no longer cites "the approval queue's reject" — that call site died with #1989's screen deletion; the surviving uses (agent revoke/remove, delete contact) re-checked. Scope: that parenthetical only. Prior: #2038: § Tooltips rewritten (reachability contract, the composite-control limit, the `focus-visible` ring on newly-focusable triggers, the one-second touch→mouse suppression WINDOW rather than a latch, and the width cap) and the accessibility-expectations line corrected. Verified ONLY those two places, against `ui/Tooltip.tsx` and MEASURED geometry in real Chromium (167-character label: 988px wide on a 320px viewport before, wrapped inside the cap with an 8px gutter after). The old line "Tooltip triggers are keyboard focusable when the tooltip is needed for non-mouse users" was FALSE for every bare-span trigger, not stale — the wrapper had no `tabIndex` and `onFocus` never fired. NOT a re-read of this file; no other § was checked. Prior: #1989: four citations pointed at files this diff deletes — the sidebar "Approvals item ... live actionable-count badge", the tertiary-variant census ("eight product call sites ... three in settings/ManageApprovers", now five), `ApprovalNotifications.tsx:133` in the focus-ring blind-spot list, and `SendModal.tsx:627` in the 12px tap-target debt row. All corrected in place; the counts were re-derived, not guessed. Scope: those four lines. Prior: #1999: § Transaction tables re-keyed onto the CONTAINER — `revealAt="md"|"xl"` at 718px/974px container width, `tableColumnClass`/`tableHideFromClass` for the body half, `<Table scrollable>` for the dense scrolling shape. Verified ONLY that section, from MEASURED geometry in real Chromium on all four Table-bearing routes (container 340/717/718/850/973/718/973/974 across viewports 390..1280 — the sawtooth reproduces identically on `/design-system`, `/transactions`, `/accounts/:id` and `/agents/:id`, with the sidebar mounted; a first probe read it with the `ssr:false` sidebar not yet mounted and reported NO sawtooth, which is why the instrument now asserts the sidebar's computed `position`). Two corrections to what #1827 left here: the `lg` step is 240 + 16 = **256**px, not 241 + 16 = 257 (the sidebar's `border-r` is inside its border-box `w-[240px]`; `main` measures 784px at a 1024px viewport), and `TransactionsTable`'s exemption is re-measured rather than restated. NOT a re-read of this file; no other § was checked. Prior: #1827: § Transaction tables gains the two-stage column-reveal rule. Verified ONLY that section, against `/design-system`'s Transaction-history showcase and `TransactionsTable.tsx`, from MEASURED geometry in real Chromium (content width 717.9px at both 768px and 1024px; Failed-row title 71.1px/5 lines before, 141.7px/2 lines after; 1280px unchanged to the pixel). The sawtooth is the load-bearing claim and it is a reading, not an inference — the instrument was validated in the same run against `/transactions`, which reads one line at every width. NOT a re-read of this file; no other § was checked. Prior: #1952: § 3 gains the **Local hint marker** subsection and § 1's `--v2-border-strong` row gains its fourth use. NOT a re-read of this file — ONLY the new subsection and that one token row were verified, against `WalletButton.tsx` and the three lighter `border-l` call sites (`ConnectionVerificationFooter.tsx`, `WaitingForConnector.tsx` ×2) found by grep. The entry is deliberately labelled thin: ONE call site, against § 5 Arrows' stated bar of not founding a precedent on one instance, and the two review passes on #1952 SPLIT on whether it belongs here (the doc pass said one-off, the design pass said a fourth undocumented use of the token invites a fifth). Recorded with the disagreement visible rather than resolved silently, and with an explicit delete-if-unused instruction. No other § was re-read. Prior: #1955/#1954: § Buttons' Tap-targets rule gains "The third borrower" — `/investor-briefing`'s `InvestorButton` at `size="sm"` borrows the #1726/#1766 `::after` extension, and it is the first borrower that MUST take `relative`: it is a statically positioned `<a>`, so the overlay has no containing block otherwise. The existing "must not take `relative`" instruction was written for the `fixed` mobile toggle and was reading as unconditional; it is now scoped to already-positioned controls. The 36 → 44 figure is MEASURED with `elementFromPoint` at 393px, not read off a class string, and the instrument was validated in the same run against the hero's `lg` CTA (paints 44, reads 44), so the pre-fix 150×36 is a reading rather than silence. Both halves are asserted in `e2e/investor-briefing-tap-target.mobile.spec.ts` because a paint-raising "fix" satisfies the 44px line and breaks the density the issue was protecting — mutation-proven both ways (overlay removed → the hit-rectangle assertion red; `h-9`→`h-11` → the painted-height assertion red). Marketing is design-lint-exempt (#874), so that spec is the whole guard. The published census in the same § was re-derived by RUNNING it, not by reading it: still **2 lines**, but both citations had drifted and are corrected — `BrandBandButton.tsx:74`→`:75` and `investor-briefing/page.tsx:548`→`:572`; the `InvestorButton` pattern entry's span `528-554`→`529-578`. The value was right and the locations were not, which is the failure a pinned line number always has. #1954 also absorbed all six marketing trailing arrows into `components/marketing/TrailingArrow.tsx`; § Buttons' `trailingArrow` paragraph was re-read and is still TRUE (still the identical raw `<svg>`, still not `Icon`+lucide, extraction verified pixel-neutral) so it is deliberately left unedited. ONLY § Buttons' Tap-targets block, its census paragraph and the `InvestorButton` pattern entry were re-verified in this pass; the variant table, token tables, § 5, § Focus rings and everything else were NOT re-read. Prior: #1968: the guard table's `haven-design-reviewer` row gains how the pause CLEARS — a clean re-review, not a human ack. That row only; nothing else in this file re-verified. Prior: #1946: § 3 → Modal's "Actions belong in the `footer` prop" paragraph is REWRITTEN, because the claim it made was true and the list it named was not actionable. It named three dialogs as exceptions on the strength of layout reasoning; all three were then MEASURED in Chromium and only ONE overflows anywhere reachable. `contacts/page.tsx` hides its Save button 37px below the fold at 844x390 (landscape phone) and 27px at 640x400 (200% browser zoom, WCAG 1.4.4) with the duplicate-address hint showing, and 98px/89px with the save-error box showing; `DelegationSendModal` and `ComingSoonModal` measure 0 at every supported viewport and need a sub-340px-tall viewport before their action row goes below the fold at all. Only the contacts dialog was moved. The measurement instrument was proven able to say YES before any zero was believed: the `/design-system` demo dialog reports bodyOverflow 65 with the cue present at 1280x600 in the same harness, so the three columns of zeros are readings rather than silence. **`DelegationSendModal.tsx` was deliberately NOT touched**, which is also why #1916's contract-doc coupling on `delegation-rail-security-model.md` never fired here (`npm run docs:coupling` exits 0 and does not implicate that doc) — restructuring a money-movement dialog to match a consistency argument, against a defect that measurement says does not exist, is the trade this section now explicitly warns against. § 3 also gains the `form`-attribute rule: `ui/Modal`'s footer is a flex SIBLING of the body, so a submit button moved there leaves its `<form>`, and `ui/Button` gained a `form` prop rather than the tempting `type="button"` + `onClick` rewrite, which would have dropped implicit submission (Enter in a text field) with nothing to notice. Guards mutation-proven three ways rather than assumed: reverting the contacts markup turns "the action row must not be inside [data-modal-body]" red at both viewports; dropping `form={form}` from `ui/Button` turns "the submit button must carry a form attribute" and "Enter must submit the contacts form" red while the reachability assertions correctly stay green; and removing `ui/Modal`'s `max-h-[calc(100vh-2rem)]` cap turns the "must actually overflow … or this test proves nothing" PRECONDITION red, which is how that line is shown not to be dead. ONLY § 3 → Modal's actions/footer paragraph was re-verified in this pass; the scroll-cue subsection, the three-boxes table, § 1, the token tables, § 5, § Buttons and everything else were NOT re-read. Prior: #1945: § 1 → Shadows is REWRITTEN and the warning block #1893 left there is gone, because the defect it described is fixed. The four dead tokens now have a working spelling and it is a THEME utility, not the documented type hint: `shadow-card`, `shadow-card-raised`, `shadow-button`, `shadow-modal`, `shadow-popover`, one entry each in `tailwind.config.js` → `boxShadow`. `card-raised` and `popover` were the two tiers that had no entry, which is the actual origin of the bug — every call site reached for `shadow-[var(…)]` because for two of the five tiers there was nothing else to reach for, and the other three had unused theme entries nobody knew about. 67 call sites across 43 files converted; `shadow-[var(--v2-shadow-*)]` is now forbidden outright. Both spellings were VERIFIED by compiling them, not by reading Tailwind's docs: the bare form emits `--tw-shadow: var(--tw-shadow-colored)` byte-identically to the explicit `shadow-[color:var(…)]` form, and both `shadow-card` and `shadow-[shadow:var(…)]` emit `var(--v2-shadow-card)`. The type hint is recorded as the other working spelling rather than adopted, because a theme entry is what #1708 did for the identical failure on the colour axis and because it survives a call site being copied without its hint. § 9 gains the compiled-CSS-guard paragraph pairing `shadow-token.test.ts` with `focus-ring.test.ts` — the guard boots real Tailwind, resolves each utility back to a literal shadow list in `globals.css`, and carries TWO positive controls (`.v2-modal-backdrop`, `shadow-card`) so a `none` is a measurement rather than a broken reader; mutation-proven three ways (dead spelling reintroduced at one call site → 2 named assertions red; theme entry deleted → 3 red; the control itself broken → the control red and nothing else). § 1's opening tokens paragraph corrected: it claimed raised cards and popovers 'may exist as CSS variables only until promoted', which is no longer true and was the sentence that made the gap look intentional. The `hover:shadow-[0_8px_24px…]` literal lifts are re-read and were NEVER affected — an arbitrary value carrying its own shadow list is unambiguous; it is only a bare `var()` Tailwind cannot type — and § Buttons' two quoted class strings plus § Cards' quoted base string are corrected to the new spelling. **Every committed visual baseline was recorded from the broken CSS, so the flat render is what they assert; they are regenerated here and that red was the fix working.** ONLY § 1 → Shadows, § 1's opening tokens paragraph, § 9's enforcement block, and the three quoted class strings named above were re-verified in this pass; the colour/typography token tables, § 3, § 5, § Focus rings and everything else were NOT re-read. Prior: #1893: § 3 gains the **Modal** component-pattern subsection it never had — Buttons, Cards, Inputs, Toasts and Tooltips each had one; the app's single dialog shell (11 direct importers, 3 of them wrappers) appeared only in the z-index table, the overlay-dim rationale, one § 6 bullet and the § 7 file table. Nothing there was false; the gap was that a shared primitive's structure was undocumented. Written from the SOURCE, not from the diff: the three-box table (non-scrolling `role="dialog"` wrapper / panel / the one `[data-modal-body]` scroller) records the two facts that keep costing time — a geometry test against `getByRole('dialog')` CANNOT FAIL because the wrapper is `overflow: visible` + `position: fixed` and reports ~4px of padding overflow `scrollTop` can never consume (measured in Chromium, not reasoned), and the `footer` prop renders OUTSIDE the scroll box so nothing placed there can describe the body's overflow. `ReceiveFundsModal` named as a bespoke dialog that does the opposite, so a helper written for one is not reused on the other. New scroll-continuation-cue subsection states trigger, DOM hooks and the three decisions markup cannot carry, including why the INITIAL mount-time appearance has no transition (§ 4 bans first-paint entrance animation and the cue's first reading lands in an effect after first commit). Design review narrowed that claim and the narrowing is kept: the argument does NOT reach the recurring toggles during an active scroll, which are not first-paint motion, and those are recorded as an OPEN question rather than a decision — they have no transition because none was added, not because one was argued against. What IS measured about them: zero layout shift across a real scroll (body holds clientHeight 362 / top 169 while the cue toggles), which is why it was not urgent, not why it is settled. § 6's `role="dialog"` bullet gains the deliberate `aria-hidden` + `pointer-events-none` treatment, per doc review: a future editor had no way to know it was intentional. **Also corrects a claim § Shadows had carried unqualified: four of its five tokens paint NOTHING.** `shadow-[var(--v2-shadow-card|-card-raised|-modal|-popover)]` compiles to `--tw-shadow-color: var(…); --tw-shadow: var(--tw-shadow-colored)` against a variable nothing sets, so every Card, Modal panel and popover renders flat — read out of the SERVED stylesheet in a real browser, the same dead-arbitrary-value class as § "Opacity on a token colour" and #1708's focus ring. NOT fixed here (four shadows app-wide is its own baselines-and-design pass) and filed as a follow-up; recorded so the tokens stop reading as shipped behaviour. The working idiom is named: a class in `globals.css`, as `.v2-modal-backdrop` and the new `.v2-scroll-edge-cue` both do. ONLY § 3 → Modal, § 1 → Shadows and § 6's modal bullet re-verified in this pass; token tables, § Buttons, § 5, § Focus rings and everything else NOT re-read. Prior: #1803: § Buttons gains "The second borrower" — `WalletButton` collapses to a 40px icon/avatar square below `sm` and borrows the same #1726/#1766 `::after` extension, and the two rules that generalise from it: in an over-subscribed bar DROP a label rather than squeeze every control (measured on /dashboard — the account name was 17px at 320 and the brand CTA wrapped to two lines taller than the 56px band; collapsing the widest control returns 48.64px and takes the name to 66px), and a dropped label must survive as an accessible name (`hidden sm:inline` is `display: none`, so the text stops naming the button — jsdom cannot see that, which is why the rendered width and the name are measured together in e2e and the unit test asserts the ATTRIBUTE). Also records that a collapsed control takes its neighbour radius, and that WHAT to drop was an owner decision rather than a layout one. Only § Buttons' tap-target block was re-read in this pass, against Button.tsx, sidebar/Sidebar.tsx and WalletButton.tsx; the token tables, § 5 and everything else are untouched and uninspected. Prior: #1867: § Buttons' White-on-brand entry — the pattern is now a marketing COMPONENT (`components/marketing/BrandBandButton.tsx`), absorbed from its three hand-copies on the pattern-absorption preflight rather than patched into agreement at two of them. The published census in the same § is re-derived by RUNNING it, not by reading it: **4 lines before, 2 after** (`BrandBandButton.tsx:74` + `InvestorButton`), and that number is the documented clean state. § Focus rings' claim that `focus-ring.test.ts` "enforces all of the above" gains the completeness rule it did not have — a hand-copy of `Button`'s base signature with no `focus-visible:ring-*` now fails, which is the guard whose absence let the two home-page CTAs omit the ring while every DECLARED ring in the product was being measured. Calibration preserved deliberately: those two never set `focus-visible:outline-none`, so the UA outline survived and this was **never** a WCAG 2.4.7 failure — the entry says so explicitly, because the overstated framing is the easier one and the wrong one. Not a `Button` variant, and § Buttons now records why rather than leaving it a judgement: the treatment is off `SIZE_CLASS` (`h-12 px-6 text-[15px]`) and its ring offset is hardcoded to `--v2-brand`, so its correctness depends on its parent's background — which is also why it is deliberately absent from `/design-system`, a light surface where the ring's premise is wrong. § 7's marketing-components row updated. ONLY § Buttons' White-on-brand entry, its census paragraph, and § Focus rings' enforcement sentence were re-verified in this pass; the variant table, token tables, § 5 and everything else were NOT re-read. # #1923: § 5 -> Size resolves the first which-rung divergence #1858 predicted, one week after that section shipped saying no gate could make this call. Two functionally identical remove-budget controls sat at 12 and 14. Measured before deciding: the tempting explanation (fixed `h-6 w-6` box vs padding-only `p-1`) does not predict anything — the app's three other fixed `h-6 w-6` icon-only affordances (`AccountDetailClient`'s `CopyButton`, `ui/CodeBlock`'s copy control, `haven/TransactionActivityRow`'s `ExternalDetailsLink`) all hold a 14 px glyph, so 24-px-box->12 was a population of one. Decision: a remove/dismiss control on a data row takes 14 whatever its box is; `EditAgentModal.tsx` converted 12 -> 14 (the only code change), with the reason as a call-site comment and a rendered test over BOTH call sites (`remove-budget-icon-rung.test.tsx`) that fails on divergence rather than on a number, mutation-proven by reverting the call site. Recorded as NOT settled, so the new row is not over-read: the copy glyph after a mono address is split for the same job (the shared `ui/CopyButton` 12 vs `AccountDetailClient`/`CodeBlock`'s still-hand-rolled ones at 14) and stays split — two live answers, not the same control in the same place. The 12 px row and its tap-target paragraph re-read and corrected twice: they cited `EditAgentModal.tsx:540` as a 12 px host (no longer true after this change), and they cited `haven/Address.tsx:88`/`:90`, which #1878 moved into the new `ui/CopyButton.tsx:63`/`:65` primitive while re-verifying only § Buttons — a citation that was already stale on `dev` and is corrected here because this pass edits that paragraph. Census re-run: 140 call sites, UNCLASSIFIED 0, OFF-SCALE 0, the 12 px bucket 23 -> 22. ONLY § 5 -> Size re-verified in this pass; token tables, § Buttons, § Focus rings, § Arrows and everything else NOT re-read. Prior: #1878: § Buttons' blind-spots paragraph gains the one member of its hand-rolled class that now has a primitive — the copy affordance is `components/ui/CopyButton.tsx`, extracted from `Address` on its second call site. Nothing in the paragraph was FALSE: `CodeBlock`'s copy button is still its own implementation and still invisible to the class-string check. What was misleading was the implication that the whole class waits on a lint rule nobody has scoped — one instance is now simply fixed, and the next adopter is named. Scope: that paragraph only; the variant table, shared-state block, pattern catalog, token tables, § 5 and § Focus rings were NOT re-verified in this pass. Prior: #1710: § "Opacity on a token colour" — KNOWN_DEAD is now EMPTY and documented as the enforcement rather than an inventory, with the guarded escape hatch; plus a paragraph on why this is NOT also a design-lint rule (that gate scans two dirs and exempts marketing, where two of the dead call-sites lived). Only that § re-verified in this pass. Prior: #1708: the documented primary/ghost focus ring was the dead arbitrary-value form; re-read against globals.css + tailwind.config.js and corrected, plus a new "Opacity on a token colour" rule. Token tables and the rest of the body NOT re-verified in this pass. # #1726: Buttons § gains the Tap targets rule — sm/md extend an invisible 44px hit area rather than raising h-9/h-10; the rest of § Buttons re-read and still accurate # #1749: new "Layering (z-index)" § under Tokens — the shell's stacking order is now a named scale in globals.css, and the mobile nav overlay deliberately outranks the chrome. Only § Tokens re-verified in this pass # #1766: § Buttons' Tap targets rule gains "the rule outlives the primitive" — the mobile sidebar toggle borrows the ::after mechanism as a non-Button, growing in both axes because an icon-only square has no long axis, and must not take `relative`. § Buttons re-read against Button.tsx and sidebar/Sidebar.tsx; nothing else re-verified in this pass # #1741/#1746: new "Focus rings" § under Accessibility — one treatment (focus-visible: + ring-2 + /80), the measured 3:1 rationale, and the dark-fill rule that a brand ring can never satisfy. § Buttons focus-ring line corrected to the shipped value and the § Inputs "one family … same focus ring" claim re-read against Input/Select/Textarea/Checkbox — it is now TRUE, having been false since the two families diverged. Nothing else re-verified in this pass # #1767: § Buttons' Tap targets rule — the toggle is `top-3` (centred in the 56px band); the documented 14px clearance to `NetworkSwitcher` was true only at >=768px, because TopBar's `w-8` spacer was shrinkable and collapsed to 0 on phones, and three bullets now record that, how a neighbour is damaged without moving, and why the concentric `left-6` was measured and rejected. § Buttons re-read against Button.tsx, TopBar.tsx and sidebar/Sidebar.tsx; nothing else re-verified in this pass # #1817/#1809: § Buttons gains the previously undocumented Danger variant and the rule that ring TONE lives per-variant in VARIANT_CLASS while ring GEOMETRY stays in the base string — the co-location is what makes the fill/ring pair checkable at all. § Focus rings' offset paragraph gains the inversion it did not record: fixing a solid control's tone makes its offset MORE load-bearing, not less (danger-on-danger un-offset is 1.00:1, against 1.08:1 when it wrongly wore brand). § Buttons and § Focus rings re-read against Button.tsx and globals.css; the token tables and everything else NOT re-verified in this pass # #1818: § "Opacity on a token colour" gains "The rule is about the OUTPUT, not the shape" — the bare-var() telling was the commonest instance, not the definition; currentColor and an off-scale numeric modifier (`text-white/78`, live on a design-lint-exempt marketing surface) drop identically, and the binding check is the compiled-CSS guard rather than a spelling rule. § Layering gains the nav scrim reusing `v2-modal-backdrop`. Only those two §§ re-verified in this pass. # #1840: § 5 Iconography's arrow rule — the bullet claiming arrows "come from lucide, not unicode" was false against `TransactionMovement.tsx`, which this doc `covers:` by exact path. Replaced by an "### Arrows" sub-section: the marketing/`protocols` exemption now stated as covering the WHOLE section (it sat on bullet 1 only and the arrow rule silently inherited it — 15 arrows live on those surfaces legitimately), a ONE-FILE allowlist, and a check written over the Unicode arrow RANGES rather than a list of spellings. Three review iterations are recorded in the § itself because each fix hid the same hole one level down: false claim -> a punctuation/affordance taxonomy that forbade nothing -> an allowlist whose grep searched only `->`/`&rarr;` and so reported clean on files rendering an up-right arrow. The check's blind spots (numeric character references, string escapes, runtime/i18n data) are stated in the doc, and it was verified from a CLEAN shell after the first version turned out to invoke a tool that was only a shell function locally. All six § 5 bullets re-read against `components/ui/Icon.tsx`, `scripts/design-lint.mjs` (`MARKETING_SURFACES`) and every arrow call site in `app/**` + `components/**`. Two findings recorded rather than fixed, so this § is NOT stamped clean: ten raw arrows across seven gated files remain (#1857, enumerated in the doc, including the shared `Address` primitive), and the "14 / 16 / 20 px exactly" bullet was re-read, MEASURED, and is VERIFIED FALSE — roughly a third of sized call sites are off-scale, with the exact counts and the census script in #1858 rather than here. The bullet now carries that caveat and the issue link INLINE in the body; an earlier draft of this note recorded the finding only here, which is nowhere anyone reads. Nothing outside § 5 re-verified in this pass. # #1857: § 5's Arrows sub-section re-verified by RUNNING its own check, not by reading it — extracted byte-for-byte from this Markdown and run under `env -i` before and after the diff: **15 lines before, 5 after**, which is the acceptance criterion. The ten defects the table used to enumerate are converted (lucide `ExternalLink` in the shared `Address` primitive and on `custody`'s Safe{Wallet} link, `Button`'s existing `trailingIcon` in `AddFundsModal` ×2, lucide `ArrowRight` on the `AccountDetailClient` ×2 / `AccountsOverviewClient` / `SettingsClient` link affordances, and two copy edits on `/design-system` — one of which was the caption advertising `Address`'s `↗` as the pattern). The table is replaced by what the check returns in its CLEAN state (5 lines: the one allowlist entry plus four JSX-comment continuation lines, each named with why it is a false positive) — a documented clean number, so more than 5 is a new defect and fewer than 5 means an expected line moved. Also ANSWERS #1857's open question, which #1840 left open: **the allowlist stays at one file and does not go to zero**, because emptying it would change what `TransactionMovement` renders (a 14px stroked glyph mid-sentence, with no separable icon slot since #1774) rather than clean up a call site — recorded in the body with the reasoning, not just here. `Icon.tsx`, `Button.tsx`'s `trailingIcon`, and the `TransactionActivityRow` / `SendModal` `ExternalLink` precedents re-read. The `14 / 16 / 20 px` bullet's #1858 caveat re-read and still accurate — every icon this pass added is `h-3.5 w-3.5`, on-scale, so it does not grow the 12px cluster. Nothing outside § 5 re-verified in this pass. # #1830: § Buttons — `variant="tertiary"` was the last undocumented variant and is now recorded, with what actually separates it from `ghost` (a box vs. no box; tertiary is the only variant that shifts its TEXT colour on hover, having no border to do that work) and the shipped case where it mattered (`connect-agent/SetupStates.tsx:219` swapped tertiary→ghost because transparent-on-white read as stray bold text mid-checklist). Completeness is anchored to the SOURCE and says so: enumerated from `Button.tsx`'s `Variant` union + `VARIANT_CLASS`, kept in agreement by `Record<Variant, string>` — not from the list being edited. Also corrects two FALSE claims the § had carried for months: `trailingIcon` does NOT "slide 2px on hover via wrapper `group-hover:gap-2`" (`Button` sets no `group`; that class lives on three hand-rolled marketing link affordances), and the danger hover was quoted as `hover:bg-[var(--v2-danger)]/90` — an opacity modifier on a bare `var()`, i.e. the dead form § "Opacity on a token colour" exists to forbid — against the shipped `hover:bg-danger/90`. New "Shared by every variant" block records the base-string axes the § omitted entirely (disabled, transition, `href`→`next/link`, `trailingIcon`'s variant- AND element-independence: 6 anchor + 2 `AddFundsModal` button call sites). White-on-brand relabelled a PATTERN with its off-scale `h-12` and its focus treatment differing across its own three instances (2 of 3 carry no `focus-visible:` at all — filed separately, NOT fixed here); `InvestorButton` and `MaxButton`/`PasteButton` added as patterns. **On the strength of this pass, honestly:** the first draft asserted a line-by-line re-read and still shipped the dead danger class and an "all six `trailingIcon` call sites" claim contradicted by #1857's entry directly above this one — review caught both. So what this entry buys is narrower than a re-read: § Buttons' variant table, shared-state block and pattern catalog are now each backed by a **published command** (variant distribution; hand-copied-base-class catalog, clean output 4) with its blind spots stated, and the pattern catalog is labelled known-partial rather than complete. § Focus rings was read only for consistency with the new pattern entry, NOT re-verified. The Tap-targets and "rule outlives the primitive" bullets inside § Buttons were NOT re-verified. Token tables, § 5 and everything else: untouched and uninspected. # #1858: § 5's "14 / 16 / 20 px exactly" bullet was VERIFIED FALSE by #1840 and is now resolved BOTH ways rather than by bending the code to the doc. Re-derived the census with the balanced-JSX parser against `dev` e206ad88 — 141 call sites, 120 sized, 34 off-scale, **UNCLASSIFIED 0** (the load-bearing figure; the naive `<Icon` line grep gives 110/30 because a `className` two lines below the tag is invisible to it, and that gap is now an assertion in `design-lint.test.ts` rather than a claim). 12 px (19 sites, glyphs in `text-xs`), 24 (48 px medallions) and 28 (56 px medallions) were each a coherent built convention, not drift, and are ADDED to the scale; the 11 genuine outliers — all eight arbitrary values among them — were converted to the nearest rung. New "### Size" sub-section replaces the bullet: a container-keyed table of precedents, an explicit split between what is mechanically enforced (SET MEMBERSHIP) and what is a judgement no gate can make (WHICH RUNG), and a published command with its blind spots, following the Arrows precedent. § 9 gains the `icon-size` design-lint row and the note that `tsc` now carries half the rule (`IconSize`). Also fixed a leak the gate structurally cannot see: `agent-panel/agent-display.tsx`'s `BotIcon` was threading 15/17/24 into `<Icon size>` past a rule that only reads `<Icon>` elements — closed by typing its prop `IconSize`, which is the honest answer to "can this be enforced in `Icon.tsx`": the `size` half CAN and now is, the `className` half cannot (an opaque string; a runtime check would not gate CI) and lives in design-lint. **Independent review changed three claims in this entry, and they are worth recording because each was the section's own failure mode recurring.** (a) The census figure was 141, not 140: `/design-system` renders its usage EXAMPLE as a string, `{'<Icon icon={Check} className="h-4 w-4" />'}`, and the walk counted it — on-scale today, so invisible, but editing that documentation string to show an off-scale value would have failed CI on a pure doc change, on the page that teaches the rule. Fixed, so 140 sized-and-real, and the original off-scale finding is 34 of 119. (b) The first fix for that was a whole-file string scanner, which is wrong for JSX: bare apostrophes in body text (`its own primitive's home file`, line 183 of that same page) open strings that never close and masked two live call sites — a false NEGATIVE, caught only because the total moved by two. Replaced with a one-character adjacency test that cannot make that mistake. (c) "Every one of the 19 sits in a run of `text-xs`" was checkably FALSE — `NetworkSwitcher.tsx:96` is `text-[13px]`, `ui/Table.tsx:157` a `text-[11px]` header, `FilterBar.tsx:329` `text-sm`. The rung is real; the tidy single-class story about it was not, and it is now stated as the dense-affordance rung with the measured spread. Also from review: the census now actually applies the marketing exemption its own header claimed, the escape marker works beside the SIZE line of a multiline element rather than only beside the tag, a brace inside an attribute string no longer stops an element terminating (a silent drop), and the 12 px row now says plainly that several buttons it cites are below the 44 px tap target it does not change. ONLY § 5 and § 9's enforcement table were re-verified in this pass; the token tables, § Buttons, § Focus rings and everything else were NOT re-read.
---

# Haven Design System

> Re-verified 2026-09-03 for #2468: the investor-briefing route, its tap-target
> borrower, and its marketing exemption were retired; the surviving focus-ring
> census intentionally keeps a one-member anti-vacuity floor. This note covers
> the affected references only; the rest of this document was not re-read.

This is the source of truth for Haven's current light visual language. Companion to the product UX guide (`docs/product/README.md`, which documents product doctrine, vocabulary, and IA — those rules **still apply**). If older docs mention a dark app surface system, **this document supersedes them**.

The production authenticated app and `/design-system` are the live references for product UX. The production marketing routes are the live references for marketing UX: `/`, `/how-it-works`, `/protocols/x402`, and `/protocols/mpp`. When in doubt, open the live route, inspect the element, and match the system here.

---

## 1. Tokens

All tokens live as CSS custom properties at `:root` in `packages/frontend/src/app/globals.css`. Core color, radius, and shadow tokens are mirrored in `packages/frontend/tailwind.config.js` so they are usable as `bg-bg`, `text-ink`, `border-border`, `shadow-card`, etc. Since [#1945](https://github.com/d-hinders/Haven-AI/issues/1945) that mirror covers the **whole** elevation scale — raised cards and popovers were the two tiers still missing, which is exactly why their call sites reached for the arbitrary-value form that turned out to paint nothing (§ Shadows). Typography utilities, the modal backdrop and the brand gradient remain CSS variables/classes only, deliberately: the first is a set of composite classes and the last two have no Tailwind utility family to join.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--v2-bg` | `#ffffff` | Page background |
| `--v2-surface` | `#f6f9fc` | Alternating section bands, card hover backgrounds |
| `--v2-surface-2` | `#eef2f7` | Disabled states, deeper card stacking |
| `--v2-surface-code` | `#0b1120` | Dark code blocks on light pages (Stripe pattern) |
| `--v2-surface-hover` | `#f0f4f9` | Sidebar/user-menu row hover and subtle interactive shells |
| `--v2-modal-backdrop` | `rgba(26, 31, 54, 0.66)` | Overlay dim for Modal, SidePanel and the mobile nav scrim — solid, deliberately **no** blur (see § Layering) |

### Ink (text)

| Token | Value | Use |
|---|---|---|
| `--v2-ink` | `#1a1f36` | Headings, primary text, amounts |
| `--v2-ink-2` | `#525f7f` | Body text, secondary information |
| `--v2-ink-3` | `#5d6c85` | Tertiary text, eyebrows, captions — AA-safe (≥4.5:1) on white and all tinted surfaces |
| `--v2-ink-on-brand` | `#ffffff` | Text on brand‑colored or dark surfaces |

### Borders

| Token | Value | Use |
|---|---|---|
| `--v2-border` | `#e6ebf1` | Default hairline (cards, dividers) |
| `--v2-border-strong` | `#d6dbe3` | Hover, ghost button borders, flow arrows, the local-hint marker's left rule (§ 3) |

### Brand

| Token | Value | Use |
|---|---|---|
| `--v2-brand` | `#4f46e5` (indigo‑600) | Primary CTA bg, links, accents, brand mark |
| `--v2-brand-strong` | `#4338ca` (indigo‑700) | Primary CTA hover |
| `--v2-brand-soft` | `#eef2ff` | Brand‑tinted card backgrounds, focus rings |
| `--v2-brand-gradient` | `linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)` | Gradient wordmark or one restrained brand accent |

Use `.v2-brand-gradient-text` for the production app wordmark. In product UI, do not use the gradient for buttons, badges, large panels, or repeated decoration.

### Semantic

| Token | Value | Soft variant | Use |
|---|---|---|---|
| `--v2-success` | `#047857` | `--v2-success-soft` `#ecfdf5` | Settled, confirmed, incoming |
| `--v2-debit` | `#0369a1` | `--v2-debit-soft` `#f0f9ff` | Outgoing / sent money (sibling to success; never a warning) |
| `--v2-warning` | `#b54708` | `--v2-warning-soft` `#fef3c7` | 402 Payment Required, pending review |
| `--v2-danger` | `#b42318` | `--v2-danger-soft` `#fef2f2` | Failed, destructive |

Same rule as v1: **never repurpose a semantic color**.

**Contrast guarantee:** every ink and semantic text token meets WCAG AA (≥4.5:1) against white, its own `-soft` background, and the tinted surfaces (`--v2-surface`, `--v2-surface-2`, hover). Guarded by `packages/frontend/src/__tests__/token-contrast.test.ts` — if you change a token, that test tells you whether it still clears the bar.

### Opacity on a token colour ([#1708](https://github.com/d-hinders/Haven-AI/issues/1708))

**Want a token at partial opacity? Use the Tailwind alias, never the arbitrary
value.** `ring-brand/80`, `border-danger/40`, `bg-warning/10` — not
`ring-[var(--v2-brand)]/80`.

The arbitrary-value form does not merely look worse; it **compiles to nothing**.
Tailwind cannot re-compose a colour whose value is a bare `var()`, so it drops
the utility from the output with no error, no warning and no class. That is how
68 focus rings across 39 files spent months setting a ring *width* with no ring
*colour*, leaving `--tw-ring-color` at Tailwind's preflight default and
rendering blue-500/50 instead of brand indigo.

The mechanism: every `--v2-<name>: #RRGGBB` above is paired with a channel form
`--v2-<name>-rgb: R G B`, and `tailwind.config.js` reads the channels through an
`<alpha-value>` placeholder. One theme entry then serves both the solid
(`bg-brand`) and the translucent (`ring-brand/80`) use. Two rules follow, and
`src/__tests__/design-token-alpha.test.ts` enforces both against the **compiled
CSS** — source-level checking cannot see this defect, which is the whole reason
it survived 68 call-sites:

- adding a colour means adding **both** forms — the hex stays, because the
  contrast guarantee above is checked by parsing those hex values;
- a theme colour is never a bare `var()`.

A solid arbitrary value with **no** opacity modifier — `bg-[var(--v2-brand)]`,
`text-[var(--v2-ink-2)]` — is still fine and still used widely.

#### The rule is about the OUTPUT, not the shape ([#1818](https://github.com/d-hinders/Haven-AI/issues/1818))

"Don't write a bare `var()`" is the commonest instance of this defect, not its
definition. **Tailwind drops any opacity modifier it cannot re-compose**, and it
has now done so in three shapes that have nothing in common at the source level:

| shape | example | why it drops |
|---|---|---|
| bare `var()` colour | `bg-[var(--v2-bg)]/85` | no channels to re-compose |
| `currentColor` | `ring-current/30` | same — `currentColor` has no channels |
| off-scale modifier | `text-white/78` | `78` is not a step on the opacity scale |

The third is the one that matters for how you read this section. It carries no
`var()` at all — the colour is a perfectly ordinary `white` — and it shipped on a
marketing surface that design-lint exempts. Every guard written before it matched
a *shape*, so each new occurrence arrived wearing a shape the previous guard
could not see. `TopBar`'s dead background was found only because a mutation
during unrelated work went green when both renders came out byte-identical.

So the check that binds is not a spelling rule. `src/__tests__/compiled-colour-utilities.test.ts`
reads every opacity-modified colour utility out of the product source, compiles
it through the real `tailwind.config.js`, and asserts a colour declaration came
out — indifferent to which shape the next one wears.

**Its `KNOWN_DEAD` map is now empty, and that is the enforcement**
([#1710](https://github.com/d-hinders/Haven-AI/issues/1710) closed epic
[#1685](https://github.com/d-hinders/Haven-AI/issues/1685)). It began as a
shrink-only inventory of triaged debt — 31 entries across #1709 and #1710 — and
with every one converted the assertion changes character: from "do not grow"
to **there is no such thing as an accepted dead class**. Any opacity-modified
colour utility that compiles to nothing now fails outright, and re-adding a key
to quiet a failure trips a second assertion that the map stays empty. The
escape hatch is guarded rather than merely absent.

**Why this is not also a design-lint rule.** #1710 originally specified one.
Two things ruled it out, both measurable: `design-lint.mjs` scans only
`src/app` and `src/components` while this guard walks all of `src/`, and every
design-lint rule takes `exempt: isMarketingSurface` — so a rule built to
match the other rules' exemptions would have been blind to
`components/marketing/`, where two of the dead call-sites it was meant to catch
actually lived. A text rule also cannot strip comments: in #1709 an explanatory
comment quoting the dead form tripped the very guard explaining it. Compiling
the class settles all three.

Fixes, in preference order: the channel-token alias (`bg-bg/85`), an on-scale
modifier (`/75`), or the arbitrary form when the exact value matters (`/[0.78]`).

### Chain identity

`--v2-chain-*` (Base, Gnosis, testnet, plus `NetworkPill`'s sky/amber soft-pill scale) tells networks apart in `NetworkPill` and `NetworkSwitcher`. These are **identity** colours — deliberately outside the semantic rule above. Never reuse a chain colour to carry success/warning meaning, and never route money tone through them. Live swatches on `/design-system` → "Colour tokens".

### Radii

- Buttons: `6px` (`rounded-md`)
- Cards, inputs: `10px` (custom)
- Modals, large surfaces: `14px` (custom)
- Pills, avatars, dots: `9999px` (`rounded-full`)

### Shadows

```css
--v2-shadow-card:    0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
--v2-shadow-card-raised: 0 2px 4px rgba(16,24,40,.06), 0 4px 12px rgba(16,24,40,.08);
--v2-shadow-button:  0 1px 1px rgba(16,24,40,.04), inset 0 1px 0 rgba(255,255,255,.12);
--v2-shadow-modal:   0 12px 32px rgba(16,24,40,.12), 0 4px 8px rgba(16,24,40,.06);
--v2-shadow-popover: 0 12px 24px rgba(16,24,40,.10), 0 2px 6px rgba(16,24,40,.06);
```

**Spell an elevation tier as a theme utility, never as an arbitrary value**
([#1945](https://github.com/d-hinders/Haven-AI/issues/1945)):

| Token | Utility |
|---|---|
| `--v2-shadow-card` | `shadow-card` |
| `--v2-shadow-card-raised` | `shadow-card-raised` |
| `--v2-shadow-button` | `shadow-button` |
| `--v2-shadow-modal` | `shadow-modal` |
| `--v2-shadow-popover` | `shadow-popover` |

Each is one entry in `tailwind.config.js` → `boxShadow`, and variants work
normally (`hover:shadow-card-raised`).

`shadow-[var(--v2-shadow-card)]` **paints nothing** and is forbidden. A bare
`var()` inside `shadow-[…]` is ambiguous, so Tailwind's arbitrary-value type
inference takes the *colour* branch and compiles
`--tw-shadow-color: var(…); --tw-shadow: var(--tw-shadow-colored);` — nothing
ever sets `--tw-shadow-colored`, so the computed `box-shadow` is `none`. That
spelling was live at 67 call sites across 43 files until #1945, so every `Card`,
every `ui/Modal` panel, every popover, tooltip and toast rendered flat, silently,
for as long as the tokens had existed. It was measured out of the **served**
stylesheet in a real browser, not inferred from source.

Read it as the third instance of one failure mode rather than a shadow quirk: it
is the same dead-arbitrary-value class as § *Opacity on a token colour* and the
#1708 focus ring — a spelling that lints clean, reads correctly to a human, and
emits nothing. `design:lint` cannot see any of the three, because its token rules
exist to catch a *bypassed* token and here the token is referenced exactly as
every convention says it should be. So the fix is the same shape #1708 used for
the palette — promote the token into the Tailwind theme and delete the
arbitrary-value syntax — and the guard is the same shape too:
`src/__tests__/shadow-token.test.ts` boots the real compiler, resolves each
utility back to a literal shadow list in `globals.css`, and fails on any
`shadow-[var(…)]` in product source. It carries a positive control
(`.v2-modal-backdrop`, plus `shadow-card` on the compile side) so that a "paints
nothing" verdict is a measurement rather than a broken reader.

Cards on hover get a brand‑tinted lift only when interactive:
`hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)]` (neutral) or `hover:shadow-[0_12px_32px_-16px_rgba(79,70,229,0.30)]` (protocol cards, navigational). These are literal values rather than tokens, so they were never affected — an arbitrary value that carries its own shadow list is unambiguous and compiles fine. It is only a bare `var()` that Tailwind cannot type.

Raised card elevation is reserved for the few surfaces that anchor a page, such as the dashboard hero and account balance card. Popover shadow is for floating menus, tooltips, and toasts.

**No glow shadows on text**, no colored shadows on buttons.

`--v2-shadow-scroll-edge` is deliberately **not** on this scale. It is the one
inset continuation cue at the bottom of a scrolling overlay body, applied through
`.v2-scroll-edge-cue` in `globals.css` (#1893) — no variants, and not an
elevation tier. Two call sites since #2067, both driven by the same
`hooks/useScrollEdgeCue.ts` measurement rather than by a caller opting in:
`[data-modal-scroll-cue]` in `ui/Modal.tsx`, and `[data-wallet-menu-scroll-cue]`
in `WalletButton.tsx`'s `WalletPopover`, whose height is clamped to the viewport
and therefore scrolls. Adding a THIRD is a design decision, not a free reuse —
the token exists to make continuation legible in one specific way, and it stops
meaning that if it becomes a general-purpose edge shadow. See § *Modal* →
scroll-continuation cue.

### Layering (z-index) ([#1749](https://github.com/d-hinders/Haven-AI/issues/1749))

Every stacking layer has a named token. **Reach for a token, never a fresh number.**

```css
--v2-z-content:        10;   /* in-flow overlaps: badges, gradient washes */
--v2-z-sticky:         20;   /* sticky table headers */
--v2-z-chrome:        100;   /* TopBar */
--v2-z-chrome-popover: 110;  /* popovers anchored in the chrome */
--v2-z-nav-scrim:     130;   /* mobile drawer scrim */
--v2-z-nav-drawer:    140;   /* mobile drawer */
--v2-z-nav-toggle:    150;   /* the Open / Close sidebar toggle */
--v2-z-modal:         200;   /* Modal, SidePanel */
--v2-z-tooltip:       210;
--v2-z-panel:         250;   /* AgentPanel */
--v2-z-toast:        9999;   /* Toast, skip-to-content link */
```

The rule the numbers encode: **the mobile navigation overlay outranks the app chrome it slides over, and modals outrank the navigation.** The drawer is `inset-y-0`, so its own logo band shares the top 56px with the bar, and its scrim exists to dim everything behind it — the bar included. Let the bar win and the drawer is decapitated, the scrim dims all but the top strip, and the toggle (which sits *inside* that strip by design, in the gap the bar reserves for it) cannot be tapped at all. That was #1749: a `z-[100]` header and a `z-[60]` toggle chosen independently in different files left mobile primary navigation unopenable on every authenticated route.

Tiers are spaced by 10 so a new layer lands between two without renumbering. Adding a layer means picking the tier it belongs to; if none fits, add one to the scale first. A raw `z-[…]` in a shell component is the failure this scale prevents — `src/__tests__/z-index-scale.test.ts` fails on one, and on any inversion of the order above.

That test reads source, so it cannot see stacking contexts or hit-testing. `e2e/mobile-nav-layering.spec.ts` is the half that can: it drives a real engine at four widths below `lg` and asserts `document.elementFromPoint` at the toggle's centre returns the toggle.

**One dim treatment for every overlay: `v2-modal-backdrop`** ([#1818](https://github.com/d-hinders/Haven-AI/issues/1818)). `Modal`, `SidePanel` and the mobile nav scrim all use it. It is a solid `--v2-modal-backdrop` fill and it deliberately carries **no `backdrop-filter`** — the reason is written at its definition in `globals.css`: a full-viewport blur makes the compositor hold a GPU snapshot of the whole page and re-blur it on every paint, which on tall pages ballooned VRAM and made the overlay feel sluggish.

The nav scrim was the exception until #1818, and instructively so: it read `bg-[var(--v2-ink)]/40 backdrop-blur-sm`, but the opacity modifier on a bare `var()` compiled to nothing (see § "Opacity on a token colour"), so the scrim painted no background — and a `backdrop-filter` with nothing behind it to composite costs nothing. **The blur was free only by accident.** Fixing the fill would have made it real, on a `fixed inset-0` element, which is precisely the shape the rule above exists to prevent. So the fix reused the shared token rather than reviving a second convention.

The general point, since it will recur: when a dead style rule comes back to life, the classes sitting *next to* it come back to life too. Re-read the whole class string, not just the one being fixed.

---

## 2. Typography

Font: Inter (already loaded via `next/font/google` in `app/layout.tsx`). Optional later: switch headings to Inter Display.

Authenticated app pages use compact product typography utilities from `globals.css`:

| Utility | Size / line-height | Weight | Tracking | Use |
|---|---:|---:|---:|---|
| `.v2-text-display` | 40 / 48px | 600 | -0.02em | Rare app hero display, not ordinary dashboards |
| `.v2-text-h1` | 28 / 34px | 600 | -0.015em | PageHeader title |
| `.v2-text-h2` | 20 / 28px | 600 | -0.01em | Major section titles |
| `.v2-text-h3` | 16 / 24px | 600 | 0 | Card and panel titles |
| `.v2-text-body` | 14 / 22px | 400 | 0 | Main app body copy |
| `.v2-text-meta` | 12 / 18px | 400 | 0 | Labels, captions, metadata |

Marketing pages may still use larger hero type:

| Role | Size | Weight | Tracking | Class string |
|---|---|---|---|---|
| Hero h1 | 44 / 64px | 600 | -0.03em | `text-[44px] md:text-[64px] font-semibold tracking-[-0.03em] leading-[1.02]` |
| Section h2 | 28 / 34px | 600 | -0.02em | `text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15]` |
| Color‑band h2 | 28 / 40px | 600 | -0.025em | adds extra size for impact on dark sections |
| Card title | 15 / 18px | 600 | -0.01em | depending on density |
| Body | 14 / 16px | 400 | normal | leading-relaxed |
| Hero lede | 17 / 18px | 400 | normal | leading-relaxed, color `--v2-ink-2` |
| Eyebrow | 12px | 500 | tracking-tight | uppercase only when on dark band; otherwise sentence case in brand color |
| Caption / mono | 11 / 12px | 400 | font-mono | for tx hashes, addresses, technical detail |

**Tabular numerals** (`.v2-tabular` utility, applies `font-variant-numeric: tabular-nums`) on every amount, address, step counter, metric.

**One h1 per page.** Eyebrows are `<div>`, not headings.

---

## 3. Component patterns

### Authenticated shell

The authenticated app uses one stable product shell:

- Sidebar: 240px desktop rail, mobile overlay, white surface, subtle active tint, and a 2px brand accent bar on the active route.
- Sidebar nav: 36px row height, 16px icon box, 13px medium label. (The Approvals item and its live actionable-count badge were the nav's only dynamic entry; both are deleted with the Safe rail, [#1989](https://github.com/d-hinders/Haven-AI/issues/1989) — every nav item is static now.)
- Brand: the wordmark may use `.v2-brand-gradient-text`; do not repeat the gradient elsewhere in nav.
- User menu: two-line user card with a kebab menu using popover shadow; destructive menu items use danger styling.
- Top bar: 56px blurred white header. Detail routes show a back link to the parent collection; page-level CTAs go in the `actionSlot`.
- Main content: scrolls inside the shell, with `p-6 lg:p-8` and a skip link targeting `main#main-content`.

### PageHeader

Use `components/ui/PageHeader.tsx` on authenticated pages instead of hand-rolled title blocks. It provides:

- Optional uppercase eyebrow.
- One compact h1 using `.v2-text-h1`.
- Optional subtitle using `.v2-text-body`.
- Right-side actions that wrap on narrow viewports.

Do not use marketing hero typography for normal authenticated pages.

### Buttons

**`Button` has four variants, and that is the whole set — but read the next sentence before
trusting it.** The four below were enumerated *from the source*, not from this list: the
`Variant` union at the top of `packages/frontend/src/components/ui/Button.tsx` and the
`VARIANT_CLASS` record beneath it, which cannot disagree with each other because
`Record<Variant, string>` makes TypeScript reject a missing or extra key. **That pair is the
authority; this section is a copy of it.** Enumerate from there whenever you need to know
what exists — `danger` went undocumented until
[#1817](https://github.com/d-hinders/Haven-AI/issues/1817) and `tertiary` until
[#1830](https://github.com/d-hinders/Haven-AI/issues/1830), and in both cases the mechanism
was the same: a reader found a plausible-looking list of three, and a list of three is
indistinguishable from a complete one. The compiler will force a new variant into
`VARIANT_CLASS`. Nothing forces it into this document.

**Variant vs. pattern.** Each entry below is labelled. A *variant* is a `variant=` value on
the `Button` primitive. A *pattern* is hand-rolled markup that looks like a button and shares
none of `Button`'s guarantees — sizes, tap target, disabled treatment, or focus ring.

#### Shared by every variant

These live in `Button`'s base class string, so they are variant-independent and stated once
rather than repeated per entry:

- **Three sizes**, `sm` (h‑9 / 36px), `md` (h‑10 / 40px, the default), `lg` (h‑11 / 44px) —
  plus the invisible 44px tap target on `sm` and `md`, see *Tap targets* below.
- **Focus-ring geometry:** `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]` — the one treatment,
  see *Focus rings* below. Ring **tone** is per-variant; see *Ring tone lives with the fill*.
- **Disabled:** `disabled:cursor-not-allowed disabled:opacity-60`. There is no per-variant
  disabled fill — every variant dims to 60% of itself. (Note this is *not* the same
  treatment the field micro-actions use; see *Button-shaped controls that are not `Button`*.)
- **Transition:** `transition-colors duration-150`. Colour only — nothing about a `Button`
  animates its size, position or spacing.
- **`href` turns it into a link.** With `href`, `Button` renders a `next/link` `<a>` (and
  accepts `target` / `rel`) with an identical class string; without it, a `<button>` (with
  `type`, defaulting to `"button"`). Same paint, different element — which matters for focus,
  because a `<button>` does not match `:focus-visible` on mouse click while an `<a>` behaves
  differently again.
- **`trailingIcon`** renders a 14px lucide `ArrowRight` after the label, at the base
  `gap-1.5`. It is available on **every** variant and on **both** elements — six of its eight
  call sites are the marketing `href`/`<a>` form, and two (`AddFundsModal.tsx:123` and
  `:166`) are `onClick` `<button>`s. **It does not animate.**
  (Through #1829 this section claimed the icon "slides 2px on hover via wrapper
  `group-hover:gap-2`". It never did: `Button` sets no `group` class and no call site wraps
  one. `group-hover:gap-2` is real, but it belongs to three hand-rolled marketing link
  affordances — `app/page.tsx:299`, `:320`, `app/protocols/page.tsx:80` — none of which are
  `Button`s. Corrected in #1830.)

#### The four variants

Primary — **variant**, `variant="primary"`, and the default when `variant` is omitted:
- `bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)]`
- `shadow-button`
- focus ring `focus-visible:ring-brand/80`

Ghost — **variant**, `variant="ghost"`. By a wide margin the most-used variant (see the
distribution note below):
- `bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]`
- focus ring `focus-visible:ring-brand/80`

Tertiary — **variant**, `variant="tertiary"`
([#1830](https://github.com/d-hinders/Haven-AI/issues/1830)). The *quiet* action: dismiss,
cancel, "not now" — the escape hatch beside a committing action, never the committing action
itself. Live at five product call sites plus the `/design-system` showcase — among them
`ConfirmDialog`'s cancel, `ProfileClient`'s cancel edit and `DashboardOnboardingGuide`'s
dismiss. (It was eight until [#1989](https://github.com/d-hinders/Haven-AI/issues/1989)
deleted `settings/ManageApprovers`, which held three of them.):
- `bg-transparent text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]`
- focus ring `focus-visible:ring-brand/80`

**Tertiary is not a quieter ghost — it is a different shape.** The two are worth
distinguishing explicitly, because "subtle neutral button" describes both and the choice
between them is made wrongly by default. Ghost paints a **box**: a white fill and a
`--v2-border-strong` outline, so at rest it reads as a control. Tertiary paints **no box at
all**: transparent fill, no border, and dimmed `--v2-ink-2` label, so at rest it reads as
text and only resolves into a control on hover — which is also the only variant that shifts
its *text* colour on hover (`ink-2` → `ink`), because it has no border to do that work.

That difference has a shipped consequence, and it is the rule to take from it: **tertiary
needs surrounding structure to be legible as pressable.** It works inside a dialog's action
row or at the end of a card, where position tells you it is a control. It fails in running
content — `connect-agent/SetupStates.tsx:219` records the case where a tertiary button
"rendered as stray bold text in the middle of a checklist rather than a control", and was
changed to ghost for the border alone while keeping secondary weight. Reach for ghost when
the control has to announce itself; tertiary when its context already has.

Danger — **variant**, `variant="danger"`, used for destructive confirmations (agent
revoke/remove, delete contact):
- `bg-[var(--v2-danger)] text-white hover:bg-danger/90 shadow-button`
- focus ring `focus-visible:ring-danger/80` — its own tone, per *Focus rings* below
- Note the hover is the **semantic token** `bg-danger/90`, not `bg-[var(--v2-danger)]/90`.
  The two look interchangeable and are not: an opacity modifier on a bare `var()` compiles to
  nothing, which is the whole subject of *Opacity on a token colour* above. This section
  quoted the dead form until #1830. The resting fill is safe in arbitrary-value form only
  because it carries **no** alpha modifier; `bg-danger` is defined in `tailwind.config.js`
  and would work there too. The mixed spelling in one class string is the tell — where the
  two forms sit side by side, the one with a modifier is the one that has to be semantic.

**Distribution, with the command that produced it.** Ghost dominates: 112 ghost, 11 tertiary,
5 danger, 1 primary — 129 literal occurrences, from `packages/frontend`:

```bash
grep -rhoE 'variant="(primary|ghost|tertiary|danger)"' src --include='*.tsx' | sort | uniq -c
```

The command is published because it has to be: during review of #1830 two reasonable
counting methods disagreed by roughly a factor of two, and a call-site number without its
command is not reproducible. It misses two things by construction. **`variant` is optional**,
so every unadorned `<Button>` is an uncounted `primary` — which is why primary shows 1 and is
nonetheless the most common button in the product. And it cannot see the four dynamic call
sites (`DashboardClient.tsx:334`, `ConfirmDialog.tsx:52`, `ReplaceSigningKeyModal.tsx:933`,
`CopyBlock.tsx:39`). The shape of the distribution is the point, not the integer.

**Ring tone lives with the fill ([#1817](https://github.com/d-hinders/Haven-AI/issues/1817)).**
The ring's *geometry* (`ring-2`, `ring-offset-2`, the offset colour) is uniform and lives in
`Button`'s base class string; its *colour* lives per-variant in `VARIANT_CLASS`, next to the
fill it has to agree with. That is not a stylistic preference — it is what makes the pair
**checkable**. While the colour sat in the base string, `variant="danger"` wore `ring-brand/80`
across four destructive confirmations, and no guard could see it: a per-class-string rule
cannot pair a fill in one declaration with a ring in another. Do not consolidate the three
repeated `ring-brand/80` values back into the base string to deduplicate them.

#### Button-shaped controls that are not `Button`

**This list is derived from a check, and the check is the artifact — not the list.** The
first draft of this section was itself a plausible-looking incomplete catalog, which is the
exact failure the opening paragraph warns about, so the enumeration is a command you can run
rather than a number you have to trust. From `packages/frontend`:

```bash
# Controls that hand-copy Button's base class string.
grep -rn "rounded-md font-medium tracking-tight" src --include='*.tsx' \
  | grep -v 'src/components/ui/Button.tsx'
```

**Clean output today is 1 line** — the surviving `BrandBandButton` primitive at
`components/marketing/BrandBandButton.tsx:75`. More than 1 is a new hand-copy;
zero means the scanner lost its last live subject. The retired investor page was
the second member until #2468 deleted it.

It was **4** until [#1867](https://github.com/d-hinders/Haven-AI/issues/1867), and the two
lines that left are the White-on-brand entry below — three hand-copies absorbed into one
component. Note what the drop does NOT mean: neither remaining line is a `Button`, and the
blind-spot paragraph above is unchanged. What changed is that the surviving members are both
single points of definition rather than call sites, so the next band CTA cannot start life as
a fourth copy.

**A hand-copy must now declare a focus treatment.** `focus-ring.test.ts` (#1867) runs this
same signature over `src/` and fails any matching class string with no
`focus-visible:ring-*` — the completeness rule the § *Focus rings* guards did not have, and
the reason `app/page.tsx`'s two CTAs could omit the ring for months while every declared
ring in the product was measured. It inherits this check's blind spot exactly (a control
built from scratch is still invisible to it) and does not pretend otherwise.

**What this check cannot see, stated because a check without its blind spots is just a
number.** It matches only controls that copied the *full* base signature. Button-shaped
controls built from scratch do not appear, and there are at least a dozen: the `MaxButton` /
`PasteButton` micro-actions below and `CodeBlock`'s copy button.
(`ApprovalNotifications.tsx:133` — a `next/link` styled as a button, with no
`focus-visible:` of its own — was the third example until
[#1989](https://github.com/d-hinders/Haven-AI/issues/1989) deleted it; the blind spot it
illustrated is unchanged.) **Treat the list below as known-partial for that class.** Making it complete would need a real lint rule —
something that classifies by rendered role rather than by class-string spelling — and that is
a code change nobody has scoped yet, not a longer paragraph here.

One member of that class is no longer hand-rolled: the **copy affordance** is now
`components/ui/CopyButton.tsx` ([#1878](https://github.com/d-hinders/Haven-AI/issues/1878)),
extracted from `Address` on its second call site per the pattern-absorption preflight. It owns
the hit area, the focus ring, the 1.5s check-pop and the silent catch around
`navigator.clipboard` — which rejects on insecure origins, denied permissions, and in most
headless captures, so every hand-rolled copy has to rediscover that. `CodeBlock`'s copy button
is still its own implementation and is the obvious next adopter; it is listed above as a blind
spot of the *check*, which it remains, but it is no longer a shape with nowhere to go.

White‑on‑brand — **`BrandBandButton`, a marketing component**
(`components/marketing/BrandBandButton.tsx`, [#1867](https://github.com/d-hinders/Haven-AI/issues/1867)).
Still **not** a `Button` variant — there is no `variant="white"` — but no longer three
hand-copies either. Used inside the dark CTA band, with two fills:
- `variant="solid"` (the default) — `bg-white text-[var(--v2-ink)] hover:bg-white/95` for the
  leading action
- `variant="translucent"` — `bg-white/10 text-white border border-white/20 backdrop-blur` for
  the trailing one

`href` picks its own element: scheme-bearing targets such as a `mailto:` render a bare
`<a>`, while internal targets use `next/link`, with the identical class string. An
optional `trailingArrow` renders the 14px arrow both solid CTAs carry — the same raw `<svg>`
its call sites used, deliberately not swapped for `Icon` + lucide, because this extraction
changes the focus treatment and nothing else about the painted pixels.

Three things follow, and the first two are why it is a component in `marketing/` rather than
a fifth `Button` variant:

- **It is off the size scale.** `h-12 px-6 text-[15px]` — a fourth size that `SIZE_CLASS`
  does not have and no product surface wants. It carries no `sm`/`md` tap-target overlay
  either, though at 48px it does not need one. Now stated once instead of three times.
- **Its ring is only correct on a brand band.** The offset is hardcoded
  `focus-visible:ring-offset-[var(--v2-brand)]`, so the control's correctness depends on its
  parent's background — which is also why it is not on `/design-system`: that page is a light
  product surface, and rendering it there would show the ring in the one place its premise is
  wrong. Unlike `Button`, the ring tone lives in the BASE string rather than per-variant
  (*Ring tone lives with the fill* is a rule about variants that sit on DIFFERENT
  backgrounds; both of these sit on the same band).
- **`Button`'s own guarantees still do not travel with it.** No `disabled` handling, no
  `type`, no tap-target overlay. It borrows the paint and the ring, not the primitive.

**What this entry used to record, kept because the mechanism is the lesson.** Through
[#1830](https://github.com/d-hinders/Haven-AI/issues/1830) the pattern had three hand-copies
and they disagreed: the retired investor-briefing page carried the correct dark-fill ring,
while `app/page.tsx:372` and `:381` — the highest-traffic CTAs in the product — carried **no
`focus-visible:` classes at all**. Neither set `focus-visible:outline-none`, so the UA
outline survived and it was **never a 2.4.7 failure**; it was a consistency defect, and
overstating it would have been the easier framing and the wrong one. Nothing caught it
because every focus guard at the time read rings that were DECLARED. The fix is the
extraction plus the completeness rule above — not two more copies agreeing.

The former `InvestorButton` was a page-local pattern, not a surviving implementation;
its removal is intentional because investor material now reaches investors through the
dataroom.

Field micro-actions — **pattern**. `MaxButton` and `PasteButton`
(`components/ui/Input.tsx`) are exported `<button>`s that are deliberately not `Button`s:
brand-coloured uppercase text at `px-1.5 py-0.5`, sized to sit inside a field's trailing
slot. They carry the system focus ring (`focus-visible:ring-brand/80`) but a **different
disabled treatment** — `disabled:opacity-40 disabled:pointer-events-none` against `Button`'s
`disabled:opacity-60 disabled:cursor-not-allowed`. Recorded as observed, not endorsed.

**No gradient buttons. No glow shadows.**

**Tap targets ([#1726](https://github.com/d-hinders/Haven-AI/issues/1726)).** `sm` paints
36px tall and `md` 40px — both under the ~44px usually cited as comfortable for touch.
(Not an accessibility failure: WCAG 2.2 AA *Target Size (Minimum)* floors at 24px. It is
mis-tap rate, and it bites hardest in row lists of destructive actions.) `Button` closes
the gap without moving any pixels: `sm` and `md` carry a transparent pseudo-element that
extends the **hit area** to 44px while the button still renders at its declared height.
`lg` is already 44px and carries nothing.

Consequences worth knowing:

- **Do not "fix" this by raising `h-9`/`h-10`.** The compact sizes are compact on purpose
  — tables, toolbars and row lists chose them for density — and changing them moves the
  rhythm of every one of those surfaces and invalidates the `/design-system` baselines.
- **The target grows vertically only.** An `sm` button's width already clears 44px at real
  call sites; growing it sideways would let a button in a `gap-2` toolbar swallow taps
  meant for its neighbour.
- **Keep at least 8px between stacked controls.** The overhang is 4px per edge on `sm` and
  2px on `md`, so at the 8px (`gap-2`) spacing this system typically uses between stacked
  controls, adjacent targets meet but never overlap. Tighter than that and two buttons
  fight over the same pixels — this is the one new constraint the mechanism introduces.
- Choosing `size` therefore stays a **density** decision, not an ergonomics one.

**The rule outlives the primitive ([#1766](https://github.com/d-hinders/Haven-AI/issues/1766)).**
A control that is not a `Button` inherits none of the above automatically, and the
first one to need it was the mobile sidebar toggle — a hand-rolled 32px square that
#1749 had just made reachable, so an undersized target went from moot to load-bearing
on the entry point to primary navigation. It borrows the same mechanism (transparent
`::after`, paint unchanged) with two deviations worth knowing before you copy it:

- **An icon-only square grows in BOTH axes.** "Vertical only" is not the rule; it is a
  consequence of a labelled `sm` Button's width already clearing 44px. A 32px square
  has no long axis, so the overlay is `h-11 w-11` and centred on both. What still
  applies is the *reason* behind the original rule — check what the widened target now
  reaches, in **both** states the control has. For the toggle, closed: right box edge
  x=54, nearest interactive control (`NetworkSwitcher`) at x=68, 14px of clearance.
  Open: the target floats over the drawer's own logo band, which it already did at 32px
  — what is asserted there is that the logo link is still reachable at its centre, not
  that nothing overlaps. Both are pinned in `e2e/mobile-nav-tap-target.mobile.spec.ts`.
- **The clearance is only as real as the space the neighbour is standing in
  ([#1767](https://github.com/d-hinders/Haven-AI/issues/1767)).** The 14px above was
  measured at 768px and assumed to hold on a phone. It did not. `TopBar` reserves the
  toggle's room with a `w-8` spacer, and `w-8` on a flex item still carries
  `flex-shrink: 1` — in a row that does not fit, it is the first thing given away. The
  spacer collapsed to **width 0** below about 700px, `NetworkSwitcher` slid left to
  x=36, and the painted toggle sat on top of it with 18px of the chip's own tap area
  inside the invisible overlay. **Reserve space with `shrink-0`, and assert the
  reserved box's measured width** — not just the gap it was supposed to produce.
- **A neighbour can be damaged without moving.** The chip's border box never changed;
  only a walked `elementFromPoint` showed its hit rectangle starting 18px right of it.
  Measure the neighbour the same way you measure the control.
- **Moving the control into the slot is not automatically the fix.** `left-6` would
  make the toggle concentric with the spacer and was rejected on measurement: it cuts
  the clearance above to 6px and pushes the target past the centre of the open
  drawer's own logo link (x=56). A spacer's job is to keep content clear of a floating
  control, not to be concentric with it.
- **Do not add `relative` to an already-positioned element.** `Button` needs it because
  it is static. A `fixed` or `absolute` control is already a positioning context, and
  adding `relative` un-fixes it — on the toggle that shifts the whole app shell 32px
  and drops the control back under `TopBar`, which was #1749. Do not take this on the
  prose's word: it is a claim about which of two same-property utilities the cascade
  keeps, so it is pinned by a test rather than by this paragraph —
  `e2e/mobile-nav-tap-target.mobile.spec.ts` asserts `header.left === 0` as an absolute
  anchor, and that assertion exists **because** the mutation passed three other mobile
  specs first.

**The second borrower, and what makes a control need the mechanism
([#1803](https://github.com/d-hinders/Haven-AI/issues/1803)).** `WalletButton` collapses
to a 40px icon/avatar square below `sm` — the label is not rendered there — and it takes
the same `::after` extension for the same reason the toggle did: 40px painted is 4px
short, and an icon-only square grows in both axes. Two rules generalise from it:

- **In an over-subscribed bar, drop a label rather than squeeze every control.** `TopBar`
  does not fit three labelled controls at 320px and never did. #1767 removed the
  overlapping by making the account chip the only compressible item, which paid for the
  whole deficit out of one label — the account name rendered **17px** wide, orderly and
  unreadable — and the brand CTA wrapped to two lines, painting taller than the 56px
  band. Collapsing the widest control's label returns 48.64px to the row and takes the
  account name to 66px. Squeezing distributes a deficit; dropping decides what the width
  is for. The decision of WHAT to drop is a product one — it was escalated and taken by
  the owner, not by the layout.
- **A dropped label must survive as an accessible name.** `hidden sm:inline` is
  `display: none`, so the text stops contributing to the accessible name and the control
  announces as "button". Every collapsing state carries an explicit `aria-label` (plus a
  matching `title`, which is the pointer-hover mitigation for the lost label). jsdom
  applies no CSS, so a unit test that queries by role and name keeps passing on text the
  real browser never renders — `e2e/mobile-nav-tap-target.mobile.spec.ts` measures the
  rendered label width and the name together, and `WalletButton.test.tsx` asserts the
  attribute rather than the name.

A collapsed control also takes its neighbour's radius (`rounded-xl` here, the
notification bell's), because two adjacent 40px squares in one 56px band read as a row
only if they are the same shape.

**The former investor-briefing borrower was retired with the page in #2468.** The
remaining borrowers and their guards are the live tap-target examples; do not infer a
requirement from the deleted route or its dedicated e2e spec.

<!-- The former third-borrower measurements are retained below as historical context. -->
**Former third borrower — the one that needed `relative` rather than being told not to
add it ([#1955](https://github.com/d-hinders/Haven-AI/issues/1955)).** `/investor-briefing`'s
`InvestorButton` at `size="sm"` paints `h-9` — 36px — and the page's `sticky top-0` header
keeps exactly that instance on screen for all 6,140px of the page. Measured at 393px before
the fix, its hit rectangle was **150×36**: the border box and nothing more. It now reads
**150×44** while still painting 36, because the header band's density depends on the paint
(raising it was explicitly rejected, the same call #1726 made for the product app).

The wrinkle worth recording, because the two borrowers above would otherwise mislead: this
one is a **statically positioned `<a>`**, so it MUST take `relative` — the overlay has no
containing block otherwise. The "do not add `relative`" instruction attached to the mobile
toggle is not a general rule; it is specific to a control that is ALREADY positioned
(`fixed` there), where `relative` would unposition it. Read the control's existing
`position` before borrowing, rather than copying either instruction wholesale.

Marketing surfaces are design-lint-exempt ([#874](https://github.com/d-hinders/Haven-AI/issues/874)),
so nothing mechanical watched this retired one. The dedicated
`e2e/investor-briefing-tap-target.mobile.spec.ts` was removed with the page. It was the
whole guard, and it asserted BOTH halves — the 44px hit rectangle and the unchanged
36px paint — because a "fix" that raises the paint satisfies the first and breaks the
density the issue was protecting.

**The fourth borrower, and the first one where the target was the SECOND defect
([#2241](https://github.com/d-hinders/Haven-AI/issues/2241)).** The `/accounts` card's
`Set active` (72.6×24 painted) takes the mechanism vertical-only, per the rules above.

> **Half of this borrower is retired ([#2374](https://github.com/d-hinders/Haven-AI/issues/2374)).**
> It was a PAIR: `Set active` plus a `Set as default` star (26×26) taking `h-11 w-11` in
> both axes, and the paragraphs below were written about both. The star was dropped from
> the card by owner decision — #2241 made it permanently visible on touch, at which point
> it was a bare glyph whose meaning existed only in `aria-label`, and every way of
> explaining it in place cost the title row width that #2223 / #2235 / #2236 had already
> spent three issues protecting. Setting a default lives on `/accounts/<id>` only.
>
> **The both-axes rule for an icon square did NOT leave with it** — it is general, it is
> stated above, and `WalletButton.tsx` still borrows it. What left is this borrower's
> *example* of it. Read the star in the bullets below as history that explains the shape
> of the rules, not as a control you will find in `AccountsOverviewClient.tsx`.

What is new is the defect the measurement found *underneath* the undersized target, which
the issue had diagnosed the other way round:

- **`opacity-0` hides a control from the eye and from nobody else.** The pair sat in an
  `opacity-0 group-hover:opacity-100 focus-within:opacity-100` wrapper, and the issue
  read that as the controls being unreachable on touch. Measured at Pixel 5,
  `elementFromPoint` at each centre still returned the button: `opacity: 0` suppresses
  painting and leaves hit-testing untouched. So the card carried an invisible 73×24 and
  an invisible 26×26 live control in its top-right corner — where a finger lands to open
  the account — and both handlers `preventDefault()`, so the tap did not navigate. It
  wrote a new default account, silently. **Invisible and still live is worse than
  unreachable**, and only a hit-test can tell the two apart; `hidden`, `pointer-events-none`
  and `opacity-0` are three different states that photograph identically.
- **Gate the hover treatment on `(hover: hover)`; do not add a `(hover: none)` override.**
  The fix is `[@media(hover:hover)]:opacity-0` plus the same guard on the two reveal
  variants, so a hover-less device never enters the branch and the wrapper keeps its
  default opacity. The tempting form — leaving `opacity-0` and adding
  `[@media(hover:none)]:opacity-100` — is two `opacity` utilities of equal specificity
  racing on Tailwind's emitted order. This form has nothing to race. **What it does
  NOT fix, stated rather than glossed:** `(hover: *)` describes the PRIMARY pointing
  device, so a touchscreen laptop whose primary input is a trackpad reports
  `hover: hover` and stays on the hover-gated branch — a finger on that screen still
  meets the invisible-but-live control. `any-hover` would catch it and would also put
  every mouse user with a touchscreen on the always-visible branch, which is a
  different product call, not a bug fix. This is the limit of the media feature, not
  of this borrower, and it applies to every hover-reveal in the system.
- **Revealing an `opacity-0` control on touch costs the layout nothing.** `opacity-0` is
  not `hidden`: the pair was already in normal flow reserving its width on every card that
  rendered it, hovered or not (102.6px before, 108.6px after — the 6px is the gap below,
  and it is the only width the fix adds). That is what makes this a CSS fix rather than the
  information-priority decision the same row's width has needed three times
  ([#2223](https://github.com/d-hinders/Haven-AI/issues/2223) /
  [#2235](https://github.com/d-hinders/Haven-AI/issues/2235) /
  [#2236](https://github.com/d-hinders/Haven-AI/issues/2236)). Check which of the two you
  have before reaching for either.
- **Two adjacent borrowers make the clearance rule bite in-component, not just against a
  neighbour bar.** At the original `gap-1` the star's 9px-per-edge overhang reached 5px
  into `Set active`'s own box — the #1767 failure with both controls inside one wrapper.
  `gap-2.5` left 1px. The § *Tap targets* "at least 8px between stacked controls" line
  is the general form; 8px is not enough when the smaller control is an icon square, and
  the arithmetic (`(44 − painted) ÷ 2` against the gap) is the thing to run. **This is the
  bullet #2374 emptied of its example**: one control means nothing to clear, so the
  `gap-2.5` went with the star rather than being left as a number nobody could re-derive.
  The rule stands and the arithmetic is still the thing to run — the next adjacent pair
  will need it, and it will not have this call site to copy from.

**Every width in this paragraph is a macOS reading, and one of them moves.** `Set active`
is a text button: 72.6px on macOS, **75px on the Linux CI runner**, so the reservation
figures above shift with it and an absolute pin on that width fails CI as a font-metric
assertion dressed up as a layout one — it did, once. Pin the geometry (the two heights,
and the icon square's 6 + 14 + 6) and express the sideways rule as a relationship
(`hit width − painted width ≈ 0` for an `inset-x-0` overlay) instead.

`e2e/accounts-card-tap-target.mobile.spec.ts` pins all of it, and `/accounts` has no
committed pixel baseline at any width — so, as with #2038, the blocking visual gate could
not have seen any of this. Since #2374 that spec also pins the star's **absence**,
page-wide and against both spellings a reintroduction could take, with the surviving
`Set active` control as its non-vacuity check.

**Prove it rendered, not in the class string.** A pseudo-element overlay has several
silent no-op failure modes (a clipping ancestor, a positioning context resolving
elsewhere, another element winning the band), and none of them exist in jsdom — which
has no layout, no stacking contexts and no hit-testing. Measure the hit rectangle by
walking `elementFromPoint` outward from the centre in a real engine; `getBoundingClientRect`
returns the border box and reports 32×32 even when the overlay works perfectly.

### Cards (`Card`)

`bg-white border border-[var(--v2-border)] rounded-[10px] shadow-card`. Padding by use: `p-7` standard, `p-5` compact, `p-7 md:p-10` hero‑adjacent.

Interactive cards (linked) add hover lift — see Shadows above.

`Card` supports `elevation="flat" | "raised"` and `hover={false}`. Use `raised` only for prominent page anchors, and keep nested or data-dense cards flat.

**A card in a grid has to fit its track, and by default it cannot ([#2251](https://github.com/d-hinders/Haven-AI/issues/2251)).** This is the card sibling of the `truncate`d-table-cell rule under *Transaction tables* below, and it has the same shape: a `truncate` descendant is `white-space: nowrap`, so its min-content is the whole string, and a container that is never allowed to go below its min-content grows instead of ellipsising.

What makes it a *grid* rule is where the "never allowed" comes from. A grid item's `min-width` defaults to `auto`, which resolves to its min-content — and an implicit `auto` column takes its minimum from that. Tailwind's `grid-cols-N` is `repeat(N, minmax(0, 1fr))`, whose explicit `0` overrides it, so **a responsive grid is safe at the breakpoint where its columns are declared and unsafe below it**. `/agents` is `grid items-start gap-4 lg:grid-cols-2`: correct at `lg` and up, and below `lg` its single implicit column was sized by the widest card's min-content. At 390 that put a 488.3px card in a 342px track — clipped rather than scrollable, because `main` is `overflow-x: auto` inside an `overflow-hidden` parent, so `documentElement.scrollWidth` stayed 390. The shared `expectNoHorizontalOverflow()` helper still sees it, on its `main#main-content` reading (#1779): measured `contentOverflowBy: 122` before the fix and `0` after. It was the SEED that was missing, not the assertion — the standing `/agents` mobile check is green on the shared fixture because that leaves `mcp_server_name` absent, and the `not recorded` branch is a 66px label with nothing to truncate.

Two things follow for anyone building one:

- **Put `min-w-0` on the grid item itself.** It is what stops one card's content setting every sibling's width, and it is invisible until some real value gets long enough.
- **`min-w-0` has to reach the truncating element without a gap.** On `/agents` there were already three of them — the header's `flex-1` block, the MCP row, `McpServerName`'s wrapper — and the chain still failed, because `Tooltip` renders its non-`block` trigger as a bare `<span className="inline-flex">` with no `min-width: 0` and no `className` passthrough. One un-shrinkable link defeats every `min-w-0` above it. When a `truncate` element sits inside a wrapper you do not control, give that wrapper the `min-w-0` from its parent.

Both halves are needed and neither is sufficient: with only the card's `min-w-0` the card fits the track and the chip spills out of the card instead. Proven by rendered geometry, not by a class assertion or a baseline, in `e2e/agent-card-fit-measure.spec.ts` — the numbers, the per-seed floors and the mutation results live in that file's docstring.

**Fitting the track does not fit the header — what a narrow card drops is a product decision ([#2325](https://github.com/d-hinders/Haven-AI/issues/2325)).** The grid-track rule above stopped `/agents` cards growing past their column; the space the card then had to divide exposed the next defect in the same header row. At 390 the card's header row is 300px, and it splits: bot tile 36 + gap 12 + the name/account/MCP block (`min-w-0 flex-1`) 121.2 + gap 12 + the `ml-auto shrink-0` "Last activity" stamp **118.8**. The stamp takes 40% of the row and cannot yield, so the MCP chip inside the block gets **38.5px** — which ellipsises even a short slug: `haven-research` measures **113px** and renders as `haven…` on every card, the opposite of what #1878 added the chip for.

Two single-class repairs were measured dead on #2324's branch and are recorded so nobody re-derives them: **`flex-shrink: 1` on the stamp** does nothing — free space at this width is positive (the block is `flex-1` with a `0%` basis and absorbs the remainder), and flex shrinking engages only when free space is negative; **`flex-wrap` alone** does nothing — wrapping is decided on base sizes, and the block's base size is `0%`, so it never pushes the stamp onto a second line.

The decision taken: **the MCP wiring outranks the last-activity stamp on a narrow card.** `flex-wrap` on the header row plus `basis-full sm:basis-auto` on the stamp — `basis-full` makes the stamp a full-width flex item, which is what actually forces the wrap (the row's `flex-wrap` alone never does), dropping it to its own line below the block at every width below `sm` (640px), left-aligned there (`text-left sm:text-right`) so it flows under the description in reading order rather than jutting right under an otherwise left-aligned stack — the rendered review pass found right-flush gave a deliberately demoted element more pull than it should carry; `sm:basis-auto` puts it back on the line at `sm` and up, so tablet and desktop are unchanged. The stamp is moved, not deleted — its text and `title` tooltip are untouched, and the chip keeps the `truncate` elaboration contract (tooltip plus sibling `CopyButton`). With the row to itself the block hands the chip its full natural 113px.

**Why the breakpoint is `sm` and not the width the short slug needs.** Below `sm` the wrap is unconditional, so between roughly 466 and 639 a card whose slug is short takes a line it did not strictly need — the review pass on this change measured that band and asked whether the breakpoint should move down into it. It should not, and the answer is a measurement rather than a preference. Sweeping the UNWRAPPED layout: `haven-research` (natural 113px) renders whole from 466 up, but a 34-character slug (natural 258px) is still cut to **148.5px at 500** and **208.5px at 560**, and only renders whole from **639**. So 640 is the width at which the unwrapped header stops truncating a long slug too, not a convenient default; moving it down to spare the short slug its extra line would hand the 466-639 band back to this same defect, for exactly the agents whose names are hardest to tell apart. What the band actually costs is one line of vertical space on a short-slug card, against no slug being truncated anywhere below `sm` — the same trade as the wrap itself. Pinned by the spec's 500px arm.

Proven by rendered geometry in `e2e/agent-card-mcp-chip-measure.spec.ts`: at 390 the chip must render at least its own `scrollWidth` (re-measured at runtime, so the bar is not a literal tuned to one renderer) and the stamp's top must sit at or below the block's bottom; a 768 control arm pins the breakpoint in both directions. Mutation-proven by reverting the two classes: the 390 arm goes red on the mechanism guard (measured on the revert: stamp top 263px against block bottom 347px, and the chip 38.5px of its 113px natural width) while the 768 control stays green. `e2e/agent-card-fit-measure.spec.ts` stays green alongside — the width handed to the block comes from the stamp's own line, not from letting the card overflow its track again.

### Modal (`ui/Modal`)

Every dialog in the app is this one shell — eleven direct importers, three of
which (`ConfirmDialog`, `InfoModal`, `ComingSoonModal`) are themselves wrappers
with many call sites. Anything changed here is changed everywhere, so the
structure is worth stating rather than re-deriving from the file.

**Three boxes, and only one of them scrolls.** This is the fact that makes most
guesses about `Modal` wrong:

| Box | What it is | Scrolls? |
|---|---|---|
| The wrapper | `fixed inset-0 … p-4`, and it carries `role="dialog"` | **No.** `overflow: visible`, `position: fixed`. It reports ~4px of `scrollHeight` overflow from its own padding that `scrollTop` can never consume |
| The panel | `max-h-[calc(100vh-2rem)]`, `overflow-hidden`, `flex flex-col` | No |
| The body | `[data-modal-body]` — `min-h-0 flex-1 overflow-y-auto` | **Yes. This is the only scroller.** |

Two consequences, both of which have already cost real time:

- **A test that reads scroll geometry off `getByRole('dialog')` cannot fail** —
  it is measuring the wrapper. Use `[data-modal-body]`. Note that
  `ReceiveFundsModal` is a bespoke dialog, *not* built on this primitive, and it
  puts `role="dialog"` on its scrolling panel — so the two are not
  interchangeable and a helper written against one is wrong for the other.
- **The `footer` prop renders OUTSIDE the scroll box**, as a flex sibling. It is
  not "below" the body in the scroll sense, so nothing placed there can describe
  the body's overflow.

**The scroll continuation cue ([#1893](https://github.com/d-hinders/Haven-AI/issues/1893)).**
While the body has content under the fold, a 6px `.v2-scroll-edge-cue` overlay
marks its bottom edge; it retires at the end of the scroll. The trigger is pure
geometry — `scrollHeight > clientHeight + scrollTop` — so it is correct for a
dialog whose content grows after mount without any caller opting in. DOM hooks:
`[data-modal-body]` for the scroller, `[data-modal-scroll-cue]` for the overlay.

Three decisions in it that a future editor cannot infer from the markup:

1. **It is a translucent inset shadow, not a fade to a background colour.** The
   first implementation was `bg-gradient-to-t from-white`, which hardcodes "the
   surface behind me is white". Over the re-key flow's amber "Before you approve"
   callout that bleached the callout to near-white and read as its background
   failing to paint. A shadow composites over whatever is actually there, so it
   darkens a tinted surface instead of erasing it — and it stays correct if a
   caller ever passes a tinted `bodyClassName`, which `design:lint` cannot check
   for because its token rule does not scan gradient stops.
2. **6px, fixed — it marks a boundary, not a quantity.** It does not scale with
   how much is hidden, because the amount hidden does not change what the edge
   means. The rejected first version was 32px, which over a 44px overflow
   swallowed the last line instead of hinting at it.
3. **No transition on the initial, mount-time appearance — and that is the
   whole of the decision.** A dialog that opens already overflowing gets its
   first honest reading in an effect *after* the first commit, so a fade-in
   there would be exactly the first-paint entrance motion § 4 bans, in every
   overflowing dialog in the app.

   **The recurring toggles while a user is actively scrolling an open dialog
   are an OPEN question, not a settled one.** They are not first-paint motion
   and sit closer to the transitions § 4 allows — which
   `docs/product/design-review.md` would require to be gated behind
   `prefers-reduced-motion: no-preference`. They currently have no transition
   because none was added, not because one was argued against. What is known:
   at 6px the snap is a hairline rather than a flash, and it costs **no layout
   shift** — measured across a real scroll, the body holds `clientHeight` 362
   and `top` 169 while the cue toggles, because the cue is a pure overlay. That
   is why it was not treated as urgent; it is not a reason the question is
   closed.

The cue is `aria-hidden="true"` and `pointer-events-none`, and **that is
deliberate, not an oversight**: it is a purely geometric affordance that carries
no information a screen reader user needs, and hit-testing must pass straight
through it so a control at the bottom of a scrolled body stays clickable. See
also the `role="dialog"` bullet in § 6.

**Actions belong in the `footer` prop.** `ConfirmDialog`, `AccountSignersCard`,
`ReplaceSigningKeyModal` and `contacts/page.tsx` do this. Do not add new dialogs
that render an action row as the last children *inside* the scroll body.

[#1946](https://github.com/d-hinders/Haven-AI/issues/1946) named three dialogs
in that shape and — this is the part worth keeping — **measured them before
changing any of them**, because a fix for an overflow that does not occur is a
change with no defect behind it. Measured in Chromium, action-row pixels below
the fold at rest:

| dialog | 1280x800 | 390x844 | 844x390 | 640x400 | button pressable? |
|---|---|---|---|---|---|
| contacts, duplicate-address hint showing | 0 | 0 | **37** | **27** | no — `disabled` by policy |
| contacts, save-error box showing | 0 | 0 | **98** | **89** | **yes** |
| `DelegationSendModal` | 0 | 0 | 0 | 0 | — |
| `ComingSoonModal` | 0 | 0 | 0 | 0 | — |

**The two contacts rows are not equally strong evidence, and the difference is
the point.** With the duplicate-address hint showing, the submit button is
`disabled`, so being off-screen cost the user sight of the control they had to
correct — real, but the weaker case. With the save-error box showing the button
is ENABLED and pressing it again is the user's next action, so being off-screen
cost them the action itself. That is the case this dialog most needed fixing
for, and it also overflows by more. Both states are asserted at both viewports.

Only `contacts/page.tsx` was moved. The other two need a viewport under ~340px
tall before their action row goes below the fold, which this app does not
support, so they were left as they are rather than restructured for symmetry —
`DelegationSendModal` especially, being a money-movement dialog whose §6 claims
live in a contract doc. **A consistency argument is not a defect**, and the two
short viewports that made the contacts case real are not hypothetical ones:
844x390 is a phone in landscape, and 640x400 is this app at 200% browser zoom,
which WCAG 1.4.4 requires to work.

**Moving an action row out of a `<form>` needs the `form` attribute, not an
`onClick` rewrite.** The footer is a flex sibling of the body, so a submit
button placed there is no longer a descendant of a `<form>` in the body.
`ui/Button` takes a `form` prop for this; it preserves implicit submission
(Enter in a text field), which retyping the button as `type="button"` with an
`onClick` would drop silently. Guarded in
`e2e/modal-action-row-reachability.spec.ts`, which asserts the form OWNER
resolves rather than that the attribute string matches — a stale id compares
equal and still submits nothing.

### Local hint marker (#1952)

A **known but not-preferred** fact, stated beside the thing it qualifies:
`border-l-2 border-[var(--v2-border-strong)] pl-3` on the block, plus an
icon-led label row (lucide `Info` at `h-3.5 w-3.5 flex-shrink-0`, `text-xs
font-medium text-[var(--v2-ink-2)]`). One call site so far —
`WalletButton.tsx`'s "No passkey enrolled on this device", shown in both states
on `/design-system` → *Signing credential (wallet menu)*.

**Reach for it instead of a semantic tone when nothing has failed.** There is no
`--v2-info` family, and `--v2-warning` is scoped to 402/pending-review (§ 1), so
the honest options for "legible but not alarming" are this or plain muted text.
Muted text is the right weight for mild friction — the #1097 "passkey may be on
another device" hints in `AccountSignersCard` and `DelegationSendModal` are
deliberately unmarked. This marker is for the step above that: a fact the user
would want to act on, on an authority-bearing surface.

**Recorded as a pattern on ONE call site, which is thinner than this section's
usual bar** (§ 5's Arrows subsection declines a precedent on one instance). It
is written down anyway because the alternative was worse in a specific way:
`--v2-border-strong` already had three unrelated uses, plain `border-l` +
`--v2-border` grouping exists at three more call sites
(`ConnectionVerificationFooter.tsx`, `WaitingForConnector.tsx` ×2) at a lighter
weight, and none of them is documented — so the next author wanting a local hint
had four undocumented shapes to copy and would plausibly have hand-rolled a
fifth. Two reviewers split on whether this belongs here; it is recorded rather
than omitted because a wrong entry is cheap to delete and a missing one is
invisible. If a second call site never appears, delete it.

### Inputs

Use `components/ui/Input.tsx` for product forms. Inputs have visible borders, token focus rings, and support:

- `leftIcon` for search, token, or address context.
- `rightAction` for field-local affordances such as `MaxButton` and `PasteButton`.
- `invalid` and `helperText` for inline validation.

Amount fields should use `.v2-tabular`. Paste handlers should trim pasted whitespace. Do not rely on toast alone for validation; field errors belong next to the field.

`Input`, `Select`, `Textarea` and `Checkbox` are **one family**: same radius, surface, padding, focus ring, and `invalid`/`disabled` treatment, so a mixed form row aligns and nothing looks bolted on. Reach for the primitive — a hand-rolled control drifts from the family the moment either side changes, which is what [#1410](https://github.com/d-hinders/Haven-AI/issues/1410) had to undo.

### Inline alerts

Use `components/ui/InlineAlert.tsx` for a short field- or dialog-level failure. It owns
`role="alert"` and the danger text token; the surrounding field or content stack owns
spacing. Pair an invalid field's `aria-describedby` with the alert's optional `id`.
Keep larger failed-state panels and transient action feedback in their dedicated panel or
toast patterns instead.

### Textarea

Use `components/ui/Textarea.tsx` for multi-line fields — the `Input` half of the family, with the same `invalid` and `helperText` support. `resize-none` by default (dialog fields should not grow under the user); pass `className="resize-y"` where growing is genuinely wanted.

### Checkbox

Use `components/ui/Checkbox.tsx`. Every checkbox in Haven is a box **plus an explanation**, so the primitive owns the `flex items-start gap-2` label row and takes a required `label` (plus optional `helperText` for a consequence on a second line). Pass `className` for the row's own typography or surface.

It is the **native** control with `accent-color`, not a custom-painted box: keyboard behaviour, focus ring and screen-reader semantics come from the platform rather than being re-earned. The wrapping `<label>` gives implicit association, so the text is a click target with no `id`/`htmlFor` wiring at the call site — do not re-add one.

One limit worth knowing before you reach for it: no ref is forwarded, so `indeterminate` — a DOM property rather than an attribute — is out of reach. Every checkbox in Haven is a single confirmation, so nothing needs it; add `forwardRef` when a real tri-state (a select-all header, say) actually arrives.

### Skeletons

Use `components/ui/Skeleton.tsx` instead of inline `animate-pulse` divs. The primitive is caller-sized; choose `variant="text"`, `variant="rect"`, or `variant="circle"` for radius only. Loading containers that replace meaningful content should use `role="status"`, `aria-busy="true"`, and `aria-live="polite"` around the skeletons.

### Toasts

Use `ToastProvider`, `Toaster`, and `useToast()` for short feedback after user actions such as copy, save, send, or retry. Toasts:

- Auto-dismiss after 4 seconds and cap at 5 visible messages.
- Use polite live regions for info/success and assertive live regions for errors.
- Supplement the screen state; they do not replace inline error, loading, or success content when the user needs to act.

### Tooltips

Use `components/ui/Tooltip.tsx` for brief clarification that ELABORATES on something already visible — the full form of a truncated address, the second half of an MCP server pair, what a column sorts. Tooltips are portaled and use popover shadow.

Tooltips must not hide essential instructions, money/risk information, or the only copy of a raw address that the user must copy. If the value is required to complete the task, show it inline. #2017 is the worked example: an explanation a user needs in order to judge whether they still control their account was moved out of a tooltip and into visible text, and that decision stands.

**Reachability, and its one deliberate limit (#2038).** The trigger takes focus and a tap only when it is nobody else's control — nothing focusable inside it, and no interactive element around it. Where the trigger already is (or sits inside) a button, link, or composite `role="link"` card, the primitive stays out of the way: adding a tab stop would nest one inside a single control, and adding a tap-toggle would fire alongside that control's own action and strand a bubble over whatever the tap opened. So a tooltip nested in a composite card — `McpServerName` inside `AgentCard` is the live case — remains **hover-only**, which is another way of saying its copy must not be essential.

**Essential vs elaboration, worked on one component (#2043).** `McpServerName` carried BOTH kinds and is the clearest test the codebase has. Its `not recorded` branch held a 169-character explanation of an ABSENCE — there was no visible value for it to elaborate, and its whole job was to stop a user concluding their agent is broken. That is essential, so it moved to visible text: one sentence above the agent list, rendered only when some listed agent is unrecorded, following #2017's shape rather than inventing a second one. Its recorded branch kept its tooltip, and the difference is not a matter of degree:

| ask | essential | elaboration |
|---|---|---|
| Is a value already on screen for it to expand? | no — it explains an absence | yes — the name is rendered |
| Is the tooltip the only route to the fact? | yes | no — the sibling `CopyButton` yields it verbatim |
| What does a user who never reaches it lose? | the reason a label is empty | a longer form of what they can already read |

Reachability is the SYMPTOM, not the test. A tooltip the primitive can make reachable may still be the wrong home for essential copy, and this limit is only what makes the mistake unrecoverable here.

A standalone trigger takes the same `focus-visible` ring as every other focusable control (`ring-2` + `ring-brand/80`) — this primitive is what made it focusable, so a bare browser outline beside `Table`'s and `Sidebar`'s rings on the same page would be its own defect. A touch also suppresses the mouse path for one second, not forever: browsers emit compatibility `mouseenter` shortly after a tap, which otherwise reopened a bubble the tap had just closed, but a permanent latch would kill hover on a touchscreen laptop after one incidental tap.

**Width.** The bubble wraps inside `max-w-[min(20rem,calc(100vw-1rem))]` and is clamped back inside the viewport with an 8px gutter after layout. It was `whitespace-nowrap` with no cap until #2038: a 169-character label rendered 988px wide on a 320px screen. No pixel gate could see it, because a tooltip that is not open is in no screenshot.

### Transaction tables

Use `components/transactions/TransactionsTable.tsx` for full transaction history routes. It is a semantic sortable table:

- Desktop columns: direction icon, Activity, Initiator, From/To, Date, Amount, external link.
- **Initiator semantics (#2097):** the Initiator column reads the transaction record's explicit `initiatedBy` — the agent identity for agent-initiated rows, `You` only for `initiatedBy === 'human'` (no dashboard-send path sets it today), and an explicit unknown (`Unknown`) for un-attributed outbound rows; it never defaults to `You`. The detail panel's Initiator row shares the same helper (`transactionInitiator`).
- Sticky header on desktop.
- A narrow container hides secondary columns and keeps icon, activity, amount, and external link readable.
- Date and Amount are sortable; amount sorting uses the raw transaction value, never the formatted display string.
- Empty state renders inside the table with the correct column span.

Use `TransactionActivityRow` for compact dashboard, account detail, or agent detail previews.

A collapsing table like this one has to **fit** at mobile widths, not scroll: the `overflow-x-auto` wrapper the `Table` primitive recommends for dense admin tables is mutually exclusive with `Table.Head sticky`, because `overflow-x: auto` forces the computed `overflow-y` to `auto` and the wrapper then becomes the sticky scroll ancestor. When such a table overflows, the cause is usually a `truncate`d cell — `truncate` is `white-space: nowrap`, and an auto-layout column can never be narrower than its min-content, so the untruncated text widens the table instead of ellipsising. Put `max-w-0` on the one flexible cell. Both findings, with their measured numbers, live in `components/ui/Table.tsx`'s docstring ([#1772](https://github.com/d-hinders/Haven-AI/issues/1772)).

**Column collapse is keyed on the table's CONTAINER, not on the viewport, and it still takes more than one stage.** Two things step at `lg` and both take width: the sidebar goes `fixed` to `lg:static` at `w-[240px]` — border-box, so its 1px `border-r` is *inside* the 240 (`main` measures 784px at a 1024px viewport) — and the authenticated layout's `main` steps `p-6` to `lg:p-8`, 16px more across the pair. **240 + 16 = 256px** handed back in a single breakpoint, so the content available to a table is a **sawtooth** in viewport width, not a ramp. Attributing it to the sidebar alone is wrong and invites a reader who checks `Sidebar.tsx`, finds 240px, and discards the whole claim. Measured in real Chromium on `/design-system`, `/transactions`, `/accounts/:id` and `/agents/:id` — the same numbers on all four, because they share the shell:

| viewport | 390 | 767 | 768 | 900 | 1023 | 1024 | 1279 | 1280 |
|---|---|---|---|---|---|---|---|---|
| container | 340 | 717 | **718** | 850 | 973 | **718** | 973 | 974 |

A table is exactly as cramped at 1024px as at 768px. Revealing every column at `md` therefore starved the Activity measure twice — 71.1px across five lines at 768px, and identically at 1024px ([#1827](https://github.com/d-hinders/Haven-AI/issues/1827)). That issue wrote 241 + 16 = 257 for the step; the conclusion was right and the number was not — the sidebar's border is inside its 240px.

So `Table.HeaderCell` / `Table.SortableHeaderCell` take **`revealAt="md" | "xl"`**, which are **container** widths of **718px** and **974px** ([#1999](https://github.com/d-hinders/Haven-AI/issues/1999)) — the container widths at the shell's own `md` and `xl` teeth, chosen so re-keying changed the variable and not a single rendered pixel. Three consequences:

- **A container query does not remove the second stage.** The container really is 718px at a 1024px viewport, so a single-stage reveal starves the title there just as before. What it removes is the need to rediscover the sawtooth in order to pick the viewport that clears both teeth: 974px is simply the width at which seven columns fit.
- **Header and body must be converted together, always.** The `<th>` takes `revealAt`; the matching `<td>` takes `tableColumnClass(stage)` from the same module, and relocated content (a movement line under a narrow title, a date under the Amount) takes `tableHideFromClass(stage)`. A `<th>` on a container stage over `<td>`s on a `md:` variant is #1774 one layer down — width declarations on a `display: none` cell take no part in column sizing, and the result measures byte-identical to a fix.
- **Every table gets the container; there is no opt-out, and that is deliberate.** A dense table that scrolls (`Table.Head collapseWhenNarrow={false}` plus an `overflow-x-auto` wrapper) keeps it too. The containment does **not** defeat the scroll — measured on the z-index table at 390px, which is `min-w-[560px]` inside its wrapper: with the container in place the table still lays out at 560px and the wrapper still reports `scrollWidth` 560 / `clientWidth` 340 with `scrollLeft` reaching 220, identical to the reading without it. An opt-out would be worse than useless: a caller pairing it with `revealAt` emits a `@container v2table` condition with no container-named ancestor, and per spec such a query never matches — so the base `hidden` wins **permanently, at every viewport, in every browser**. Silent and total, and strictly worse than the unsupporting-browser case the `@supports` fallback exists for.

- **Container-keying makes DOM mount order a layout input**, which viewport-keying never did. `Sidebar` is `dynamic(ssr:false)`, so for the frames before its chunk mounts the shell hands the table ~256px it is about to take back. Measured two ways. Deterministically (stage with the sidebar in layout vs `display: none`, fixed viewport): `/transactions` is same-stage at 768/1024/1100/1279/1280, so no mount transition can change its column set. By timing, at low load: the `/design-system` showcase paints **seven** columns at a 1034px container and collapses to **five** at 794px roughly **106ms** later at a 1100px viewport (98ms at 1279px); 1024px is same-stage. Accepted on an internal showcase route where the whole page shifts 240px in the same window — but check it before keying a **new** surface on the container.

Pinning the `md`+ columns instead of staging them is the tempting alternative and it is wrong: it was measured during #1774 and grew desktop rows 85px → 133px. Prefer moving low-priority content rather than dropping it (this table keeps the date under the Amount until the `xl` stage, the same place the narrow layout puts it).

**`TransactionsTable.tsx` still reveals everything at the single `md` stage, and must not be restructured to match the showcase's two.** It is also a seven-column table and it escapes measure starvation a different way, by **truncating its title to one line instead of wrapping it**. Re-measured under the container keying: one line at every width, 89.6px at 768px *and* at 1024px (ellipsised, with the full string on the `title` attribute), 225.1px at 1280px — so the defect above simply does not arise there. The staging rule is about tables whose flexible cell *wraps*. Restructuring `TransactionsTable` for consistency with a showcase would be a change against a defect measurement says is absent, which is the trap § *Local hint marker* already warns about. What #1999 did change there is only the *key*: the same columns collapse at the same widths, from the container instead of the viewport.

Note what can and cannot see this class of defect. The visual-regression gate compares every committed baseline — `/design-system` is one route among several since [#2318](https://github.com/d-hinders/Haven-AI/issues/2318), and `scripts/ci/visual-baseline-inventory.mjs` (printed into the job's own summary) is the authority for which captures those are, not this sentence — but every one of those captures is rendered at a width read from `scripts/evidence-viewports.mjs`, which holds exactly two: 1280 and 390. So **every width in the table above other than its two endpoints is invisible to the gate**, whichever route is captured, before and after. Geometry assertions are the guard — see `e2e/transaction-title-measure.spec.ts`, which asserts the measure floor and the row-height ceiling *together*, because either alone is satisfiable by a change that destroys the other. And note what a viewport-driven test *cannot* prove here: because container width is a function of viewport width on this shell, every viewport-driven assertion passes identically against the old viewport-keyed implementation. `e2e/table-container-collapse.spec.ts` therefore holds the viewport fixed and resizes the query container itself, in both halves (header labels and body cells) at once.

### Sections (`Section`)

Standard rhythm:
1. Eyebrow — `text-[12px] font-medium tracking-tight text-[var(--v2-brand)]`
2. h2 — see typography
3. Lede — `text-[16px] leading-relaxed text-[var(--v2-ink-2)]`, max‑width ~520px

Sections alternate background:
- Default: white (`--v2-bg`)
- Surface band: `bg-[var(--v2-surface)] border-t border-[var(--v2-border)]`
- Color band: see below

### Hero (light section)

Anatomy on every marketing page:
1. **`HeroBackdrop`** — soft mesh of four blurred radial blobs (indigo, pink, cyan, amber) at ~0.3‑0.5 opacity, plus a fine dotted grid masked to fade out. Set `position: absolute inset-0` inside a `relative overflow-hidden` section. Hero content wrapper must be `relative` so it sits above.
2. **Eyebrow pill** — `border border-[var(--v2-border)] bg-white/80 backdrop-blur`, with a pulsing brand dot.
3. **Headline** — see typography. **One** phrase highlighted with the brand gradient (`bg-clip-text text-transparent`). Period after the gradient is plain ink. Line break with `<br />` for rhythm.
4. **Lede** — short, ≤ 2 sentences.
5. **CTA pair** — primary + ghost.
6. **Optional right column** — flow card (homepage) or omitted (subpages).

### Color band (dark indigo, used sparingly)

Used for **one** mid‑page section per long page (currently the homepage Agent rules band) and the **bottom CTA**. Recipe:

```css
background:
  radial-gradient(ellipse 80% 60% at 20% 0%, rgba(124,58,237,0.55) 0%, transparent 60%),
  radial-gradient(ellipse 70% 70% at 100% 100%, rgba(236,72,153,0.45) 0%, transparent 55%),
  linear-gradient(180deg, #1e1b4b 0%, #2e2a78 100%);
```

Plus a low‑opacity dotted texture masked from the centre. White text, eyebrow in `text-pink-300`, secondary text `text-white/75`. Metric tiles use `bg-white/[0.04]` with `gap-px` on a `bg-white/10` parent for hairline grid lines.

**Bottom CTA band variant** is a brighter brand gradient (`#4f46e5 → #4338ca` with a pink wash) — bolder, used only for the conversion ask.

**Limit:** at most one mid‑page color band + the bottom CTA band per page. Don't bookend or sandwich.

### Code blocks (`CodeBlock`)

Dark code on light page (Stripe pattern). `bg-[var(--v2-surface-code)]` (#0b1120), white/90 text, `font-mono text-[13px] leading-[1.65]`. Optional header with filename + language tag.

### Flow card (`FlowCard`, homepage hero)

Animated, cycling state machine showing one payment lifecycle (Intent → Policy → Settled). CSS‑only animation, no framer‑motion. Soft brand glow behind shifts to green when settled. Includes status pill in footer with brand pulse → success. Pattern is reusable for other "live" demos in the app.

### Step list (`StepList`)

3‑column grid on desktop, hairline `gap-px` on `bg-[var(--v2-border)]` parent (faux dividers via background bleed‑through). Number in brand color, title in ink, body in ink‑2.

---

## 4. Motion

- **No entrance animations on first paint.** Respect `prefers-reduced-motion`.
- **Allowed:** hover transitions (≤200ms), toast enter/exit transitions, the cycling flow card on the homepage hero, the pulsing brand dot in eyebrow pills and "live" indicators, hover lift on cards.
- **Banned:** staggered fade‑ups, page‑level animated blobs, shimmer on text, parallax.

---

## 5. Iconography

- One family: **lucide-react**, rendered through the shared `Icon` wrapper (`components/ui/Icon.tsx`) — never a hand-rolled inline `<svg>`. Exemptions: brand marks in `components/brand` and marketing pages.
- Size: **12 / 14 / 16 / 20 / 24 / 28 px**, square, no arbitrary values — see [Size](#size) below, which is the rule and is gated.
- `stroke-width` 1.5 everywhere, currentColor. Overrides require a call-site comment (see `/design-system` → Icons).
- Decorative by default (`aria-hidden`); pass `label` only when the icon is the sole carrier of meaning.
- No emoji in product UI or marketing.


### Size

**The scale is six values, and they are the six Tailwind steps that express them:**

| px | Class | Where it is used (the built precedent, not a preference) |
|---|---|---|
| 12 | `h-3 w-3` | A glyph in a run of the product's **smallest type** — a disclosure chevron before a `<summary>`, a trailing arrow after a 12 px link label, a copy glyph after a mono address, a sort caret in a table header — including when that glyph is wrapped in its own small button, as long as it sits **inside** the type run rather than beside it. It is **not** the rung for a remove/dismiss control on a data row; that is 14, per [#1923](https://github.com/d-hinders/Haven-AI/issues/1923) below. Mostly `text-xs`, but **not exclusively, and the exception is the point**: `NetworkSwitcher`'s trigger is `text-[13px]`, `Table`'s header is `text-[11px]`, `FilterBar`'s is `text-sm`. Read it as *the dense-affordance rung*, not as a `text-xs` lookup |
| 14 | `h-3.5 w-3.5` | The default beside `text-sm`; the **block-leading indicator** on a banner or callout (`flex items-start` + `mt-0.5` + `flex-shrink-0`) whatever the body type is — it aligns to the first line's cap height, not to the em box; and the glyph in a **remove / dismiss control on a data row**, whether its box is a fixed `h-6 w-6` or padding-only `p-1` ([#1923](https://github.com/d-hinders/Haven-AI/issues/1923), below) |
| 16 | `h-4 w-4` | Beside `text-base`, and the icon in a **32–36 px tile** (`h-8 w-8` / `h-9 w-9`) |
| 20 | `h-5 w-5` | A standalone icon with no container, and `EmptyState`'s icon slot — which is literally `h-5 w-5` inside a 40 px halo, so a call site that passes anything else is fighting the primitive |
| 24 | `h-6 w-6` | The icon inside a **48 px** (`h-12 w-12`) status medallion |
| 28 | `h-7 w-7` | The icon inside a **56 px** (`h-14 w-14`) status medallion |


**The 12 px row cites buttons that do not meet the 44 px tap target, and that is a debt it inherits rather than endorses.** The shared `ui/CopyButton.tsx:63`/`:65` (a bare `h-5 w-5`, and so every `Address`, `McpServerName` and account-detail copy control that renders it) hosts this rung without the invisible `::after` hit area. The legacy hand-rolled controls were removed with the retired Safe agent surfaces; Address, MCP-server and account-detail copy controls route through the shared primitive, while the code-block control remains the documented local 14px exception below. Nothing here changes those boxes. Naming it so the table is not read as blessing sub-44 px targets: an icon-only button owes its own tap-target treatment whatever size glyph it holds.

**A small icon-only button's GEOMETRY does not pick its rung — what the glyph is doing does ([#1923](https://github.com/d-hinders/Haven-AI/issues/1923)).** The legacy Safe budget-row examples that motivated this rule were retired with the Safe agent-management surface in [#2258](https://github.com/d-hinders/Haven-AI/issues/2258). The live delegation budget card uses a labelled `Stop` action rather than an icon-only remove control. The general rule still applies to any future remove or dismiss control: decide its glyph size from its role, then add the live call site to the design-system review and coverage test.

**The decision, scoped to what was actually measured:** a **remove / dismiss control on a data row** takes **14**, whichever way its box is built. The retired budget-row examples are no longer live; remaining copy and dismiss controls retain their own role-based precedents. **The row's own type does not pull it back to 12** — re-derive the choice when adding a new data-row control rather than reviving the removed legacy examples.

**What #1923 did NOT settle, said out loud so the row above is not over-read.** The *copy glyph after a mono address* is split for the same job and stays split: the shared `ui/CopyButton.tsx` primitive (#1878, extracted from `Address`) renders it at **12** in an `h-5 w-5` box, nested in the address run — the precedent the 12 px row cites — while `ui/CodeBlock.tsx` still hand-rolls its own copy control at **14** in an `h-6 w-6` box, beside comparable text. Account-detail copy now uses the shared primitive as well. That is a second which-rung judgement with two live answers; it is recorded here rather than converged, because unlike remove-budget the two are not the same control in the same place, and picking one blind would repeat the coin flip this section is trying to end. What is true after #1923 and checkable is narrower: **no icon-only remove/dismiss control sits at 12**, and every remaining 12 px call site is a chevron, caret, arrow, status dot or copy glyph inside a run of type. Re-derive it — do not trust this sentence past its date — with `node packages/frontend/scripts/design-lint.mjs --icons` and by reading the `h-3 w-3` sites it counts.

**Always square.** lucide's `viewBox` is `0 0 24 24` with the SVG default `preserveAspectRatio`, so a non-square box does not stretch the glyph — it **letterboxes** it and leaves dead space on the long axis. `h-3 w-5` renders a 12 px arrow in a 20 px-wide hole; it looks like a sizing decision and is actually padding in the wrong place.


**One live case the table does not name:** a diagram connector — a standalone arrow joining two boxes, not inline with type and not inside a container. `InfoModal.tsx`'s `Arrow` is the only instance and it is currently dead code (nothing imports it), so it is recorded rather than given a row: one unrendered call site is not enough to found a precedent on. If a connector ships for real, decide the rung here first.

**Never an arbitrary value.** Every rung above is a first-class Tailwind class, so `h-[13px]` is never *needed* to land on the scale — which is what lets "no arbitrary values" be a rule rather than an inconvenience. `size={16}` on the wrapper is equivalent and equally constrained.

**Why six and not the three this section used to claim.** The old rule said 14/16/20 "exactly" and was [verified false](https://github.com/d-hinders/Haven-AI/issues/1858): 34 of 119 sized call sites were off it. Crucially the discrepancy resolved **both ways**, and assuming the code had to bend to the doc would have destroyed real work:

- **12 px was never drift.** Nineteen call sites, and they are not scattered — every one is a chevron, caret, copy glyph or trailing arrow in the app's densest controls, the great majority of them in a `text-xs` run. Three rungs simply had no step for type that small, so authors took a fourth without the doc admitting it existed. **Stated carefully, because the first draft of this line was checkably false**: "every one sits in `text-xs`" is not true — `NetworkSwitcher.tsx:96` sits in `text-[13px]`, `ui/Table.tsx:157` in a `text-[11px]` header, and `transactions/FilterBar.tsx:329` in `text-sm`. The rung is real; the tidy single-class story about it was not, and replacing a false absolute with the measured spread is the whole habit this section is trying to build.
- **24 and 28 were not drift either.** Four sites, two apiece, and each pair is the icon at half its status medallion (48→24, 56→28). `EmptyState` had independently hard-coded the same ratio — a 20 px slot in a 40 px ring, 16 in a 32 — so "half the container" was already built into a primitive before it was ever written down.
- **Eleven sites WERE drift**, and all eight arbitrary values were among them. They were corrected to the nearest rung: 10→12, 11→12, 13→14 (×3), 17→16, 18→20, 22→20, 22→24, and both non-square pairs→12.

The two 18/22 sites are the clearest case in the set: they are the **same slot in the same file** — two `EmptyState` icons in `AgentPanel.tsx` — at two different wrong numbers, one of them overflowing the 20 px slot the primitive provides. Nothing about a product need produced those; the absence of a check did.

**What is enforced, and what is honestly not.** Be precise here, because this section's history is four rounds of rules that forbade nothing:

- **Enforced, mechanically:** *membership*. `design-lint`'s `icon-size` rule fails any `<Icon>` whose size is not one of the six pairs — off-scale, non-square, single-axis, arbitrary-value, or a literal `size={n}` off the scale. Every one of the eleven defects above was a membership violation, so this catches the whole class that actually occurred.
- **NOT enforced, and not enforceable cheaply:** *which rung*. No gate can know that a chevron belongs at 12 rather than 14. That part is the table above — precedents keyed to the container, so a reviewer and an author can at least argue about the same thing. Saying this plainly is the point: the previous two attempts at this section died by pretending a judgement was a rule.
- **The scale itself is closed.** "Half the container" tells you *which* of the six to use; it cannot mint a seventh. A 64 px medallion does not get a 32 px icon — it gets an edit to this table. That is deliberate, and it is the same posture as the one-file arrow allowlist below.

**Why the gate scans elements, not lines.** A `<Icon>`'s `className` routinely sits two or three lines below the tag, and inside a template literal. A line-based `grep` for `<Icon.*h-\[13px\]` returns **zero** on `AgentPanel.tsx:212`, a real instance — which is exactly how an earlier line-regex census reported 110 sized sites against the true 120. `scanElements` walks brace depth to each element's real `>`. The test asserts both halves: that the gate sees the multiline case, *and* that the line-based form does not.

**Re-derive the distribution; do not cite a number from here.**

```sh
npm run design:lint -w packages/frontend            # the gate: 0 icon-size violations
node packages/frontend/scripts/design-lint.mjs --icons   # the census behind it
```

Clean output of the census today is **`UNCLASSIFIED: 0`** and **`OFF-SCALE: 0`**, over **140** call sites (141 until the walk learned that `/design-system`'s own usage EXAMPLE — `{'<Icon icon={Check} className="h-4 w-4" />'}`, a string — is not a call site). `UNCLASSIFIED` is the load-bearing line, not the totals: a non-zero bucket means a call site was silently dropped and every figure beside it is a guess rather than a measurement. That is the whole reason this section states a rule and ships a command instead of pasting counts, the same as [Arrows](#arrows) below.

**What the gate cannot see** — so a clean run is not over-trusted:

- `size={someVariable}`, and classNames assembled wholly at runtime (2 call sites today);
- a size arriving from a `cva`/lookup table in another file, or threaded in as a `className` prop by a wrapper component. A wrapper threading a **numeric** size is no longer in this list — `IconSize` closes it, and `BotIcon` is the worked example — but a wrapper passing a `className` string still is;
- a usage EXAMPLE written as a string with padding inside the quotes (`{'  <Icon … '}`) is still counted. The rejection test is one character of adjacency, deliberately: a whole-file string scanner is what you reach for first and it is wrong here, because bare apostrophes in JSX body text (`its own primitive's home file`) open strings that never close and mask every element after them — that version silently dropped two live call sites. This blind spot fails **loudly**, on the line, and the escape marker clears it;
- marketing surfaces, which are exempt from every rule in this section by the first bullet — correctly, and unlike the [opacity rule](#opacity-on-a-token-colour-1708), that exemption costs nothing here because no icon rule applies there anyway.

### Arrows

- **The marketing exemption in the first bullet covers this whole section, including these arrow rules.** `components/brand`, `components/marketing`, the landing page, `/protocols` and `/how-it-works` are intentionally bespoke and exempt from every icon rule here (#874). The authoritative list is `MARKETING_SURFACES` in `packages/frontend/scripts/design-lint.mjs` — read it there; this sentence is a pointer, not a copy.
- **In a gated surface, an arrow that is an affordance comes from lucide.** A control's trailing arrow (`Button`'s `trailingIcon`, which renders lucide `ArrowRight` for you), a list/row chevron, a disclosure marker, anything that animates (`ErrorBoundary`'s `group-open:rotate-90`, `AgentPanel`'s removed-agents toggle). Never a raw glyph — it cannot be rotated, sized on the icon scale, or stroked at 1.5, and it lands wherever the label's typeface puts it rather than where the icon system does.
- **Exactly one gated file may render a raw arrow:** `components/haven/TransactionMovement.tsx`, the `From <a> → To <b>` movement line. The glyph joins two operands the way a colon would — `aria-hidden`, on the text baseline at the run's own size and weight, with the words `From` and `To` carrying the direction. A lucide glyph would sit at a fixed pixel size beside text it must match, and since #1774 it is nested *inside* the `From` half to stop it wrapping alone, so there is no separable icon slot to fill. **Every other raw arrow in a gated surface is a defect**, whatever it is called.

  **Why a one-file allowlist and not a rule of thumb.** This section has now been wrong three times in the same way, and the shape is worth keeping:

  1. It claimed arrows "come from lucide, not unicode" — false against a component it `covers:` by exact path ([#1840](https://github.com/d-hinders/Haven-AI/issues/1840)).
  2. The first fix sorted arrows into "punctuation" vs. "affordance". Review killed it by demonstration: every author of a new arrow can call theirs punctuation, so it forbade nothing.
  3. The second fix added a closed allowlist with a `grep` — but the grep searched `→` and `&rarr;` only, so it reported clean on files rendering `↗`.

  Each version was better and each hid the same hole one level down. The list above **is** the rule; the reasoning is only why that one file is on it. Adding a second entry is a design-system decision, not a call-site one.

  **Check it over the arrow RANGES, not a list of spellings** — an enumeration only ever catches the glyph that already burned you:

  ```sh
  git ls-files packages/frontend/src/app packages/frontend/src/components \
    | grep -E '\.tsx?$' \
    | grep -v -e 'components/brand/' -e 'components/marketing/' -e 'src/app/page.tsx' \
              -e 'src/app/protocols/' -e 'src/app/how-it-works/' \
    | grep -v -e '__tests__' -e '\.test\.' -e '\.spec\.' \
    | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2190}-\x{21FF}\x{2794}-\x{27BF}\x{27F0}-\x{27FF}\x{2900}-\x{297F}\x{2B00}-\x{2BFF}]|&[a-zA-Z]*arr[a-zA-Z]*;/; close ARGV if eof' \
    | grep -vE ':[0-9]+: *(//|\*|/\*|\{/\*)'
  ```

  The character class covers the Unicode arrow blocks — `→ ← ↑ ↓ ↗ ⇒ ⟶ ➔` and every sibling — and the second alternative covers named entities (`&rarr;`, `&larr;`, `&nearr;`, …).

  **Take each block WHOLE; do not trim it to the codepoints in use.** An earlier draft stopped Miscellaneous Symbols and Arrows at `\x{2B11}`, which covers `⬅ ⬆ ⬇` but not their rightwards mirror `⮕` — Unicode put that one at a disjoint codepoint because no adjacent slot was free. A range trimmed to what exists today reproduces exactly the failure ranges were adopted to fix, and it did so on the *rightwards* arrow, the direction every known defect uses.

  **Why `perl` and not `rg` or a glyph list.** `\x{…}` ranges are explicit and locale-independent, and `perl` is present on macOS and Linux by default. The first draft of this check used `rg`; on the machine that wrote it `rg` was a **shell function**, so pasting the command into a plain shell printed `command not found` — and an empty result reads exactly like a clean one. A check you have not run from a clean shell is not a check.

  **What this check CANNOT see** — state it, so nobody trusts a clean result past its reach:

  - **Numeric character references** — `&#8594;`, `&#x2192;`.
  - **String escapes** — `{'\u2192'}` or a glyph built by concatenation. No source-text search can catch these.
  - **Runtime data** — a glyph arriving from the API, or from i18n values rather than the JSX beside them. (Checked at the time of writing: the `lib/` translation data holds no arrows, but that is a fact about today, not a guarantee.)

  A clean run means "no arrow spelled the obvious ways", never "no arrows".

  **What it returns today: 5 lines, and every one of them is expected** ([#1857](https://github.com/d-hinders/Haven-AI/issues/1857) cleared the debt this table used to hold):

  | Line | Why it is there |
  |---|---|
  | `components/haven/TransactionMovement.tsx:55` | The **one allowlisted raw arrow** — the `From <a> → To <b>` movement glyph described above |
  | `components/haven/TransactionMovement.tsx:38`, `components/connect-agent/SetupStates.tsx:163`, `components/connect-agent/WaitingForConnector.tsx:100` and `:115` | **Continuation lines of multi-line `{/* … */}` JSX comments.** The check strips a comment line by its *opening* delimiter, which a continuation line does not carry, so a line-based search cannot tell them from markup. Four false positives is the price of not parsing JSX, and it is the right price |

  So the check's clean state is **5, not 0**. A run returning more than 5 has found a new defect; a run returning fewer means an expected line moved and the table above is stale.

  **The allowlist stays at one file — it does not go to zero (decided in [#1857](https://github.com/d-hinders/Haven-AI/issues/1857)).** Now that the ten defects are gone, the allowlist is the only thing standing between this rule and a zero-hit rule, so it is worth saying why it stays rather than letting it look like leftover debt. Greppability does not decide it: `expected set` and `empty set` are equally machine-checkable, and the entry is keyed by *file*, not line number, so it does not rot when `TransactionMovement` is edited. What decides it is the rendering. Converting that site would put a stroked 14px lucide glyph **inside a sentence**, at a fixed pixel size on a baseline it does not share with the text either side of it — and since [#1774](https://github.com/d-hinders/Haven-AI/issues/1774) the glyph is nested *inside* the `From` half to stop it wrapping alone, so there is no separable icon slot to put an `<Icon>` in. #1840 judged that a worse rendering; #1857 re-read the site and agrees. Emptying the allowlist would therefore be a **design-system decision that changes what `TransactionMovement` renders**, not a call-site cleanup, and it would have to widen this section explicitly rather than let the list quietly reach zero.

---

## 6. Vocabulary, voice, accessibility

**Authoritative copy source: `docs/product/copy-guidelines.md`.** Read it before writing any user‑facing string — landing page, onboarding, dashboard, error message, anything.

It supersedes the terminology table in `docs/product/README.md` section 1 and the voice rules in section 6. Where the two conflict, **the copy guidelines win.** Specifically:

| Old (product/README.md) | New (copy-guidelines.md) |
|---|---|
| "Account" / "Safe smart account" | **"Haven account"** (and "Haven wallet" for funds) |
| "Signing wallet" | **"Sign‑in method"** in onboarding; "your wallet" elsewhere |
| "Policy" / "Policy engine" / "Spending policy" | **"Agent rules"** or **"Agent budget"** in product surfaces; "spending policies" only in advanced/dev contexts |
| "Generate credentials" / "Hand the credential" | **"Connect your agent"**; "Add your Haven credential to your agent" |
| "Allowance module" / "Session key" | **"Rules"** / **"Haven credential"** |
| "Smart account" / "Smart wallet" | **"Haven account"** / **"Haven wallet"** |
| "Safe deployed" | **"Your Haven account is ready"** |
| "Owner" / "Signer" / "Enroll signer" | **"Approve actions"** / **"Sign‑in method"** / **"Save your sign‑in method"** |
| "Relayer", "Metadata" | **avoid mentioning** |

What survives unchanged from `docs/product/README.md`: the **product doctrine** (section 0), **information architecture** rules (section 2 — collection routes, no dead ends), **accessibility** (section 7), and the **voice principles** that don't conflict (sentences not jargon, no exclamation marks, no emoji in product UI, error copy is the user's friend).

Tonally: marketing copy can be **slightly more inviting** to match the more energetic visual; product UI stays quiet. Confidence over over‑explanation. Lead with the user outcome, not the infrastructure.

**Voice exception flagged in the copy guidelines:** Haven *is* built on Safe and on smart‑account infrastructure. The technical disclosure surfaces (account details, transaction details, advanced settings, developer documentation) can use the technical terms — `Safe`, `passkey-backed signer`, `module`, `relayer`, `transaction hash`. But the default surface is product‑facing.

Accessibility expectations for production primitives:

- Modals use `role="dialog"`, `aria-modal="true"`, labelled titles, Escape handling, focus trap, and focus return. The scroll continuation cue is `aria-hidden="true"` + `pointer-events-none` **on purpose** — a geometric affordance carries nothing a screen reader user needs, and hit-testing must pass through it so a control at the bottom of a scrolled body stays clickable (§ 3 → Modal).
- Toasts use polite or assertive live regions depending on tone.
- Tooltip triggers are keyboard focusable and tap-openable when the trigger is not itself, and not inside, an interactive control (#2038). When it is, the surrounding control carries the keyboard and touch affordance and the tooltip is hover-only — so nothing a non-mouse user needs may live there.
- Loading regions that replace content use `role="status"`, `aria-busy`, and `aria-live`.
- The authenticated shell includes a skip link to `main#main-content`.

### Showcase copies of overlays ([#2002](https://github.com/d-hinders/Haven-AI/issues/2002))

`/design-system` opens almost every overlay from a **real trigger** — `Modal`,
`SidePanel`, `ConfirmDialog`, `InfoModal`, `ComingSoonModal`, `DropdownMenu`,
`Tooltip` and `Toast` — so the thing on the page is the component, with its
mount, focus trap and dismissal intact. That is the default. Exactly one
showcase is held permanently open: `WalletPopover`'s two signing-credential
states, side by side, because the blocking pixel gate captures the page at rest
and a trigger-driven overlay is photographed shut. Reach for a permanently-open
copy only for a state no trigger can put in the capture.

When you do:

- **An ancestor `inert` + `aria-hidden="true"` wrapper is what removes the copy
  from the accessibility tree and the tab order. Changing the copy's own `role`
  does not.** That was measured in real Chromium rather than reasoned from the
  attribute names, and the measurement is recorded ONCE — on `WalletPopover`'s
  `presentational` prop doc-comment in `components/WalletButton.tsx`
  ([#1982](https://github.com/d-hinders/Haven-AI/issues/1982)). Read it there.
  This doc deliberately does not restate it: four synchronised copies of the same
  paragraph is the rot surface #1982 existed to remove, and a rule doc that
  re-derives its own evidence is the next copy to go stale. What belongs here is
  the consequence — a role swap moves raw DOM queries and document-wide role
  counts and nothing else, which is a real job (`e2e/modal-scroll-cue.spec.ts`
  asks document-wide with `document.querySelector('[role="dialog"]')`) but a
  different one. Keep both mechanisms; neither is redundant because the other
  exists, and dropping the wrapper on the strength of the role would expose a
  labelled control group whose handlers do nothing.
- `src/__tests__/showcase-overlay-guard.test.ts` enforces the wrapper on any
  showcase rendered unconditionally with a literal `open`. It is the
  completeness counterpart to `components/__tests__/wallet-popover-presentational-guard.test.ts`'s
  confinement rule — the same split § *Focus rings* records as "three questions,
  not one". Its blind spots are enumerated in its own *What this guard cannot
  see*; read them there before treating a green as a proof.

**A showcase is a rendering of a component's appearance, not a test of its
behaviour** — and that half is the reviewer's, because no check carries it. The
permanently-open copy skips mount and unmount, focus trapping, focus return,
Escape, scroll lock, and everything the real call site's surroundings decide.
Reviewing the showcase is not reviewing the component. Behaviour is proven where
it happens: `components/ui/__tests__/Modal.test.tsx` and `Tooltip.test.tsx` for
the primitives' own contracts, and a **rendered spec at the real call site** for
anything the surroundings decide. Three findings this page could not have
produced:

- a `Tooltip` trigger inside `AgentCard`'s composite `role="link"` cannot be made
  focusable, because the composite owns the tab stop — visible only in context
  ([#2038](https://github.com/d-hinders/Haven-AI/issues/2038); the copy
  consequence, [#2043](https://github.com/d-hinders/Haven-AI/issues/2043), is
  still open);
- the `wrong_wallet` gate state
  ([#2073](https://github.com/d-hinders/Haven-AI/issues/2073)) is illustrated on
  this page by hand-built markup rather than by `OnchainActionGate`, so its
  caption and the component's own string are two independent copies kept in step
  by hand — they match today, and nothing keeps them matching;
- more generally [#1924](https://github.com/d-hinders/Haven-AI/issues/1924)'s
  finding: a showcase re-passes whatever the showcase author writes, so it
  photographs the demo and leaves the product uncovered while looking like
  coverage.

A permanently-held copy also costs something outside the accessibility tree, and
the skeleton showcase is the worked example. Loading states are transient in the
product; on this page they are content, so `/design-system` is permanently
`aria-busy` and is the one route carrying a `BUSY_TOLERANT_CAPTURES` exemption
from the capture guard that otherwise refuses a busy shutter
([#2204](https://github.com/d-hinders/Haven-AI/issues/2204),
`scripts/full-page-capture.mjs`). That exemption is per-route, carries a written
reason, and **self-expires fatally** — the day the showcase stops rendering a
skeleton, the run fails rather than the claim rotting. Hold a state open here and
expect to pay for it somewhere a guard can see.

### Focus rings

There is **one** focus-ring treatment ([#1746](https://github.com/d-hinders/Haven-AI/issues/1746)):

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-<tone>/80
```

Three parts, each decided rather than inherited:

- **`focus-visible:`, never `focus:`.** Form fields used to fire on mouse click
  as well. Switching them costs nothing, and that was **measured in a real
  browser rather than reasoned from the selector name**: in Chromium a
  mouse-clicked `<input>`, `<textarea>` *and* `<select>` all match
  `:focus-visible` and keep their ring, because the heuristic covers any control
  that accepts keyboard input once focused — not only text entry. A
  mouse-clicked `<button>`, measured the same way on the same page, does **not**
  match and shows no ring, which is both the desired behaviour and the control
  that proves the others were not a stuck keyboard modality. The heuristic is
  UA-defined, so a browser that declined to match on a clicked select would only
  drop a ring on mouse click — never a keyboard regression.
- **`ring-2`, and `/80` opacity.** `/80` is the lowest 10%-step alpha at which
  every ring/background pair in the product clears WCAG's **3:1** non-text
  contrast bar ([1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast),
  [2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)). The
  binding pair is `ring-success` on `--v2-success-soft`: 2.99:1 at `/70`, 3.58:1
  at `/80`. The old values were far under — `ring-brand/30` is **1.60:1** on
  white and the form family's `/20` was **1.36:1**
  ([#1741](https://github.com/d-hinders/Haven-AI/issues/1741)).
- **Tone follows the surface, not the brand.** On a light surface the ring is
  `brand` (or `danger` on a destructive control). **On a dark fill it is
  `white`** — brand indigo reaches only 2.99:1 on `--v2-surface-code` and 2.58:1
  on `--v2-ink` at *full* opacity, so no alpha can rescue it. That is why
  `CodeBlock`'s copy button and the shell's skip-link pill use `ring-white/80`.

**Offset is contextual, its size is not.** Use `focus-visible:ring-offset-2
focus-visible:ring-offset-[var(--v2-bg)]` whenever the ring would otherwise abut
the control's *own* fill — on a brand-filled button an un-offset brand ring
composites brand-over-brand and measures ~1.0:1, i.e. invisible at any opacity.
Full-bleed rows use `ring-inset` instead, because an outset ring would be
clipped. Where an offset is used at all it is always `-2`.

The rule bites hardest exactly where the tone rule has just been satisfied, and
that is worth stating because it reads as a paradox. Getting a **solid**
control's ring tone right puts the ring in its fill's own hue, so an un-offset
ring would paint the fill onto itself: `Button variant="danger"` un-offset now
measures **1.00:1**, against 1.08:1 back when it wrongly wore brand. Correcting
the tone made the offset load-bearing rather than merely tidy. What ships is
legible because of the offset — the ring lands on the page at 4.64:1 with a
white moat reading 6.57:1 against the fill. **So never copy a tone fix without
its offset**, and never drop an offset on the grounds that the tones now match.

`Input`, `Select`, `Textarea` and `Checkbox` share this ring, so the "one family"
claim under *Inputs* is now true on focus ring as well as on radius and padding.

`src/__tests__/focus-ring.test.ts` enforces all of the above against the
**compiled** CSS and re-derives every ratio from `globals.css` — a class-string
check cannot see a ring that compiles to nothing, which is how both
`ring-[var(--v2-brand)]/30` (#1708) and `ring-current/30` (#1741) rendered
Tailwind's default blue for months.

**Three questions, not one, and they fail for different reasons.** *What colour*
is the tone rule (#1792); *is there one at all* is the indicator rule, scoped to
destructive controls (#1819); and since
[#1867](https://github.com/d-hinders/Haven-AI/issues/1867), *does a hand-copy of
`Button` declare one at all* — the completeness rule. The third exists because
the first two are structurally blind to it: both only scan class strings that
ALREADY contain a `focus-visible:ring-*`, so a control that omits the whole
treatment contributes nothing to scan and is invisible by construction. Its
population is the census published under § *Button-shaped controls that are not
`Button`*, and it inherits that check's blind spot — a button-shaped control
built from scratch rather than copied is still unguarded, and closing that needs
a classifier by rendered role that nobody has scoped.

`e2e/marketing-cta-focus.spec.ts` is the rendered counterpart for the band CTAs:
real `Tab` traversal (never `.focus()`, which takes focus with no ring at all
after any pointer interaction) and then a read of the live computed
`box-shadow`, asserting a 2px layer that actually paints and that its channels
are white. It carries no baseline on purpose — what needs proving is a boolean,
and the ring renders 4px OUTSIDE the control's own border box, so any
element-scoped capture clips the very thing it photographs (#1873).

---

## 7. Where things live

| Concern | Production location |
|---|---|
| Tokens | CSS vars in `packages/frontend/src/app/globals.css` at `:root`; core aliases in `packages/frontend/tailwind.config.js` |
| Header/Footer | `packages/frontend/src/components/marketing/SiteHeader.tsx`, `SiteFooter.tsx` |
| UI primitives | `packages/frontend/src/components/ui/Button.tsx`, `Card.tsx`, `CodeBlock.tsx`, `InlineAlert.tsx`, `Input.tsx`, `Modal.tsx`, `PageHeader.tsx`, `Skeleton.tsx`, `Toast.tsx`, `Tooltip.tsx` |
| Marketing components | `packages/frontend/src/components/marketing/Section.tsx`, `StepList.tsx`, `HeroBackdrop.tsx`, `FlowCard.tsx`, `ProtocolPlayground.tsx`, `BrandBandButton.tsx` |
| Marketing pages | `packages/frontend/src/app/page.tsx`, `app/how-it-works/page.tsx`, `app/protocols/*/page.tsx` |
| Authenticated shell | `packages/frontend/src/components/sidebar/Sidebar.tsx`, `packages/frontend/src/components/TopBar.tsx`, authenticated routes under `packages/frontend/src/app/(authenticated)` |
| Live product reference | `packages/frontend/src/app/(authenticated)/design-system/page.tsx` |
| App entity cards | `packages/frontend/src/components/ui/entityCardStyles.ts` shared by Accounts and Agents |
| App modals | `packages/frontend/src/components/ui/Modal.tsx` plus Send, Receive, Add funds, and agent modals in `packages/frontend/src/components` |
| Agent & transaction activity rows | `packages/frontend/src/components/haven/TransactionActivityRow.tsx` |
| Transaction previews | `packages/frontend/src/components/haven/TransactionActivityRow.tsx`, `packages/frontend/src/components/haven/TransactionMovement.tsx` |
| Full transaction history | `packages/frontend/src/components/transactions/TransactionsTable.tsx` |

The handoff plan in `docs/archive/redesign-handoff.md` is now project history.

---

## 8. App Migration Mapping

The authenticated app has migrated from the old dark surface system onto the light v2 tokens. Use this mapping when cleaning up old surfaces or reviewing older branches:

| Old dark token/class | Light v2 target | Notes |
|---|---|---|
| `bg-[#0a0a0a]` | `bg-bg` | Main app background |
| `bg-[#111113]`, `bg-[#121216]`, `bg-white/[0.02]` | `bg-white` or `bg-surface` | Use white for cards/panels; use surface for page bands and nested areas |
| `bg-white/[0.04]`, `bg-white/[0.06]` | `bg-surface-2` or `bg-brand-soft` | Use `brand-soft` only for selected/active states |
| `border-white/[0.06]` | `border-border` | Default card, row, and shell dividers |
| `border-white/[0.08]`, `border-white/[0.10]` | `border-border-strong` | Hover/focus or stronger panel boundaries |
| `text-[#ededed]`, `text-zinc-100`, `text-zinc-200`, `text-zinc-300` | `text-ink` | Primary headings and readable body text |
| `text-zinc-400` | `text-ink-2` | Secondary text |
| `text-zinc-500`, `text-zinc-600`, `text-zinc-700` | `text-ink-3` | Tertiary, captions, disabled text |
| `bg-gradient-to-r from-indigo-500 to-violet-600` | `bg-brand` | App buttons use solid brand, not gradients |
| `shadow-black/*` | `shadow-modal` or `shadow-card` | Use token shadows rather than black glow |

Semantic colors keep their meaning: emerald/success, amber/warning, red/danger. Prefer the v2 semantic tokens (`success`, `warning`, `danger`) for new work.

---

## 9. Enforcement

This system is enforced by automated gates (epic [#904](https://github.com/d-hinders/Haven-AI/issues/904)), not just documented. The authoritative process description lives in the [frontend ship-playbook](../contributing/ship-playbooks/frontend.md); in brief:

| Gate | Catches | Posture |
|---|---|---|
| **design-lint** (`npm run design:lint -w packages/frontend`) | Token bypass (raw palette classes, hex colours, micro-fonts), structural bypass (hand-rolled header bands, raw `<table>`/`<svg>`, address slices) **and** off-scale `<Icon>` sizing (#1858 — the only rule scanned per element rather than per line) | Blocking CI; shrink-only baseline |
| **Visual regression** (every `e2e/**/*.visual.spec.ts`, #2318) | Unreviewed pixel drift in any shared primitive, and whole-screen drift on the routes that have a baseline | Blocking CI; Linux baselines. Scope is `frontend.md` §4's table, not this row — the job prints the baselines it compared into its own summary, and a screen absent from that list is not covered |
| **Design-system coupling** (`npm run design:coupling -w packages/frontend`) | A new `ui/`/`haven/` primitive missing from `/design-system` | **Blocking** on every PR (*Design-system coupling (strict)*, #1023); a sticky comment explains the finding |
| **copy-lint** (`npm run lint:copy`) | Banned multi-word technical terms in user-facing copy | Blocking CI; shrink-only baseline |
| **haven-design-reviewer** | Rendered-UX issues (visual weight, spacing rhythm, states, touch targets) reviewed from the screenshot evidence | Review pass; any finding pauses auto-merge, cleared by a clean re-review rather than a human ack (#1968) |

Two rules are enforced by a **compiled-CSS guard** rather than by a line scanner,
because both describe a class that lints clean and emits nothing:
`src/__tests__/focus-ring.test.ts` (a ring utility that compiles to no colour,
#1708/#1818) and `src/__tests__/shadow-token.test.ts` (an elevation utility that
compiles to no `box-shadow`, #1945). Neither is a spelling rule — each boots
real Tailwind over `tailwind.config.js` and reads the OUTPUT — and each carries a
positive control so a "paints nothing" verdict cannot come from a broken reader.


One design rule is also enforced by the **type system**: `Icon`'s `size` prop is typed
`IconSize` (12 | 14 | 16 | 20 | 24 | 28), so `tsc` rejects an off-scale numeric size before
design-lint ever runs — and a wrapper that threads a size through to `<Icon>` closes the
gate's one-level-indirection blind spot by adopting that type (#1858).

Marketing/landing surfaces are exempt from the lint gates (intentionally bespoke); the product app and `/design-system` stay fully gated.

**Escape markers (reviewed exceptions).** One placement rule for the line-scanning gates: put the marker on the offending line **or the line directly above** — `design-lint-disable-line` (design-lint) and `// copy-lint-ignore` (copy-lint) both work either way (shared helper: `scripts/lib/lint-escapes.mjs`). The coupling gate's `// design-system-exempt: <reason>` is different by design — it exempts an *export*, sits as a trailing comment on the export line, and requires the colon + reason. Use escapes sparingly; each one is a standing reviewed exception.
