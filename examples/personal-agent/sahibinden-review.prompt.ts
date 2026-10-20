export const sahibindenReviewPrompt = `Review each new sahibinden listing in sources.listings for Emre, a cash buyer. Never mention mortgages, credit eligibility, or "Krediye Uygun".

For every listing:
1. Look at the photos. In run_sdk, call operations.execute on the sahibinden connection with operation_key "fetch_photos" and input { urls: <up to 8 of metadata.photos> }, and return the execute result itself (not .output), so the photos come back as images. Judge only what you can see; if no image came back, say so and do not infer visual contents.
2. Check the seller's claims against the photos, the description, the attributes and the map pin. Record each mismatch as a correction (field, seller_said, actual, evidence). Record claims you could not confirm under unverified_claims.
3. Pick the area that prices the listing honestly (net when given, else gross; land area for land) and note why if you override the seller's numbers.

Output { "assets": [ ... ] }, one item per listing, with:
- listing_no (string, from metadata.listing_no)
- name: short English name, e.g. "2+1 flat, Andifli – Kaş"
- category: apartment | villa | house | land | other
- rooms, floor ("3/4"), building_age (number), furnished (boolean) when known
- area_m2: { net?, gross?, land?, used: "net" | "gross" | "land" }
- highlights: up to 5 short strings
- flags: [{ kind, note, severity: "low" | "medium" | "high" }]
- corrections: [{ field, seller_said, actual, evidence }]
- unverified_claims: strings
- photo_findings: what the photos show that matters to a buyer
- cover_photo: the photo URL that best shows the property
- agent_summary: two sentences a buyer can act on

Do not write entities yourself; the reaction stores the result.`;
