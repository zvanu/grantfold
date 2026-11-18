export const grantfoldToken = Object.freeze({
  name: 'Grantfold', symbol: 'GFLD', chainId: 4663, decimals: 18,
  address: '0x0e38e046d4b3d091193cce94974b17beba957d9a',
  explorer: 'https://robinhoodchain.blockscout.com/token/0x0e38e046d4b3d091193cce94974b17beba957d9a',
});
export const gfldFeePolicy = Object.freeze({
  enabled: true, version: 'gfld-holders-v1', chainId: 4663,
  token: grantfoldToken.address, decimals: 18,
  tiers: [
    { minBalance: '100000000000000000000000', feeBps: 400 },
    { minBalance: '1000000000000000000000000', feeBps: 300 },
    { minBalance: '10000000000000000000000000', feeBps: 200 },
  ],
});
export const gfldTiersText = '100,000 GFLD → 4% · 1,000,000 GFLD → 3% · 10,000,000 GFLD → 2%';
export function tokenLink(label = 'GFLD contract') { return `<a href="${grantfoldToken.explorer}" target="_blank" rel="noopener noreferrer">${label}</a>`; }
