# Brand intelligence example connectors

Review-site scrapers (Trustpilot, G2, Capterra, Glassdoor), app-store review feeds
(`google_play`, `ios_appstore`), Google Maps business reviews (`gmaps`), and a
generic website scraper. These are **not** bundled with Lobu — they ship as
copy-paste examples because scraping third-party sites may violate their terms of
service. Use at your own risk.

Install into your org from this directory:

```bash
lobu apply
```

Browser scrapers use the paired Chrome extension through the SDK's
`extensionDomScrape` and `extensionNetworkSync` helpers. The standalone
`@lobu/connector-sdk/browser` subpath has been retired.
