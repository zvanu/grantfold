import { liveMarket } from '../../shared/payment.mjs';

// Loopback QA only. This module has no fetch and is never bundled for hosting.
export class FixtureMarketProvider {
  constructor() { this.results = new Map(); this.lostFirstResponse = false; }
  async quote() {
    return { amountMicros: 15000, resource: { url: liveMarket.url, mimeType: 'application/json', description: liveMarket.name }, accepted: { scheme: 'exact', network: liveMarket.network, asset: liveMarket.asset, payTo: liveMarket.payTo, amount: '15000', maxTimeoutSeconds: 300, extra: { name: 'Global Dollar', version: '1' } } };
  }
  async purchase(order, payload) {
    const previous = this.results.get(order.id);
    if (previous && previous.signature !== payload.payload.signature) throw Error('Fixture received a different payment');
    const capture = previous?.capture || { report: { currency: 'usd', count: 2, coins: [{ name: 'Bitcoin', symbol: 'btc', price: 65000, change24hPct: 1.5, marketCap: 1e12 }, { name: 'Ethereum', symbol: 'eth', price: 3500, change24hPct: -0.5, marketCap: 4e11 }], credit: 'Local QA fixture — no live data or payment.' }, settlement: { transaction: '0x' + '11'.repeat(32), payer: order.authorization.from, network: liveMarket.network, success: true } };
    this.results.set(order.id, { signature: payload.payload.signature, capture });
    if (!this.lostFirstResponse) { this.lostFirstResponse = true; throw Error('Fixture simulated lost response'); }
    return capture;
  }
  async verifySettlement(order, capture) { return { transaction: capture.settlement.transaction, blockHash: '0x' + '22'.repeat(32) }; }
  async expiredAuthorization() { return { used: false }; }
}
