# Lazy Laundry — Frontend Review

**Review date:** 2026-09-24  
**Scope:** `index.html` (366 lines), `app.js` (541 lines), `styles.css` (2,263 lines). Static source review; no application source files were changed. No cross-browser, assistive-technology, or automated runtime test was performed.

## Executive summary

The interface is visually cohesive, mobile-first, and lightweight: it uses plain HTML/CSS/JavaScript, has no external assets or runtime dependencies, and provides a complete-looking booking flow. Several interface details are thoughtfully handled, including visible focus outlines, form labels, error alerts, a shared price breakdown, and submit-time checks of the selected slot.

This is still a prototype. The most important frontend defects are keyboard focus loss when the slot list is rebuilt, an invisible but focusable date field, missing focus management between views, storage failures that can interrupt confirmation, and a same-day booking cutoff that allows bookings after a slot starts. The policy text, confirmation recap, tracking status, and several labels also overstate or under-explain what the UI actually does. The separate backend review covers the larger production blockers: bookings remain only in the customer’s browser and never reach the business.

## Findings

### F1 — Slot selection removes keyboard focus — Medium, confirmed

- Selecting a time calls `renderSlots()` (`app.js:261-264`), which clears and rebuilds the grid (`app.js:242-266`). Selecting a calendar date does the same (`app.js:129-134`).
- The focused button is removed from the DOM. Keyboard users can lose their position and have to tab through the form again for each selection.
- **Recommendation:** update the existing buttons in place, or restore focus to the newly selected slot after rendering. Verify keyboard-only date and time selection.

### F2 — Date input is invisible but remains focusable — Medium, confirmed accessibility issue

- `#pickup-date` is a required date input (`index.html:73-74`), visually reduced to a 1px transparent control with pointer events disabled (`styles.css:1136-1143`). It remains a keyboard focus stop and is exposed to assistive technology even though it cannot be operated through its visible control.
- **Recommendation:** use an operable, visible date control, or deliberately remove the hidden input from the tab order and provide an accessible name/status for the calendar. Keep the selected date available to assistive technology.
- `#pickup-slot` is `type="hidden" required` (`index.html:86`); HTML constraint validation ignores `required` on hidden inputs. JavaScript currently checks the slot separately, so the attribute is misleading rather than the only protection.

### F3 — View changes do not move or announce focus — Medium, confirmed accessibility issue

- `showView()` toggles hidden sections and scrolls the page but does not move focus into the new view (`app.js:326-331`). Focus can remain on a now-hidden trigger.
- **Recommendation:** focus the new view heading (or another clear starting point), announce the transition where appropriate, and return focus sensibly when navigating back.

### F4 — Storage errors can stop booking confirmation — Medium, confirmed robustness issue

- `readBookings()` catches invalid JSON but does not check that parsed data is an array (`app.js:196-202`). A valid but wrong-shaped value such as `{}` later fails at `.map()`, `.some()`, `.find()`, or spread operations (`app.js:205, 209, 228-232, 461`).
- `saveBooking()` does not catch `localStorage.setItem()` failures (`app.js:204-206`). Storage being unavailable or full can throw after form submission has been prevented (`app.js:479-487, 530`), leaving the customer without a useful outcome.
- **Recommendation:** for a prototype, validate stored data and show a recoverable error on write failure. For production, remove full booking records from browser storage and use the server-side persistence described in the backend review.

### F5 — Same-day slots can be selected after their start time — Medium, business-rule decision required

- `isSlotClosed()` considers a slot open until 45 minutes after its scheduled start (`app.js:217-226`). A 7 PM slot can therefore remain bookable until 7:45 PM local device time.
- This is a defect if bookings must be made before pickup begins; it may be intentional if there is an agreed grace period.
- **Recommendation:** decide and document a minimum lead time, then calculate it using the authoritative business timezone and clock on the server.

### F6 — Required name and unit accept whitespace-only values — Low, confirmed validation gap

- The name and unit inputs are `required` (`index.html:222, 260`), but values are trimmed only after browser validity checks (`app.js:483-486, 508, 511`). A value containing spaces can pass `required` and become an empty saved string.
- **Recommendation:** validate trimmed values and return a field-specific error before confirmation.

### F7 — A permanently disabled midnight slot is rendered — Low, confirmed

- `getSlotsForDate()` adds `"00:00"` after the 10:00–23:00 range (`app.js:74-76`); this slot is never allowed by `isSlotInCurrentSchedule()` (`app.js:78-82`). It appears as a disabled “Coming soon” time and adds noise to the live region.
- **Recommendation:** remove the slot unless midnight pickup is a real planned option.

### F8 — Enter does not activate order tracking — Low, confirmed

- The booking-number input and tracking button are not inside a form (`index.html:331-337`); lookup is attached only to the button click (`app.js:459-477`). Pressing Enter in the input does not submit the lookup.
- **Recommendation:** use a form with a submit handler and preserve accessible error/result announcements.

### F9 — Tracking timeline never advances — Low in prototype; production expectation mismatch

- Every new booking is assigned `STATUS_STEPS[0]` (`app.js:524`), and the frontend has no workflow for changing the status (`app.js:400-418`). Tracking always shows the first step as active.
- **Recommendation:** remove or label the timeline as a demo until a real operator status workflow exists; production status belongs on the server.

## Accessibility and responsive design

- There is no `<h1>` in the document; the home slogan is a `<div>` (`index.html:23`) while other view titles are `<h2>` elements. Use a single meaningful page-level heading.
- `aria-label` is applied to the slogan `<div>` (`index.html:23`), where it is not a reliable replacement for a semantic heading. The visible text already carries the slogan.
- `aria-live="polite"` is on the entire slot grid (`index.html:84`), which can re-announce many rebuilt buttons on each change. Prefer a small live status announcing only the selected date/time or availability change.
- No `prefers-reduced-motion` handling was found. View animation and smooth scrolling run without checking that preference (`styles.css:121-130`; `app.js:330`).
- Some small text is below comfortable reading sizes: calendar badge (about 6px), slot hint/button labels (about 8px), package inclusions (10px), and footer (9px) (`styles.css:496, 1223, 1340`, footer rules near the end). Test readability at mobile width and browser zoom.
- The two package cards remain side by side at narrow widths (`styles.css:440-442`); at 320–360px their contents may feel cramped. `min-width: 320px` on the page also causes horizontal overflow below 320px (`styles.css:26, 32`).
- Positive accessibility foundations: proper labels wrap most choice controls, errors use `role="alert"` (`index.html:199, 281, 336`), calendar dates use `aria-pressed` (`app.js:123-127`), decorative glyphs are hidden from assistive technology, and focus-visible outlines are styled (`styles.css:48-53`).

## Content and flow clarity

- The checkout checkbox names Terms, Pickup & Delivery Policy, and Privacy Policy as plain text rather than links; the details explicitly say final wording is still pending (`index.html:266-278`). Do not solicit agreement until the actual policies are available.
- Checkout repeats the price but does not show a full recap of package, pickup date/time, and selected extras before confirmation. Unused `.checkout-summary*` styles suggest this may have been planned (`styles.css:1476-1515`).
- The weekend badge says “AM Pickup,” although weekend evening slots are also available (`app.js:121, 78-82`).
- A hint says socks, undergarments, and special items “will be added to the form in the next step,” but no such step exists (`index.html:188`).
- A `"Coming soon"` state, placeholder policies, and permanently static tracking status can make this look more operational than it is. Keep demo state explicit until connected to a real booking system.

## Browser support and performance

- The code is small and has no network dependencies, images, or downloaded fonts. The static front end should load quickly; this is a source-based assessment, not a Lighthouse/Core Web Vitals measurement.
- Compatibility targets are not stated. `Array.prototype.at()` (`app.js:428`), `String.prototype.replaceAll()` (`app.js:189-193, 251`), and CSS `:has()` (`styles.css:527, 565, 612`) require modern browser support. Set a supported browser baseline or provide fallbacks.
- Rebuilding at most about 15 slot elements and constructing `Intl.DateTimeFormat` repeatedly are not meaningful performance concerns at this scale. Optimizing those before correcting the data/backend model would have negligible value.
- Roughly 150 lines of apparent leftover date-picker, textarea, month-label, and checkout-summary CSS were not matched to active markup (`styles.css:1039-1134, 1159-1176, 1476-1515`). Confirm before cleanup; this is maintainability, not a load-time blocker.

## Recommended order of work

1. Do not present confirmation/tracking as real until the backend can persist and deliver bookings; see `backend-security-review.md`.
2. Fix keyboard flow: view focus, slot/date focus preservation, and the inaccessible hidden date field.
3. Define the actual same-day cutoff; remove the impossible midnight slot; trim-and-validate name/unit; make tracking respond to Enter.
4. Add the order recap and replace placeholder policies/stale copy before any public launch.
5. Test the target mobile widths, keyboard navigation, reduced motion, and supported browser matrix; then remove only confirmed dead CSS.

## Strengths to retain

- Cohesive visual identity and a clear, mobile-first booking funnel.
- No external assets or libraries and no meaningful static-load optimization need.
- User-facing text inserted into confirmation and tracking markup is generally escaped via `escapeHtml()` (`app.js:187-194, 385-417`); no remotely exploitable XSS was identified by this source review.
- The selected slot is rechecked for the local prototype at checkout and submit (`app.js:438-498`), and the same price-breakdown builder serves both booking and checkout views (`app.js:307-324`). These checks do not replace server-side enforcement.
