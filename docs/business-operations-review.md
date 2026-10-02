# Lazy Laundry — Business, Cost, Legal & Operations Review

**Review date:** 2026-09-24  
**Scope:** `lazy-laundry/` as a booking prototype for the user's stated low-volume service to residents of their condo and nearby neighbors in Edumetro/USJ 1. The user is an international student in Malaysia, wants modest side income now, and may scale later after legal checks. No Student Pass details, written permissions, condo/landlord approval, cost quotes, customer records, or operating measurements were supplied. This is a preliminary business/technical screening, **not legal advice**. Official sources below were checked on 2026-09-24; confirm current requirements with the relevant Malaysian authorities and the institution's international-student office before acting.

## Executive summary

A condo-neighborhood micro-pilot does not need a full booking platform, paid hosting, or scale-level fixed-cost model. However, low volume does not itself establish permission for an international student to run a paid service. Assuming the user holds a Malaysian Student Pass, the first gate is written confirmation from the institution and Immigration that this specific self-operated laundry activity is allowed under the user's pass and circumstances. Do not infer permission from the service being small, local, or limited to neighbors.

If that activity is explicitly permitted, a tightly capped, manually managed pilot could be simpler and cheaper than building a backend. The current app is not a safe intake channel: orders stay in each customer's browser, the operator receives nothing, and personal details are stored locally. Before using it for real customers, also define a small service/price policy, basic privacy handling, condo/landlord permissions, and a measured per-order cost. Treat scaling as a separate phase with its own entity, premises, tax, consumer, privacy, and technical checks.

## Appropriate scope for a condo-scale pilot

- Keep the initial service area to the operator's own building and nearby neighbors, and cap weekly orders to actual study, pickup, and processing capacity. The app's 27 nominal weekly slot instances are not a target or a centrally enforced limit.
- If paid activity is authorized, a written manual order log and direct operator confirmation may be enough at first. The current browser-only form is not: it does not notify the operator or provide shared availability.
- Measure actual kg/pieces, labor minutes, consumables, pickup/delivery time, rewash/damage, no-shows, and repeat use for each pilot order. Use those figures to refine bundle rules and prices.
- Check the condo management/JMB/MC rules and, if renting, the tenancy terms for home-based processing, visitor access, deliveries, water/noise, storage, and use of common areas.
- Keep the public booking app as a demo until the work-permission and privacy questions are answered; do not collect more customer data than the pilot needs.

## Product and revenue model represented in the app

- `app.js:1-4` lists RM34.99 for the 10-piece bundle, RM59.99 for the 18-piece bundle, express add-ons of RM10/RM15, and hanger add-ons of RM3/RM5. The bundle prices are also hardcoded in `index.html:102,116`, so displayed and calculated prices can drift.
- Folding, ironing, pickup, and delivery are shown as included at no extra charge (`app.js:156-165`). That makes two transport legs and handling part of the price whether or not the current economics support them.
- The package counts use item rules for socks and undergarments (`index.html:97-100`) but do not set a weight cap. Piece count alone may not control the processing cost or workload.
- A first-five-washes promotion is hinted at but has no price, eligibility, expiry, or enforcement mechanics (`index.html:121`).
- Standard and express service copy states a turnaround (`index.html:142`; estimate calculation in `app.js:354-375`). Actual wash-facility availability, operating hours, and exception handling are not represented.

## Unit economics: inputs needed before deciding prices

No supplier costs or operating figures were provided, so this review does not estimate margin or assert that either bundle price works. For a condo pilot, first measure variable cost and the operator's time per completed order; a full break-even model is mainly useful once fixed overhead is introduced. Build the worksheet from actual quotes and permitted pilot data:

```text
Contribution per completed order
  = collected price
  − laundry processing cost (machine/laundromat, water, power, detergent)
  − labor (intake, sorting, washing, ironing, packing, customer service)
  − pickup and delivery cost (normally two route legs)
  − packaging and hanger costs
  − payment fees / QR merchant costs
  − promotion discount and expected refunds/claims
  − any applicable indirect taxes

Scale-stage break-even orders per day
  = daily fixed operating costs ÷ weighted-average contribution per order
```

For the pilot, track cost per load or kg; average/maximum kg per package; travel and waiting time; labor minutes; utilities, detergent, hanger, and packaging costs; payment fees; rewash/refund/damage rates; and any promotion discount. Include equipment wear, licensing, insurance, or premises costs only where they actually apply. Use real operating data before setting a minimum order or changing prices. If contribution is zero or negative, more bookings do not fix the pricing problem.

**Specific economic decisions:**

1. Test whether “free” pickup and delivery can be batched into a workable route or needs a minimum order, route-day schedule, zone fee, or higher package price.
2. Set a maximum weight or other objective capacity measure alongside piece-count rules; define how socks, undergarments, bedding, stains, delicate items, and oversized items are counted.
3. Decide whether folding and ironing are always included and measure their labor time. Price express based on real capacity and labor rather than an unverified six-hour promise.
4. Define and margin-check the first-five-washes offer before advertising it.
5. Store package/express/hanger prices in one source of truth when the UI is next revised.

## Operating feasibility

### Slot supply and dispatch

`app.js:78-82` makes weekday evening slots at 19:00, 20:00, and 21:00 available, plus weekend morning and evening times. The UI therefore presents 27 nominal slot instances per week, far more than a student running a small neighborhood pilot should assume they can personally fulfill. These are not centrally enforced: availability is checked against each customer's own `localStorage` (`app.js:196-232, 494-498`), so separate devices can book the same time.

If a paid pilot is authorized, offer only a small number of pickup windows that fit the user's course schedule and actual processing capacity. A manual log/calendar can be sufficient at this stage if every order is confirmed by the operator. Track offered slots, accepted orders, cancellations/no-shows, kg per order, labor/travel time, missed windows, rewash/damage, and on-time turnaround; expand capacity only from observed results.

### End-to-end service operation

At this intended scale, a dashboard is probably unnecessary; the operator still needs to receive and confirm every order. The current app does not do that: it stores orders only in the customer's browser (`app.js:479-533`). “Track an order” is same-device only and its status stays at “Booking received” (`app.js:459-477, 524`). Cash/QR are displayed, but no payment collection or reconciliation is connected (`index.html:291-319`). If paid activity is authorized, a manual order log and direct confirmation may be enough for a small pilot; do not rely on the current app's confirmation as proof that an order reached the operator.

For any permitted pilot, write a one-page runbook covering:

- booking receipt and operator acknowledgement, with a backup/manual intake path;
- route assignment, pickup window, access/lobby handoff, parking, and failed contact;
- garment intake, piece/weight recording, tags, sorting, wash/iron quality checks, packing, and return;
- capacity and turnaround promises, including nights/weekends and equipment downtime;
- customer corrections, cancellation/no-show, late pickup, rewash, loss/damage claims, refunds, and service recovery;
- cash/QR collection, receipt issuance, daily reconciliation, and who may change order status;
- privacy/security incident handling and customer data deletion requests.

### Turnaround and geography

A 21:00 express pickup can produce a calculated 03:00 ready time (`app.js:354-375`). Confirm a facility and staffing plan can actually wash, iron, quality-check, and package overnight before advertising this. The app hardcodes Edumetro blocks and USJ 1 (`index.html:241-253`; `app.js:512`), but has no access instructions, pickup confirmation channel, or address correction flow. Validate this service area and address format with a real pilot.

## Web operating cost and speed

The front end is three static files, has no third-party libraries or network requests, and uses no downloaded images or fonts. This is a good low-cost, low-latency starting point. The audit did not run Lighthouse or measure a deployed page, so no Core Web Vitals or hosting bill is claimed. There is no `package.json`, build pipeline, or hosting/deployment manifest in `lazy-laundry/`; static hosting is straightforward, but provider pricing and URL/deployment setup remain choices.

At this scale, optimize the laundry route, processing labor, capacity, and rework costs before spending time on tiny JavaScript or CSS optimizations. Once a backend is added, estimate its cost from actual order volume, data-retention needs, notification provider, and support requirements; do not select a database, CMS, messaging API, or payment provider by assumption.

## Malaysia / Selangor legal and regulatory screening

This is a checklist for counsel/authority confirmation, not a determination that every item applies to this exact service. Applicability depends on the Student Pass and institution, legal entity, physical operating model, annual revenue, actual data processing, and how the order interface is classified.

### Student Pass / permission to earn income — verify before any paid pilot

Assuming you hold a Malaysian Student Pass, confirm this before treating the service as permitted side income. EMGS's current FAQ says international students at eligible public/private higher education institutions may work part-time up to 20 hours a week **only during semester breaks or holidays longer than seven days**, at listed workplaces (restaurants, petrol kiosks, mini markets, or hotels), with prior Immigration approval through the institution. Immigration's Student Pass page describes permission at approved locations, requires a job offer and an institution support letter, and makes approval discretionary; it also says some institution categories are not eligible. The public pages differ slightly in how they describe timing and do not clearly address self-employed work.

A student-operated condo laundry service is not among the listed workplaces/roles, and the public guidance does not establish that this kind of self-employment is allowed. I cannot determine from those summaries whether it is permitted under your exact pass. Do not assume that being low-volume, serving neighbors, or taking cash creates an exemption. Before advertising or accepting paid orders, ask your institution's International Student Office and Immigration **in writing** whether this specific service is allowed under your pass, what approval is required, and whether there are limits on location, hours, business registration, or home-based processing. Keep any written approval. If permission is not confirmed, postpone the paid pilot and ask about an approved alternative.

### Personal data protection — pre-launch gate if handling real customer details

The form requests name, WhatsApp number, block/building, and unit (`index.html:215-264`), and the app stores them with order details in browser `localStorage` (`app.js:196-206, 500-530`). Malaysia’s PDPA covers personal data processed in commercial transactions. JPDP states that a written Personal Data Protection Notice under section 7 is mandatory; the Act/guidance requires the notice in Bahasa Malaysia and English and sets out purposes, data categories, disclosures, choices, and access/correction contact information. The current policy text is only a placeholder (`index.html:266-278`).

Before collecting real data, prepare the bilingual notice, determine the lawful processing/consent flow, minimize data stored on devices, define retention and deletion, secure any provider handling data, and document a breach-response process. The Personal Data Protection (Amendment) Act 2024 has staged commencement; JPDP guidance lists DPO triggers including processing over 20,000 data subjects, over 10,000 sensitive-data subjects (including financial data), or regular and systematic monitoring. Confirm the current DPO and breach-notification rules and thresholds for the actual service. Also check with JPDP whether the business belongs to a registrable data-controller class; do not assume that all businesses either must or need not register.

### Electronic consumer transactions — scope requires a current legal check

The Consumer Protection (Electronic Trade Transactions) Regulations 2024 (P.U.(A) 449/2024) are the current KPDN-published instrument, effective 25 December 2024 and replacing the 2012 regulations. The 2024 rules refer to online-marketplace suppliers and list disclosures including supplier identity/contact details, service description, full price including transport/taxes, payment method, terms, and estimated delivery; they also address information language and order correction/acknowledgement.

The 2024 definition is broad, and the exact application to a single-supplier direct booking site should be confirmed with KPDN or Malaysian counsel. If it applies, this English-only prototype is missing the relevant Bahasa Malaysia disclosures, operator identity and contact details, substantive terms, clear delivery/correction flow, and an operator-side order acknowledgement. The rules should not be assessed using the superseded 2012 instrument or a generic e-commerce checklist.

### Business identity, premises, tax, and marketing

- **SSM identity:** For an SSM-registered business, the 2020 amendment to the Registration of Businesses Rules calls for the registered business name and registration number on business websites. Requirements depend on entity form; companies also have separate Companies Act disclosure duties. Confirm the actual entity’s rule and add the approved identity/number to the site before trading (`index.html:12-18, 358-362` currently has only brand copy).
- **MBSJ licensing:** USJ 1 is within the MBSJ area. MBSJ publishes business-licence categories, but the required licence depends on the actual premises and activity. Ask MBSJ whether the washing/ironing facility, storage, home-based operation, and pickup-only model require a licence and which activity category applies before committing to a site.
- **Tax/e-invoicing:** LHDN’s current e-Invoice guidelines are phased by revenue/entity and have been revised over time. Confirm the schedule and exemptions applicable to the business using the current LHDN guideline and an accountant; the prototype’s “Invoice” heading is not a tax invoice or accounting record (`app.js:385-397`).
- **Claims and advertising:** Keep the “approximately 6 hours” service promise and launch-promotion copy (`index.html:121, 142`) accurate and backed by an operating process. Define cancellation, no-show, late delivery, loss/damage, rewash, and refund terms.
- **WhatsApp:** Keep transactional order messages separate from promotions. Obtain and record an appropriate opt-in before sending marketing, and select any messaging provider/API explicitly.

## Phased documents and decisions

### Before any paid condo/neighborhood pilot, if Immigration permits it

1. Written confirmation/approval for this activity under the actual Student Pass, plus any institution conditions.
2. Condo management/JMB/MC and landlord/tenancy check for processing, visitor access, deliveries, and use of common areas.
3. A one-page service/price sheet and customer terms: item/weight limits, excluded items, pickup/return windows, cancellation/no-show, rewash, loss/damage claims, and refund handling.
4. A minimal manual order log, receipt/confirmation, pickup calendar, and operator/customer contact procedure; keep only the data needed and define when it is deleted.
5. The required privacy notice and data-handling steps if the activity processes customer personal data; keep order-service messages distinct from optional marketing.
6. A simple per-order cost/time worksheet populated with real pilot measurements before changing price or increasing slots.

### Before expanding beyond a small manual pilot

1. Confirm the business/entity registration, SSM display, MBSJ premises/activity licensing, LHDN tax/e-invoice timing, and applicable electronic-consumer rules for the actual operating model.
2. Expand terms, privacy/incident procedures, insurance/liability, garment-processing SOP, complaint handling, staffing, and financial reconciliation.
3. Add a server-side booking system only when automated public intake is worthwhile; it must provide operator-visible orders, shared capacity, and protected customer data (see `backend-security-review.md`).

## Decision gates

| Gate | Decision/evidence required | Current assessment |
|---|---|---|
| Student work permission | Written confirmation from the institution/Immigration that this paid self-operated service is permitted under the actual pass | **Unverified; first gate.** Low volume does not establish an exemption. |
| Condo/tenancy permission | Confirm home processing, visitor/delivery access, and building rules | **Unknown:** management/landlord terms were not supplied. |
| Pilot order handling | Every paid order must reach the operator and be explicitly confirmed | **Current app fails:** browser-local only. A manual log may be enough if the activity is authorized. |
| Pilot economics | Positive contribution and acceptable time per order at actual weights/routes | **Unknown:** no cost or measurement data supplied. |
| Pilot capacity | Cap slots to course schedule and processing/delivery ability | **Current app overstates control:** 27 nominal slots/week and no shared lock. |
| Scale-up compliance | Entity, privacy/consumer disclosures, licensing, tax, and premises scope confirmed before expansion | **Future gate:** requirements depend on how and where the service operates. |
| Portfolio/public-site boundary | Keep Lazy Laundry as its own branded project; only place it on the Qimmat Al Tamayoz public site after an explicit product/domain decision | **Appropriate as a Liberait project.** The current FS-Caravan `AGENTS.md` describes the Qimmat site, not Liberait’s whole project portfolio. |

## Primary sources checked

- Malaysian Immigration Department, *Student Pass* / work-permission conditions: <https://www.imi.gov.my/index.php/en/main-services/pass/student-pass/>; Education Malaysia Global Services, *FAQ — Can I work while studying?*: <https://educationmalaysia.gov.my/Get-In-Touch/FAQ>; EMGS Hub, *Part-time job while studying?*: <https://hub.emgs.com.my/part-time-job-while-studying/>. Accessed 2026-09-24. These public summaries do not resolve whether this specific self-operated condo service is authorized; obtain an answer for the actual pass in writing.
- KPDN, *Consumer Protection (Electronic Trade Transaction) Regulations 2024* (P.U.(A) 449/2024), official repository: <https://repositori.kpdn.gov.my/bitstream/123456789/5299/1/PERATURAN%20URUSNIAGA%20PERDAGANGAN%20DALAM%20ELEKTRONIK%202024.pdf>. KPDN repository entry: <https://repositori.kpdn.gov.my/handle/123456789/5299>.
- SSM, Registration of Businesses (Amendment) Rules 2020, P.U.(A) 140/2020: <https://www.ssm.com.my/Pages/Legal_Framework/Document/pua-20200505-PUA140.pdf>.
- JPDP, *Guidance on the Preparation of Personal Data Protection Notices*: <https://www.pdp.gov.my/ppdpv1/en/akta/guidance-on-the-preparation-of-personal-data-protection-notices/>; official PDPA Act 2010 text: <https://www.pdp.gov.my/ppdpv1/wp-content/uploads/2024/07/UNDANG-UNDANG-MALAYSIA%5FAKTA%5FPERLINDUNGAN%5FDATA%5FPERIBADI%5F2010%5F709%5FMALAY%5FAND-ENG%5FV2022.pdf>.
- JPDP, PDPA Amendment Act 2024 commencement determination: <https://www.pdp.gov.my/ppdpv1/wp-content/uploads/2024/12/PENETAPAN-TARIKH-PERMULAAN-KUAT-KUASA.pdf>; DPO guidance and FAQ: <https://www.pdp.gov.my/ppdpv1/en/akta/circular-of-personal-data-protection-commissioner-no-2-2025-appointment-of-data-protection-officer/> and <https://www.pdp.gov.my/ppdpv1/en/faq/>; data-controller registration overview: <https://www.pdp.gov.my/ppdpv1/en/registration-of-data-controller/>.
- MBSJ, business licensing information and FAQ: <https://www.mbsj.gov.my/ms/info-lesen-perniagaan> and <https://www.mbsj.gov.my/ms/faq-jabatan-pelesenan>.
- LHDN, current e-Invoice guideline (published 30 August 2026 per the official search result): <https://www.hasil.gov.my/wp-content/uploads/Garis-Panduan-e-Invois-LHDNM.pdf>.
