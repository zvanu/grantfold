import { decodeFunctionData, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, keccak256, toHex } from 'viem';
import { x402ResourceServer } from '@x402/core/server';
import { MarketProvider } from '../../server/market.mjs';
import { liveMarket, paymentTypedData } from '../../shared/payment.mjs';

export const identifierDeclaration = { info: { required: false }, schema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { required: { type: 'boolean' }, id: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' } }, required: ['required'] } };
const protocol = new x402ResourceServer();
const topic = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const used = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const feeAbi = [{ type: 'function', name: 'transferWithAuthorization', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [], stateMutability: 'nonpayable' }];
const tokenAbi = [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }];
export class MockChainProvider extends MarketProvider {
  constructor() {
    super(async (...args) => this.fetchMock(...args));
    this.tokens = new Map(); this.native = new Map(); this.nonces = new Map(); this.authorizations = new Set(); this.receipts = new Map(); this.paid = new Map(); this.rawSeen = new Set(); this.block = 10000n;
    this.providerCalls = 0; this.providerTransfers = 0; this.feeTransfers = 0; this.broadcasts = 0; this.gasPrice = 10_000_000n; this.gasEstimate = 60000n;
    this.failProvider = false; this.loseProviderResponse = false; this.loseBroadcastResponse = false; this.pendingReceipt = false;
  }
  fund(address, tokens = 1_000_000n, native = 10_000_000_000_000_000n) { this.tokens.set(address.toLowerCase(), BigInt(tokens)); this.native.set(address.toLowerCase(), BigInt(native)); }
  balance(address) { return this.tokens.get(address.toLowerCase()) || 0n; }
  eth(address) { return this.native.get(address.toLowerCase()) || 0n; }
  transferTokens(from, to, value) { if (this.balance(from) < value) throw Error('Mock insufficient USDG'); this.tokens.set(from.toLowerCase(), this.balance(from) - value); this.tokens.set(to.toLowerCase(), this.balance(to) + value); }
  logs(a) { return [{ address: liveMarket.asset, topics: [used, topic(a.from), a.nonce], data: '0x' }, { address: liveMarket.asset, topics: [transfer, topic(a.from), topic(a.to)], data: '0x' + BigInt(a.value).toString(16).padStart(64, '0') }]; }
  receipt(hash, logs, from, gasPrice = 0n) {
    this.block++;
    const receipt = { status: '0x1', transactionHash: hash, blockHash: keccak256(toHex(String(this.block))), blockNumber: '0x' + this.block.toString(16), from, gasUsed: '0xea60', effectiveGasPrice: '0x' + gasPrice.toString(16), logs: logs.map(l => ({ ...l, transactionHash: hash, blockNumber: '0x' + this.block.toString(16) })) };
    this.receipts.set(hash, receipt); return receipt;
  }
  async fetchMock(url, init) {
    const toolUrl = new URL(url);
    const service = toolUrl.pathname === '/api/code-run' ? 'compute' : toolUrl.pathname === '/api/search' ? 'research' : null;
    if (url === liveMarket.url || (toolUrl.origin === 'https://agent402.tools' && service)) {
      const amount = service === 'compute' ? '20000' : service === 'research' ? '10000' : '15000';
      const challenge = { x402Version: 2, resource: { url: toolUrl.origin + toolUrl.pathname }, accepts: [{ scheme: 'exact', network: liveMarket.network, amount, asset: liveMarket.asset, payTo: liveMarket.payTo, maxTimeoutSeconds: 300, extra: { name: 'Global Dollar', version: '1' } }], extensions: { 'payment-identifier': identifierDeclaration } };
      if (!init.headers['PAYMENT-SIGNATURE']) return new Response('{}', { status: 402, headers: { 'payment-required': btoa(JSON.stringify(challenge)) } });
      this.providerCalls++;
      if (this.failProvider) throw Error('Mock provider unavailable');
      const wire = JSON.parse(atob(init.headers['PAYMENT-SIGNATURE']));
      const extensionCheck = protocol.validateExtensions(challenge, wire);
      if (!extensionCheck.valid) return new Response(JSON.stringify({ reason: 'unclassified' }), { status: 402, headers: { 'content-type': 'application/json', 'payment-required': btoa(JSON.stringify({ ...challenge, error: extensionCheck.invalidReason })) } });
      if (wire._feeSignature) throw Error('Fee signature leaked to external provider');
      const a = wire.payload.authorization, key = init.headers['Idempotency-Key'];
      this.serviceRequests ??= new Map();
      const fingerprint = JSON.stringify([init.method || 'GET', url, init.body || null]);
      if (this.serviceRequests.has(key) && this.serviceRequests.get(key) !== fingerprint) throw Error('Task changed under a saved payment');
      this.serviceRequests.set(key, fingerprint);
      let capture = this.paid.get(key);
      if (!capture) {
        const signer = await recoverTypedDataAddress({ ...paymentTypedData(a), signature: wire.payload.signature });
        if (signer.toLowerCase() !== a.from.toLowerCase() || a.to.toLowerCase() !== liveMarket.payTo.toLowerCase() || a.value !== amount) throw Error('Mock invalid payment');
        if (this.authorizations.has(a.nonce)) throw Error('Mock reused provider authorization');
        this.transferTokens(a.from, a.to, BigInt(a.value)); this.authorizations.add(a.nonce); this.providerTransfers++;
        const transaction = keccak256(toHex(key)); this.receipt(transaction, this.logs(a), a.from);
        let toolReport;
        if (service === 'compute') toolReport = { language: JSON.parse(init.body).language, stdout: '4\n', stderr: '', result: null, error: null, ...(this.toolReportOverride || {}) };
        if (service === 'research') toolReport = { query: toolUrl.searchParams.get('q'), results: [{title:'Robinhood Chain docs', url:'https://docs.robinhood.com/',description:'Fixture search result.'}], untrustedContent:true, ...(this.toolReportOverride || {}) };
        capture = { report: toolReport || { currency: 'usd', count: 2, coins: [{ name: 'Bitcoin', symbol: 'btc', price: 65000, change24hPct: 1.5, marketCap: 1e12 }, { name: 'Ethereum', symbol: 'eth', price: 3500, change24hPct: -0.5, marketCap: 4e11 }], credit: 'Local fixture data, no network payment.' }, settlement: { success: true, transaction, network: liveMarket.network, payer: a.from } };
        this.paid.set(key, capture);
        if (this.loseProviderResponse) { this.loseProviderResponse = false; throw Error('Mock lost settled response'); }
      }
      return new Response(JSON.stringify(capture.report), { headers: { 'payment-response': btoa(JSON.stringify(capture.settlement)) } });
    }
    if (url !== liveMarket.rpc) throw Error('Tests must never make an external request.');
    const call = JSON.parse(init.body); let result;
    try { result = await this.rpcMock(call.method, call.params); }
    catch (error) { return Response.json({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'Mock RPC refused' } }); }
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  }
  async rpcMock(method, params) {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_blockNumber') return '0x' + this.block.toString(16);
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) };
    if (method === 'eth_gasPrice') return '0x' + this.gasPrice.toString(16);
    if (method === 'eth_estimateGas') { if (this.beforeEstimate) { const callback = this.beforeEstimate; this.beforeEstimate = null; await callback(); } return '0x' + this.gasEstimate.toString(16); }
    if (method === 'eth_getBalance') return '0x' + this.eth(params[0]).toString(16);
    if (method === 'eth_getTransactionCount') return '0x' + (this.nonces.get(params[0].toLowerCase()) || 0).toString(16);
    if (method === 'eth_getTransactionReceipt') return this.pendingReceipt ? null : this.receipts.get(params[0]) || null;
    if (method === 'eth_call') {
      const data = params[0].data;
      if (data === '0x313ce567') return '0x' + '6'.padStart(64, '0');
      if (data.startsWith('0x70a08231')) return '0x' + this.balance('0x' + data.slice(-40)).toString(16).padStart(64, '0');
      return '0x' + (this.authorizations.has('0x' + data.slice(-64)) ? '1' : '0').padStart(64, '0');
    }
    if (method === 'eth_getLogs') {
      const filter = params[0], start = BigInt(filter.fromBlock), end = filter.toBlock === 'latest' ? this.block : BigInt(filter.toBlock);
      return [...this.receipts.values()].flatMap(r => r.logs).filter(l => BigInt(l.blockNumber) >= start && BigInt(l.blockNumber) <= end && filter.topics.every((t, i) => t == null || t.toLowerCase() === l.topics[i]?.toLowerCase()));
    }
    if (method === 'eth_sendRawTransaction') return this.sendRaw(params[0]);
    throw Error('Unexpected mock method: ' + method);
  }
  async sendRaw(raw) {
    const hash = keccak256(raw); if (this.rawSeen.has(hash)) return hash;
    const tx = parseTransaction(raw), from = await recoverTransactionAddress({ serializedTransaction: raw });
    if (tx.chainId !== 4663 || tx.nonce !== (this.nonces.get(from.toLowerCase()) || 0)) throw Error('Mock nonce or chain mismatch');
    const gasCost = 60000n * tx.gasPrice;
    if (this.eth(from) < gasCost + (tx.value || 0n)) throw Error('Mock insufficient ETH');
    const logs = [];
    if (this.revertNext) {
      this.revertNext = false; this.native.set(from.toLowerCase(), this.eth(from) - gasCost); this.nonces.set(from.toLowerCase(), tx.nonce + 1); this.broadcasts++; this.rawSeen.add(hash);
      const receipt = this.receipt(hash, [], from, tx.gasPrice); receipt.status = '0x0'; return hash;
    }
    if (tx.to.toLowerCase() === liveMarket.asset.toLowerCase()) {
      if (tx.data.startsWith('0xe3ee160e')) {
        const { args } = decodeFunctionData({ abi: feeAbi, data: tx.data });
        const a = { from: args[0], to: args[1], value: String(args[2]), validAfter: String(args[3]), validBefore: String(args[4]), nonce: args[5] };
        const signature = args[7] + args[8].slice(2) + Number(args[6]).toString(16).padStart(2, '0');
        const signer = await recoverTypedDataAddress({ ...paymentTypedData(a), signature });
        if (signer.toLowerCase() !== a.from.toLowerCase() || this.authorizations.has(a.nonce)) throw Error('Mock invalid fee authorization');
        this.transferTokens(a.from, a.to, BigInt(a.value)); this.authorizations.add(a.nonce); this.feeTransfers++; logs.push(...this.logs(a));
      } else {
        const { args } = decodeFunctionData({ abi: tokenAbi, data: tx.data }); this.transferTokens(from, args[0], args[1]);
        logs.push({ address: liveMarket.asset, topics: [transfer, topic(from), topic(args[0])], data: '0x' + args[1].toString(16).padStart(64, '0') });
      }
    } else { this.native.set(tx.to.toLowerCase(), this.eth(tx.to) + (tx.value || 0n)); }
    this.native.set(from.toLowerCase(), this.eth(from) - gasCost - (tx.value || 0n)); this.nonces.set(from.toLowerCase(), tx.nonce + 1);
    this.broadcasts++; this.rawSeen.add(hash); this.receipt(hash, logs, from, tx.gasPrice);
    if (this.loseBroadcastResponse) { this.loseBroadcastResponse = false; throw Error('Mock lost broadcast response'); }
    return hash;
  }
}
