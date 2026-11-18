# Grantfold

[Website](https://grantfold.xyz) · [Terms](https://grantfold.xyz/terms) · [Privacy](https://grantfold.xyz/privacy) · [Support](https://grantfold.xyz/support)

This is Grantfold's public source repository. The [Grantfold project record on HEY Research Lab](https://heyresearch.xyz/project/grantfold) refers to the same GFLD token on Robinhood Chain (4663): [`0x0e38e046d4b3d091193cce94974b17beba957d9a`](https://robinhoodchain.blockscout.com/token/0x0e38e046d4b3d091193cce94974b17beba957d9a).

Early-access spending controls for agent wallets on Robinhood Chain (chain ID **4663**). Create a spending account, set limits, authorize a separate agent wallet and track USDG purchases with on-chain receipts.

## What works

- Wallet login using a one-use EIP-4361 message and an HttpOnly session.
- Separate agent wallets with encrypted server-held signing keys and owner-signed consent.
- Purchase/day limits, allowed categories, approval thresholds, freeze and pause controls.
- Live **Agent402 crypto market overviews, cloud code execution (Python/JavaScript) and web search**, paid in USDG. ETH covers network gas.
- Free, read-only Robinhood Chain tools: latest block, ETH balance and transaction receipt.
- English/Russian Assistant commands for purchases, balances, fee previews and pausing.
- Daily schedules with separate EIP-712 consent, a total price cap, 1–7 attempts and expiry.
- Saved schedule activity with approval requests, skipped windows, recovery status, verified payment/fee receipts and in-page alerts.
- Recovery of the same saved order after an interrupted payment; unused funds can return only to the linked owner with a separate signature.

Card demo balances are simulated. Gift cards and the seven-day market-data pass remain demos. The Shop’s compute and research entries now buy individual executions/searches, not prepaid allowances or multi-source bundles. RPC tools read the live chain without issuing a credit package. External ChatGPT, Claude and Cursor clients are not connected to this Vercel deployment. The Assistant supports explicit commands.

The operator holds the agent signing key in encrypted form and can use it under consent. This is not an owner-only signing wallet. Login, agent consent and schedule consent are separate permissions.

## Fees and GFLD

The base service fee is **5% of the provider price**, with no fixed minimum. Provider price and ETH gas are separate. Fees use exact micro-USDG amounts, rounded up to the smallest USDG unit.

| GFLD balance | Service fee |
| --- | --- |
| Below 100,000 | 5% |
| At least 100,000 | 4% |
| At least 1,000,000 | 3% |
| At least 10,000,000 | 2% |

Robinhood Chain token: [`0x0e38e046d4b3d091193cce94974b17beba957d9a`](https://robinhoodchain.blockscout.com/token/0x0e38e046d4b3d091193cce94974b17beba957d9a).

Manual purchases use the paying wallet's balance; agent purchases use the linked owner's balance. Each new quote takes an on-chain snapshot. Existing quotes keep their saved rate. No token spending approval or staking is needed. The live configuration is available at [`/api/fees`](https://grantfold.xyz/api/fees); the approved configuration is `config/fee-policy.gfld-v1.json`.

## Local development

Requires **Node.js 24** and npm.

```sh
npm ci
npm test
npm run check
npm run dev
```

Open `http://127.0.0.1:8898`. Development uses its own SQLite database and generates a local wallet master key in ignored `.local/`. Preserve that key with its database. Production data and credentials are not included.

For an isolated preview with simulated payments:

```sh
GRANTFOLD_QA_FIXTURE=1 npm run dev
```

Open `http://127.0.0.1:8898/__fixture/login`. Fixture routes and funds are development-only and are not bundled into production.

## Production setup

The application uses Vercel Node.js functions, static browser assets and Turso/libSQL. Set these variables in your production environment, using `.env.example` as a template. Never commit populated environment files.

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | Production database URL |
| `TURSO_AUTH_TOKEN` | Server-only database credential |
| `GRANTFOLD_WALLET_KEY_V1` | Server-only 64-hex-character wallet encryption key |
| `CRON_SECRET` | Server-only random scheduler credential, at least 32 header-safe characters |
| `GRANTFOLD_SITE_ORIGIN` | Canonical HTTPS origin |
| `GRANTFOLD_VERCEL_ORIGIN` | Optional explicitly allowed Vercel alias |
| `GRANTFOLD_FEE_POLICY` | Fee policy JSON; use `config/fee-policy.gfld-v1.json` for GFLD tiers |

An established wallet master key must be preserved with the database. Replacing or deleting it can make funded wallets inaccessible.

Apply migrations, build and deploy to your linked Vercel project:

```sh
npm run migrate
GRANTFOLD_SITE_ORIGIN=https://your-domain.example npm run build
vercel deploy --prebuilt --prod
```

The migration command reads ignored `.env.local` when needed and applies new SQL files atomically. Set up your own Vercel link and variables first. Hosting metadata in `.vercel/` is not tracked. Commercial use requires a hosting plan that permits it.

The production entry point `api/handler.mjs` forces wallet authentication, checks hosts and strips client-supplied platform identity headers. Worker/MCP compatibility modules remain for regression coverage and are not exposed by the Vercel deployment.

## Live services

In Shop or Assistant, choose **Run code** or **Search web**. Enter the exact task and choose the funded agent wallet or your own wallet. Requesting a quote does not submit a payment. The task is frozen in the saved order and shown again alongside the provider price, GFLD-adjusted fee, total and expiry before confirmation. Recovery reuses that exact task, authorization and order reference.

Code runs are fulfilled by Agent402’s cloud sandbox, with a provider timeout of 30 seconds. Code errors and timeouts may still be charged as executed runs. Output previews are bounded and labelled when truncated. Search returns up to five HTTPS source links and snippets; these are external content, not a synthesized or fact-checked report. Code and queries go to Agent402 for quoting and fulfilment; do not include secrets.

Latest unpaid quotes checked on 18 November 2026: code execution **0.02 USDG**, search **0.01 USDG**, before the Grantfold fee and gas. The actual provider quote is authoritative. Both advertise exact USDG payments on chain 4663 with the existing provider recipient. These new products have been tested with simulated settlements and live unpaid quotes; a real paid execution/search has **not** yet been tested.

**Read chain** uses the official Robinhood Chain RPC. It accepts only latest block, ETH balance or transaction-receipt reads, checks chain 4663, and makes no payment or signing request. It is not a paid RPC credit bundle.

Daily schedules remain limited to the separately signed market-overview product; adding these services does not expand existing recurring consent.

## Daily purchases

In Assistant or Connect AI, select **Configure schedule**. Review the UTC hour, total cap including fees, maximum attempts and expiry, then sign with the linked owner. The first window is in the future; a schedule cannot outlive the agent consent.

The build registers 24 distinct once-daily cron definitions, one per UTC hour. On Vercel Hobby each window can run anywhere within its selected hour; minute-level timing is not promised. The browser can be closed. Cron requests require `CRON_SECRET` and use a separate 300-second function.

Each new run verifies the schedule signature, agent consent, card rules, GFLD fee, price cap, USDG and ETH requirements. Above-threshold orders wait for approval. Missed windows are skipped without catch-up purchases. Unresolved orders block another purchase. Deterministic run references and saved authorizations support recovery of the same order.

Schedule activity is saved on the server even with the browser closed. Open Activity for run outcomes, provider and fee amounts, and transaction links. New events appear as in-page alerts while the app is open; this release does not send push, email or Telegram notifications. Only a completed order with verified settlement is labelled delivered. Existing schedules begin collecting events after this release; older events are not reconstructed.

Pause schedule stops future scheduled purchases. Pause agent also stops its schedule. Renewal, expiry and reached limits require fresh permission. Submitted payments and agreed fees can still finish.

## Validation

**146 automated tests** cover account isolation, login, exact payment amounts and authorization nonces, limits, concurrency, GFLD tiers, schedules, pause races and payment recovery. Tests use isolated databases and simulated providers.

An agent purchase from the production Assistant has been verified on chain. Production scheduling checks covered authenticated empty cron execution and signed activation/pause with an unfunded test wallet. A paid scheduled run has **not** yet been tested. Automated checks are not a claim of an independent security audit.

GitHub Actions runs tests and the production build with no production credentials. It does not deploy the site.

## Source layout

| Path | Contents |
| --- | --- |
| `web/` | Existing UI, public information pages, logos and font |
| `api/handler.mjs` | Vercel HTTP and authentication boundary |
| `server/` | Accounts, wallets, purchases, fees and schedules |
| `shared/` | Money units, wallet requests and typed consent |
| `drizzle/` | SQL migrations |
| `test/fixtures/` | Isolated provider/chain simulators |
| `scripts/` | Development, migration and build helpers |

## Contact and licensing

Project contact: [@Grantfoldrh on X](https://x.com/Grantfoldrh). See [SECURITY.md](SECURITY.md) for sensitive reports.

No open-source license has been selected for application code or branding. Public availability does not grant additional reuse rights. Third-party font terms are in [NOTICE.md](NOTICE.md).
