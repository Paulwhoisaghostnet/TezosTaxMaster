# TaxMaster - Tezos Tax Calculator

A free, privacy-first tax calculator for Tezos blockchain. Supports IRS (USA) and HMRC (UK) tax rules.

## Features

- **Privacy First**: All data is stored locally in your browser using IndexedDB. Nothing is sent to any server.
- **IRS Support**: FIFO cost basis matching per Notice 2014-21, Rev. Rul. 2019-24, and Rev. Rul. 2023-14
- **HMRC Support**: Same-day, 30-day, and Section 104 pool matching per CRYPTO22200 series
- **Multiple Wallets**: Track multiple Tezos wallets in one place
- **Transaction Sync**: Fetches transaction history from TzKT API
- **Historical Pricing**: Uses CoinGecko for daily XTZ price data (cached locally)
- **Export Reports**: Download CSV files for disposals and full transaction ledger
- **Backup/Restore**: Export and import your data as JSON

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

```bash
npm run build
npm start
```

## How It Works

1. **Add Wallets**: Enter your Tezos wallet addresses (tz1, tz2, tz3, or KT1)
2. **Sync**: Download your transaction history from the TzKT API
3. **Select Options**: Choose tax year and jurisdiction (IRS or HMRC)
4. **Generate Report**: Calculate capital gains/losses based on the selected tax rules
5. **Download**: Export CSV files for your tax records

## Tax Rules Implemented

### IRS (United States)

Based on:
- [Notice 2014-21](https://www.irs.gov/pub/irs-drop/n-14-21.pdf) - Crypto treated as property
- [Rev. Rul. 2019-24](https://www.irs.gov/pub/irs-drop/rr-19-24.pdf) - Airdrop/hard fork income
- [Rev. Rul. 2023-14](https://www.irs.gov/pub/irs-sbse/rev-ruling-2023-14.pdf) - Staking rewards
- [IRS FAQ](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-virtual-currency-transactions) - FIFO if not specifically identifying

**Method**: First-In-First-Out (FIFO) cost basis matching

### HMRC (United Kingdom)

Based on:
- [CRYPTO22200](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22200) - Pooling guidance
- [CRYPTO22250](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22250) - CGT examples
- [CRYPTO22280](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22280) - Fees in tokens
- [CRYPTO21200/21250](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual) - Staking/Airdrops

**Method**: 
1. Same-day matching (acquisitions on same day as disposal)
2. 30-day rule (acquisitions within 30 days AFTER disposal)
3. Section 104 pool (average cost basis for remaining)

## Data Storage

All data is stored in your browser's IndexedDB:
- **Wallets**: Your tracked wallet addresses
- **Events**: Synced transaction history
- **Price Cache**: Historical XTZ prices (to reduce API calls)
- **Reports**: Generated tax reports

Use the "Export Backup" feature to save your data, especially before clearing browser data.

## APIs Used

- **[TzKT](https://api.tzkt.io/)** - Tezos blockchain data (transactions, token transfers)
- **[CoinGecko](https://www.coingecko.com/)** - Historical XTZ prices

## CLI Script

A standalone Python script is also included for command-line usage:

```bash
cd scripts
python tezos_tax_scan_2025.py tz1YourAddress
```

## Disclaimer

**This is a calculation helper, not tax advice.** Tax laws are complex and vary by jurisdiction and individual circumstances. Always consult a qualified tax professional for your specific situation. The developers are not responsible for any errors, omissions, or tax liabilities.

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
