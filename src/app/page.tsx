'use client';

import { useState, useCallback } from 'react';
import { Shield, Github, ExternalLink } from 'lucide-react';
import WalletManager from '@/components/WalletManager';
import TaxReportGenerator from '@/components/TaxReportGenerator';
import ReportHistory from '@/components/ReportHistory';
import DataManager from '@/components/DataManager';
import ThemeToggle from '@/components/ThemeToggle';
import { Wallet } from '@/lib/db';

export default function Home() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleWalletsChange = useCallback((newWallets: Wallet[]) => {
    setWallets(newWallets);
  }, []);

  const handleDataChange = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-950 dark:to-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
                <span className="text-white font-bold text-lg">T</span>
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">TaxMaster</h1>
                <p className="text-xs text-gray-500 dark:text-gray-400">Tezos Tax Calculator</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                aria-label="GitHub"
              >
                <Github className="w-5 h-5" />
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-700 dark:from-blue-700 dark:to-blue-800 text-white py-12 sm:py-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Calculate Your Tezos Taxes
            </h2>
            <p className="text-blue-100 text-lg mb-6">
              Free, privacy-first tax calculator for Tezos. Supports IRS (US) and HMRC (UK) rules. 
              All data stays in your browser — nothing is sent to any server.
            </p>
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-full">
                <Shield className="w-4 h-4" />
                <span>100% Local Storage</span>
              </div>
              <a
                href="https://www.irs.gov/pub/irs-drop/n-14-21.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-full hover:bg-white/20 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>IRS Guidance</span>
              </a>
              <a
                href="https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-full hover:bg-white/20 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>HMRC Manual</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left Column */}
          <div className="space-y-6">
            <WalletManager 
              key={`wallets-${refreshKey}`}
              onWalletsChange={handleWalletsChange} 
            />
            <TaxReportGenerator wallets={wallets} />
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            <ReportHistory key={`history-${refreshKey}`} />
            <DataManager onDataChange={handleDataChange} />

            {/* Info Cards */}
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4">How It Works</h3>
              <ol className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-medium">1</span>
                  <span>Add your Tezos wallet address(es)</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-medium">2</span>
                  <span>Sync to download your transaction history from TzKT</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-medium">3</span>
                  <span>Choose tax year and jurisdiction (IRS or HMRC)</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center text-xs font-medium">4</span>
                  <span>Generate report and download CSV files</span>
                </li>
              </ol>
            </div>

            <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-xl p-6">
              <h3 className="font-semibold text-amber-800 dark:text-amber-200 mb-2">Disclaimer</h3>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                This tool is a calculation helper, not tax advice. Tax laws are complex and vary by situation. 
                Always consult a qualified tax professional for your specific circumstances. 
                The developers are not responsible for any errors or omissions.
              </p>
            </div>

            <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-xl p-6">
              <h3 className="font-semibold text-blue-800 dark:text-blue-200 mb-2">Tax Rules Implemented</h3>
              <div className="text-sm text-blue-700 dark:text-blue-300 space-y-2">
                <div>
                  <span className="font-medium">IRS (United States):</span> FIFO cost basis matching per Notice 2014-21, Rev. Rul. 2019-24, and Rev. Rul. 2023-14
                </div>
                <div>
                  <span className="font-medium">HMRC (United Kingdom):</span> Same-day, 30-day, and Section 104 pool matching per CRYPTO22200 series
                </div>
                <div>
                  <span className="font-medium">CRA (Canada):</span> Adjusted Cost Base (ACB) method with 50% capital gains inclusion rate
                </div>
                <div className="pt-2 border-t border-blue-200 dark:border-blue-800 mt-2">
                  <span className="font-medium">Creator Sales:</span> Self-minted tokens sold are classified as <em>ordinary income</em> (not capital gains) per IRS guidance on self-created property
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 py-8 mt-12">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500 dark:text-gray-400">
            <p>
              TaxMaster — Free and open source Tezos tax calculator
            </p>
            <div className="flex items-center gap-4">
              <a
                href="https://api.tzkt.io/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Powered by TzKT
              </a>
              <span>·</span>
              <a
                href="https://www.coingecko.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Prices by CoinGecko
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
