/**
 * Known Tezos addresses for CEXs, DEXs, and other services
 * Used for smarter transaction classification
 */

// Centralized Exchanges (CEX) - deposits here are not taxable until sold
export const CEX_ADDRESSES: Record<string, string> = {
  // Kraken
  'tz1KzpjBnunNJVABHBnzfG4iuLmphitExW2u': 'Kraken',
  'tz1hoyMUiJYYr4FRPMU8Z7WJzYkqgjygjaTy': 'Kraken',
  'tz1L8LWvyCBxRuZEBLvhvJrX1jqzj3LWxKkM': 'Kraken',
  
  // Coinbase
  'tz1iQpiBTKtzfbVgogjyhPiGrrV5zAKUKNvy': 'Coinbase',
  'tz1irJKkXS2DBWkU1NnmFQx1c1L7pbGg4yhk': 'Coinbase',
  
  // Binance
  'tz1KfEsrtDaA1sX7vdM4qmEPWuSytuqCDp5j': 'Binance',
  'tz1RCFbB9GpALpsZtu6J58sb74dm8qe6XBzv': 'Binance',
  
  // Gate.io
  'tz1NRGxXV9h6SdNaZLcgmjuLx3hyy2f8YoGN': 'Gate.io',
  
  // Bitfinex
  'tz1ViDy1c2PQqFzCkpXmrvRzDn3UQ1gFxUuB': 'Bitfinex',
  
  // OKX
  'tz1Lhf4J9Qxoe3DZ2nfe8FGDnvVj7oKjnMY6': 'OKX',
  
  // Huobi
  'tz1LBEKXaxQbd5Gtzbc1ATCwc3pppu81aWGc': 'Huobi',
  
  // KuCoin
  'tz1fYzLb3xDu3c5ZFtYGjPCTZVWqQYxrY5xm': 'KuCoin',
};

// Decentralized Exchanges (DEX) - swaps happen here
export const DEX_ADDRESSES: Record<string, string> = {
  // QuipuSwap
  'KT1Qm3urGqkRsWsovGzNb2R81c3dSfxpteHG': 'QuipuSwap Factory',
  'KT1WxgZ1ZSfMgmsSDDcUn8Xn577HwnQ7e1Lb': 'QuipuSwap DEX',
  'KT1X1LgNkQShpF9nRLYw3Dgdy4qp38MX617z': 'QuipuSwap Stable',
  'KT1PnUZCp3u2KzWr93pn4DD7HAJnm3rWVrgn': 'QuipuSwap V2',
  'KT1J8Hr3BP8bpbfmgGpRPoC5jPa1QEaVHwkj': 'QuipuSwap V3',
  
  // Plenty DeFi
  'KT1C9gJRfkqPzGuKuCMA6dHcFNkGxfkodrTz': 'Plenty DEX',
  'KT1XXAavg3tTj12W1ADvd3EEnm1pu6XTmiEF': 'Plenty Stable',
  'KT1D36ZG99YuhoCRZXLL86tQYAbv36bCq9XM': 'Plenty AMM',
  'KT1HaDP8fRW7oWr1aJwcrZuWgC5wRi1AoFmR': 'Plenty Flash',
  
  // SpicySwap
  'KT1PwoZxyv4XkPEGnTqWYvjA1UYiPTgAGyqL': 'SpicySwap Router',
  'KT1CS2xKGHNPTauSh5Re4qE3N9PCfG5u4dPx': 'SpicySwap Factory',
  
  // Vortex
  'KT1LzyPS8rN375tC31WPAVHaQ4HyBvTSLwBu': 'Vortex DEX',
  
  // Youves
  'KT1Xbx9pykNd38zag4yZvnmdSNBknmCETvQV': 'Youves Engine',
  'KT1JeWiS8j1kic4PHx7aTnEr9p4xVtJNzk5b': 'Youves Swap',
  
  // OBJKT (NFT marketplace - not DEX but useful to track)
  'KT1WvzYHCNBvDSdwafTHv7nJ1dWmZ8GCYuuC': 'OBJKT Marketplace v1',
  'KT1Dno3sQZwR5wUCWxzaohwuJwG3gX1VWj1Z': 'OBJKT Marketplace v2',
  'KT1FvqJwEDWb1Gwc55Jd1jjTHRVWbYKUUpyq': 'OBJKT Auction',
  
  // fxhash
  'KT1Xo5B7PNBAeynZPmca8bRxYLkkP3SYUQMp': 'fxhash Marketplace v1',
  'KT1GbyoDi7H1sfXmimXpptZJuCdHMh66WS9u': 'fxhash Marketplace v2',
  
  // Teia (HEN successor)
  'KT1PHubm9HtyQEJ4BBpMTVomq6mhbfNZ9z5w': 'Teia Marketplace',
  
  // Rarible
  'KT18pVpRXKPY2c4U2yFEGSH3ZnhB2kL8kwXS': 'Rarible Exchange',
};

// Known bakers (partial list - will be supplemented by delegation lookup)
export const KNOWN_BAKERS: Record<string, string> = {
  'tz1Kf25fX1VdmYGSEzwFy1wNmkbSEZ2V83sY': 'Tezos Foundation Baker 1',
  'tz1VmiY38m3y95HqQLjMwqnMS7sdMfGomzKi': 'Tezos Foundation Baker 2',
  'tz1iZEKy4LaAjnTmn2RuGDf2iqdAQKnRi8kY': 'Everstake',
  'tz1aRoaRhSpRYvFdyvgWLL6TGyRoGF51wDjM': 'Everstake 2',
  'tz3RDC3Jdn4j15J7bBHZd29EUee9gVB1CxD9': 'Foundation Baker 3',
  'tz1TDSmoZXwVevLTEvKCTHWpomG76oC9S2fJ': 'Tezos Seoul',
  'tz1Ldzz6k1BHdhuKvAtMRX7h5kJSMHESMHLC': 'Baking Bad',
  'tz1S5WxdZR5f9NzsPXhr7L9L1vrEb5spZFur': 'Stake.Fish',
  'tz1NortRftucvAkD1J58L32EhSVrQEWJCEnB': 'Chorus One',
  'tz1Zhv3RkfU2pHrmaiDyxp7kFZpZrUCu1CiF': 'Figment',
  'tz1WCd2jm4uSt4vntk4vSuUWoZQGhLcDuR9q': 'Coinbase Cloud',
  'tz1irJKkXS2DBWkU1NnmFQx1c1L7pbGg4yhk': 'Coinbase Custody',
  'tz1g8vkmcde6sWKaG2NN9WKzCkDM6Rziq194': 'Kraken Baker',
  'tz1WnfXMPaNTBmH7DBPwqCWs9cPDJdkGBTZ8': 'Ledger',
};

// Check if address is a known CEX
export function isCEX(address: string): { isCex: boolean; name?: string } {
  const name = CEX_ADDRESSES[address];
  return { isCex: !!name, name };
}

// Check if address is a known DEX
export function isDEX(address: string): { isDex: boolean; name?: string } {
  const name = DEX_ADDRESSES[address];
  return { isDex: !!name, name };
}

// Check if address is a known baker
export function isKnownBaker(address: string): { isBaker: boolean; name?: string } {
  const name = KNOWN_BAKERS[address];
  return { isBaker: !!name, name };
}

// Check if address is a contract (KT1 prefix)
export function isContract(address: string): boolean {
  return address.startsWith('KT1');
}

// Get address type
export function getAddressType(address: string): {
  type: 'cex' | 'dex' | 'baker' | 'contract' | 'wallet';
  name?: string;
} {
  const cex = isCEX(address);
  if (cex.isCex) return { type: 'cex', name: cex.name };
  
  const dex = isDEX(address);
  if (dex.isDex) return { type: 'dex', name: dex.name };
  
  const baker = isKnownBaker(address);
  if (baker.isBaker) return { type: 'baker', name: baker.name };
  
  if (isContract(address)) return { type: 'contract' };
  
  return { type: 'wallet' };
}
