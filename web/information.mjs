import { grantfoldToken, gfldTiersText, tokenLink } from './token.mjs';

const contact = '<a href="https://x.com/Grantfoldrh" target="_blank" rel="noopener noreferrer">@Grantfoldrh on X</a>';
const app = '/#/app';
const date = '18 November 2026';
const mark = '<img src="/assets/grantfold-mark.svg" alt=""><span>Grantfold</span>';
const contract = `<code style="overflow-wrap:anywhere">${grantfoldToken.address}</code>`;
const sections = entries => entries.map(([title, paragraphs]) => `<details open><summary>${title}</summary>${paragraphs.map(p => `<p>${p}</p>`).join('')}</details>`).join('');

export function informationLinks() { return '<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/support">Support</a>'; }
export function informationFooter() { return `<footer class="footer"><a href="/#/" class="brand">${mark}</a><p>Agent wallets on Robinhood Chain.<br>Real USDG balances and receipts.<br>Live services paid separately in USDG. Chain reads are free.</p><nav aria-label="Information" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center"><a href="/#/app">Open the app</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/support">Support</a></nav></footer>`; }

export const informationPages = {
  terms: {
    title: 'Terms of use', description: 'How Grantfold early access, agent permissions, purchases and fees work.',
    entries: [
      ['1. The service and its operator', [
        `Grantfold is an early-access software project. In these terms, “Grantfold”, “we” and “us” refer to the project operator, reachable through ${contact}. These terms govern use of this website and its purchase tools. Read our <a href="/privacy">Privacy notice</a> and <a href="/support">Support guide</a> before funding an agent.`,
        'Grantfold provides spending controls and an interface to third-party digital services. It is not a bank, payment-card issuer, exchange or investment adviser, and is not operated or endorsed by Robinhood. The main agent card displays its real Robinhood Chain USDG wallet balance, less pending reservations. Agent keys are held encrypted by the service as described below. Separately labelled demo shop balances and receipts have no monetary value and cannot be redeemed.'
      ]],
      ['2. Eligibility and wallet access', [
        'You must be at least 18, able to enter an agreement and permitted to use the service where you live. Use only wallets and funds you are authorized to control. You are responsible for checking the website, network, address, amount and message before signing.',
        'A wallet login message opens your account; it does not authorize spending. Keep control of your owner wallet. Grantfold support will never ask for its seed phrase or private key. Do not use the service for fraud, unauthorized access, unlawful purchases or attempts to bypass another account’s rules.'
      ]],
      ['3. Separate agent wallets and consent', [
        'Setting up an agent creates a separate wallet. Grantfold holds its signing key encrypted on the server and can sign purchases under your consent. This is not a wallet for which only you hold the key. Fund only a small budget you intend the agent to use; we do not provide deposit insurance or a guarantee against loss.',
        'Agent consent lasts up to seven days and specifies the owner, site, wallet, spending limits, maximum service fee and gas caps. Purchases use the lower of your signed limits and current card limits. Category, daily usage, pending orders, frozen state and approval thresholds are checked. Above-threshold orders require approval. Purchases need an explicit order request or a separate signed daily schedule. A schedule can request purchases while your browser is closed, within its signed price cap, maximum run count, daily UTC window and expiry. Daily timing may vary within the selected hour; missed windows are skipped without catch-up purchases. Each run checks the current provider price, GFLD fee tier and card rules. Above-threshold orders still wait for approval. Agent renewal or pausing stops the previous schedule; restarting needs fresh schedule consent.',
        'Pause agent or freeze the card to stop new purchases. Already submitted authorizations and related fee settlement can still finish. Return funds requires a separate signature by the linked owner and enough ETH in the agent wallet for gas; funds return only to that owner. Deleting browser data or disconnecting a wallet does not pause an agent or withdraw its balance.'
      ]],
      ['4. Live purchases and delivery', [
        'Supported live services are Agent402 crypto market overviews using CoinGecko data, Python/JavaScript cloud code execution and live web search. The Shop’s code execution and research services buy individual calls, not prepaid compute allowances or multi-source research bundles. Gift cards and the seven-day market-data pass remain demos. Free RPC tools read Robinhood Chain without issuing a credit package. External ChatGPT, Claude and Cursor clients are not connected to this Vercel release. Market data may be delayed or inaccurate and is not a trading recommendation.',
        'Live orders use USDG on Robinhood Chain (chain ID 4663); ETH pays network gas. Demo top-ups do not fund an agent. Review each quote and its expiry. Selecting the live purchase confirmation authorizes that order’s displayed provider price and Grantfold fee. Agent purchases use the separate wallet and existing consent; manual purchases require the payment wallet’s authorization.',
        'The provider processes delivery under its <a href="https://agent402.tools/terms" target="_blank" rel="noopener noreferrer">own terms</a>. The result opens after the provider payment and agreed Grantfold fee are verified. Code runs are limited to 30 seconds by the provider; errors and timeouts may still consume the paid execution. Long output is truncated and labelled. Web search returns source links and snippets, not a verified or AI-written research report. An uncertain response is not proof that nothing was paid. Recover the same saved order using Check payment or Check fee; do not buy again to retry delivery.'
      ]],
      ['5. Service fees and GFLD holder tiers', [
        `The base Grantfold service fee is 5% of the provider price, with no fixed minimum. Eligible holder tiers are ${gfldTiersText}. Only this Robinhood Chain contract counts: ${tokenLink()} ${contract}. Holding GFLD is optional; purchases can use the base fee.`,
        'Eligibility is read from the paying wallet for manual purchases or the linked owner wallet for agent purchases. Tokens held only in an agent wallet do not qualify its owner. We take a balance snapshot when preparing the fee quote; moving tokens later does not change that saved quote. No GFLD spending approval, deposit or staking is needed for this balance check. If eligibility cannot be verified, the request stops before a new payment instead of silently charging a different rate.',
        'The quote shows the provider price, fee rate, fee amount and total. The fee is rounded up to the smallest USDG unit (0.000001 USDG). Provider charges and ETH network gas are additional to the service fee. Autonomous purchase gas is capped at 0.00001 ETH per transaction and 0.0001 ETH per UTC day. GFLD ownership does not grant equity, profit sharing, guaranteed token value or guaranteed future features.'
      ]],
      ['6. Failed orders, returns and refund requests', [
        `If you paid but cannot open a report, keep the saved order reference and transaction hashes, check that same order, then contact ${contact}. We review delivery and fee issues against the saved order and verified transfers. A request is not an automatic refund approval; any available refund depends on the issue, applicable law and the provider’s involvement. We do not exclude rights you have under mandatory consumer law.`,
        'Confirmed blockchain transfers cannot simply be cancelled. A refund, when due and feasible, is a separate transaction. Network gas already consumed generally cannot be recovered. Returning unused agent funds is separate from refunding a completed purchase. Sending assets to the wrong address or network may make recovery impossible.'
      ]],
      ['7. Availability, responsibility and changes', [
        'Early access may have bugs, interruptions and capacity limits. We do not promise continuous availability, perfect data, token liquidity or any financial return. To the extent permitted by law, the service is provided as available. Nothing here excludes liability or consumer remedies that cannot lawfully be excluded, including for fraud.',
        'We may restrict new use to address abuse, security incidents or service limits. These terms do not authorize spending beyond your signed consent or confiscation of unused funds. Contact support if a restriction prevents a permitted return.',
        `We publish changes with an updated date. Updated prices and tiers apply to new quotes; already submitted orders retain their saved payment amounts. Material changes to signed spending permissions require fresh consent. Questions or disputes can be raised with ${contact}; mandatory local rights and available complaint procedures remain unaffected.`
      ]],
    ],
  },
  privacy: {
    title: 'Privacy notice', description: 'What Grantfold stores, why it is used, and how to make a privacy request.',
    entries: [
      ['1. Who is responsible', [
        `Grantfold is an early-access project. The project operator is responsible for personal data handled through this service. Contact ${contact} for privacy questions, access requests or deletion requests. This notice covers the Grantfold website; linked providers and wallet applications have their own notices.`
      ]],
      ['2. Data used by the service', [
        'We process owner and agent wallet addresses, chain identifiers, wallet-linked account identifiers, sign-in challenges and session records. Wallet addresses are public on chain but may identify a person when linked to other information.',
        'We store card names, rules, demo balances and purchases, Assistant requests, submitted code and search queries, execution/search results, quotes, approval decisions, consent and payment authorizations, signed daily schedules, run counters and outcomes, reports, transaction references and audit records. GFLD fee checks store the holder address, token balance snapshot, block and applicable fee policy with the quote. Please do not put confidential personal information into card names or Assistant messages.',
        'An agent wallet key is generated by the service and stored encrypted on the server. The server can use it to sign within consent. We do not need the private key or seed phrase of your existing owner wallet. Do not send those secrets to the site or support.',
        'Hosting and infrastructure providers process connection information such as IP addresses, request paths, browser information and technical logs to deliver, protect and troubleshoot the website. Support receives the information you choose to send through X.'
      ]],
      ['3. Purposes and applicable legal grounds', [
        'We use account data to authenticate you, save your settings, enforce rules, execute authorized orders, recover interrupted payments, verify fees, return unused funds and provide support. Where data-protection law requires a legal basis, processing needed to provide the requested service relies on performance of the service agreement; fraud prevention, security and troubleshooting rely on legitimate interests, balanced against your rights. We also retain or disclose records when required by applicable law.',
        'The current Assistant interprets supported purchase and wallet-control commands; it does not send your conversation to a general-purpose language model. We do not install advertising pixels or third-party analytics scripts in this release, and do not sell your account or Assistant data.'
      ]],
      ['4. Cookies and browser storage', [
        'The site uses an essential HttpOnly wallet-session cookie, normally valid for up to seven days, and a short-lived login-challenge cookie, normally five minutes. They support sign-in and prevent replay; they are not advertising cookies. Disconnect wallet removes the current server session.',
        'Local storage remembers the selected card and whether a legacy demo was imported. Session storage holds a pending request reference for safe recovery after an interrupted connection. Earlier browser-only demo data may remain in your browser. These records do not contain the server’s agent private key. Clearing browser storage does not erase server records, pause an agent or reverse an on-chain transfer.'
      ]],
      ['5. Providers, recipients and public-chain data', [
        'Vercel hosts the website and server functions. Turso stores account, payment, session and encrypted agent-wallet records. These providers process data for operation of the service; their infrastructure may process information outside your country.',
        'Agent402 and its payment infrastructure receive the payment authorization, submitted code or search query, and order information needed to quote, charge for and fulfil a requested service. Do not submit secrets in code or queries. Read-only chain queries are sent to the official Robinhood Chain RPC; no token is spent for those reads. Robinhood Chain RPC infrastructure receives queries and transactions needed to check balances, token eligibility and payments. A wallet extension handles the messages and transactions you choose to sign.',
        'Wallet addresses, transfers, amounts and other submitted transaction data are public on Robinhood Chain. Explorers and other parties can read, copy and link them independently of Grantfold. Public blockchain records cannot be deleted by Grantfold. Following an explorer or X support link sends the usual connection information to that destination under its own policies.'
      ]],
      ['6. Retention and safeguards', [
        'Sign-in challenges expire after five minutes and sessions after seven days; expired records are removed during later sign-in activity. Account, order, consent and audit records currently have no fixed automatic deletion timer. We keep them while needed to provide the account, settle and recover orders, handle disputes and meet applicable record-keeping obligations; contact us to request review or deletion.',
        'We use HTTPS, authenticated account access, replay protection and encryption of agent keys. No internet-connected service can guarantee absolute security. Before requesting removal of an agent wallet’s off-chain records, pause it, resolve submitted orders and return any remaining balance. Removing a funded wallet’s signing material could make its funds inaccessible.'
      ]],
      ['7. Your choices and requests', [
        `You can disconnect the current wallet session, pause the agent, freeze a card and use Return funds. For access, correction, export or deletion requests, contact ${contact}. Ask for a private contact route before sharing personal details; do not post your complete account history publicly. We may ask you to prove control of the linked wallet using a clearly described message, but never a seed phrase, private key or a payment.`,
        'Where applicable law grants them, you may also request restriction of processing or portability, object to processing based on legitimate interests, and complain to a competent data-protection authority. Some records must be retained for unresolved payments, legal obligations or claims; public-chain records remain public. Requests are assessed under the applicable legal requirements.',
        'The service is intended for adults aged 18 or older. Contact us if you believe a child has provided account information. Changes to this notice appear here with an updated date.'
      ]],
    ],
  },
  support: {
    title: 'Support', description: 'Recover a payment, manage an agent wallet or contact the Grantfold project.',
    entries: [
      ['Contact Grantfold', [
        `Our support contact is ${contact}. Open the official profile and use a direct message if available. If you need a private route and direct messages are unavailable, ask for one without posting wallet history or other personal information. Early-access support does not have a guaranteed response time.`,
        'For a purchase issue, prepare the saved order reference (live-…), the website address, network, status and provider/fee transaction hashes if available. Describe what happened and when. Share only what is needed. Never send a seed phrase, private key, session cookie, signed payment authorization or screen containing wallet secrets. Support will never ask you to pay an “unlock” fee.'
      ]],
      ['Payment says delivery is unconfirmed', [
        `Do not create another purchase. Open <a href="${app}">the app</a>, select the original card, then Activity or the Assistant’s existing order. Use Check payment, Check fee or the equivalent recovery button for that same reference. A lost response can occur after the payment was already submitted.`,
        'If the provider delivery is saved but the fee is pending, Check fee resumes the existing agreed fee. Leave enough ETH in the agent wallet for gas. Contact support with the same order reference if it remains unresolved. A quote that was never submitted can be cancelled or allowed to expire.'
      ]],
      ['Control your agent in Assistant', [
        'In Assistant, send Check agent balance to read the live USDG and ETH balance, Check my GFLD fee to preview the linked owner’s current fee tier, or Pause agent to stop new autonomous purchases. Russian commands include «Проверь баланс агента», «Какая у меня скидка?» and «Поставь агента на паузу».',
        'Balance and fee checks do not create an order, buy tokens or request a new wallet signature. They show a point-in-time snapshot. Existing saved quotes keep their original fee. Pause does not cancel already submitted payments, return funds or delete receipts.'
      ]],
      ['Live code execution, web search and RPC reads', [
        'In Shop or Assistant, choose Run code or Search web, enter the task, select your own wallet or an enabled and funded agent wallet, then Review live quote. This step does not pay. Check the exact task, USDG price, GFLD fee and expiry before confirming the purchase. The saved task is reused during recovery.',
        'Code runs happen in Agent402’s cloud sandbox. A code error or the 30-second timeout may still consume a paid run. Output previews can be truncated. Search returns up to five external source links and snippets; treat their content as untrusted data. Code and queries are sent to Agent402, so exclude passwords, keys and other secrets.',
        'Read chain is free and read-only on Robinhood Chain (4663): latest block, ETH balance or transaction receipt. It does not issue RPC credits, sign messages or broadcast transactions. No receipt found is not proof that a transfer failed. Existing daily schedules continue to buy market overviews only.'
      ]],
      ['Daily purchases', [
        'In Assistant or Connect AI, choose Configure schedule. Enable an agent on this website first, then review the daily UTC hour, maximum total per attempt and 1–7 allowed purchase attempts. Sign the separate schedule with the linked owner wallet. No purchase runs at setup; the first window is in the future.',
        'The server can run daily purchases with the browser closed. Timing varies within the selected hour. Each run rechecks the provider price, GFLD eligibility, available USDG, ETH gas, consent and card rules. A price above your cap skips that window. An unresolved order prevents another purchase; interruptions recover its same reference.',
        'Schedule activity is saved in your account while the browser is closed. Open Activity to see outcomes, approval requests, skipped windows and saved transaction links. New events appear as in-page alerts while the app is open; there are no push, email or Telegram notifications in this release.',
        'Pause schedule stops future scheduled purchases while leaving manual purchases available under the agent consent. Pause agent also stops its schedule. Submitted payments and their fees may still finish. Unused funds stay in the agent wallet. Expiry, agent renewal or reached run limits require fresh permission; there is no silent extension.'
      ]],
      ['Fund or pause an agent', [
        `Open <a href="/#/app?tab=connect">Connect AI</a> for the selected card. Use the exact displayed agent deposit address. Send USDG for provider prices and fees, and ETH for gas, on Robinhood Chain only (chain ID 4663). Add funds on the main card displays its real agent deposit address. It does not create or credit tokens. Send USDG and ETH from your wallet on Robinhood Chain and use Refresh balance after confirmation. Add demo funds appears only in labelled demo checkout and cannot fund the real wallet.`,
        'Use Pause agent to stop new autonomous purchases; Freeze also blocks new card purchases. Previously submitted orders and fees can still settle. Sign-in and agent spending consent are separate. Consent expires after up to seven days; only renew it after reviewing its wallet and limits.'
      ]],
      ['Real card balances', [
        'Select a card to read its agent wallet balance from Robinhood Chain. Available, Reserved and Spent today are USDG amounts for that agent wallet. Manual purchases paid from your personal wallet and demo purchases do not enter these figures. Confirmed provider prices and fees are counted as they are verified; direct wallet transfers and returns are not purchase spending.',
        'Available subtracts pending unspent purchase authorizations and USDG returns from the on-chain balance. An authorization already used on chain is not deducted twice while delivery is being recovered. All token, ETH and authorization reads use one block snapshot. Values refresh while the app is open and can change after the displayed check time. If a balance cannot be verified, the site shows an unavailable state rather than zero or a demo amount.',
        'Without a wallet, the card shows Wallet not set up. Use Add funds to set up and authorize a wallet, then copy its deposit address. Wallet setup creates no real funds and makes no payment. Paused and frozen wallets remain readable; returning unused funds still requires the linked owner’s separate signature.'
      ]],
      ['Return unused funds', [
        'In Connect AI, choose Return funds. Connect the original linked owner wallet and review the separate return signature. Returns can go only to that owner. Keep enough agent ETH to pay gas, and resolve submitted orders first. Returning USDG and ETH are separate actions. Do not assume disconnecting the website transfers funds back.'
      ]],
      ['GFLD fees and official contract', [
        `Grantfold (GFLD) on Robinhood Chain: ${tokenLink()} ${contract}. Holder tiers: ${gfldTiersText}; the base fee is 5%. Provider price and network gas are separate.`,
        'For an agent purchase, keep qualifying GFLD in the linked owner wallet; for a manual purchase, in the paying wallet. The balance is checked when the fee quote is prepared. A previously saved quote keeps its original rate. No token approval or staking is required. If a balance check is unavailable, retry that unpaid quote later; do not send tokens to support.'
      ]],
      ['Domain, login and product availability', [
        'The main address is grantfold.xyz; grantfold.vercel.app is the temporary Vercel address. Login sessions and spending consents are bound to the site where you sign them. A new hostname can require a new login and consent even for the same wallet. Check the complete hostname before signing.',
        'Real purchases support Agent402 market overviews, cloud code runs and web searches. Gift cards and seven-day data passes remain demos; prepaid RPC/compute credit packages are not issued. External AI-client connections are not active in this release. Terms and Privacy are available without logging in.'
      ]],
    ],
  },
};

export function informationDocument(name) {
  const page = informationPages[name];
  if (!page) throw Error('Unknown information page');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f7f5"><meta name="description" content="${page.description}"><title>${page.title} — Grantfold</title><link rel="icon" type="image/svg+xml" href="/assets/grantfold-favicon.svg"><link rel="preload" as="font" href="/assets/Manrope.woff2" type="font/woff2" crossorigin><link rel="stylesheet" href="/style.css"><style>.information h1{font-size:clamp(35px,4.3vw,58px);line-height:1.12;font-weight:500;letter-spacing:-2px}.information .faq-list{margin-top:0}.information .faq-list p{color:#68775d}.information .faq-list a{text-decoration:underline;text-underline-offset:3px}.information code{font-size:inherit}.information .section-title{margin-bottom:35px}</style></head><body><header class="app-head"><a href="/#/" class="brand" aria-label="Grantfold home">${mark}</a><div class="app-head-right"><span class="network"><i class="network-dot"></i> Robinhood Chain</span><a href="/#/">Back to home</a></div></header><main class="section information"><div class="section-title"><p class="eyebrow">Grantfold · early access</p><h1>${page.title}</h1><p class="section-sub">${page.description}<br>Updated ${date}</p></div><nav aria-label="Information pages" class="faq-list" style="display:flex;flex-wrap:wrap;gap:20px;margin-bottom:25px;font-size:12px">${informationLinks()}</nav><article class="faq-list">${sections(page.entries)}</article></main>${informationFooter()}</body></html>`;
}
