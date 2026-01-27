'use client';

import { useState } from 'react';
import { FileText, Download, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { 
  Wallet, 
  TaxReport, 
  getEventsForYear, 
  saveReport 
} from '@/lib/db';
import { 
  calculateIRS, 
  calculateHMRC,
  calculateCRA,
  disposalsToCSV, 
  ledgerToCSV,
  IRSDisposal,
  HMRCDisposal,
  CRADisposal
} from '@/lib/tax-calculations';

interface TaxReportGeneratorProps {
  wallets: Wallet[];
}

export default function TaxReportGenerator({ wallets }: TaxReportGeneratorProps) {
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [jurisdiction, setJurisdiction] = useState<'irs' | 'hmrc' | 'cra'>('irs');
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TaxReport | null>(null);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => currentYear - i);

  const toggleWallet = (address: string) => {
    setSelectedWallets(prev => 
      prev.includes(address) 
        ? prev.filter(a => a !== address)
        : [...prev, address]
    );
  };

  const selectAllWallets = () => {
    if (selectedWallets.length === wallets.length) {
      setSelectedWallets([]);
    } else {
      setSelectedWallets(wallets.map(w => w.address));
    }
  };

  const handleGenerate = async () => {
    if (selectedWallets.length === 0) {
      setError('Please select at least one wallet');
      return;
    }

    // Check if wallets are synced
    const unsyncedWallets = wallets.filter(
      w => selectedWallets.includes(w.address) && !w.lastSyncedAt
    );
    if (unsyncedWallets.length > 0) {
      setError('Please sync all selected wallets first');
      return;
    }

    setError(null);
    setReport(null);
    setIsGenerating(true);
    setProgress({ percent: 0, message: 'Loading events...' });

    try {
      // Get events for the selected year
      const events = await getEventsForYear(selectedWallets, year);
      
      if (events.length === 0) {
        setError(`No transactions found for ${year}`);
        setIsGenerating(false);
        return;
      }

      setProgress({ percent: 10, message: `Found ${events.length} events, calculating...` });

      // Calculate taxes (prices are already stored with events from TzKT)
      const result = jurisdiction === 'irs'
        ? calculateIRS(events, (pct, msg) => setProgress({ percent: 10 + pct * 0.8, message: msg }))
        : jurisdiction === 'hmrc'
          ? calculateHMRC(events, (pct, msg) => setProgress({ percent: 10 + pct * 0.8, message: msg }))
          : calculateCRA(events, (pct, msg) => setProgress({ percent: 10 + pct * 0.8, message: msg }));

      setProgress({ percent: 95, message: 'Saving report...' });

      // Create report
      const newReport: TaxReport = {
        id: `${jurisdiction}-${year}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        year,
        jurisdiction,
        walletAddresses: selectedWallets,
        summary: result.summary,
        eventsJson: JSON.stringify(result.ledger),
        disposalsJson: JSON.stringify(result.disposals),
      };

      // Save to IndexedDB
      await saveReport(newReport);

      setReport(newReport);
      setProgress({ percent: 100, message: 'Complete!' });
    } catch (err) {
      setError(`Failed to generate report: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleDownloadDisposals = () => {
    if (!report) return;
    const disposals = JSON.parse(report.disposalsJson) as IRSDisposal[] | HMRCDisposal[] | CRADisposal[];
    const csv = disposalsToCSV(disposals, report.jurisdiction);
    downloadCSV(csv, `${report.jurisdiction}_${report.year}_disposals.csv`);
  };

  const handleDownloadLedger = () => {
    if (!report) return;
    const ledger = JSON.parse(report.eventsJson);
    const csv = ledgerToCSV(ledger);
    downloadCSV(csv, `${report.jurisdiction}_${report.year}_ledger.csv`);
  };

  const handleDownloadSummary = () => {
    if (!report) return;
    const summary = {
      ...report.summary,
      year: report.year,
      jurisdiction: report.jurisdiction.toUpperCase(),
      wallets: report.walletAddresses,
      generatedAt: report.createdAt,
      disclaimer: 'This is a calculation helper, not tax advice. Consult a tax professional.',
    };
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${report.jurisdiction}_${report.year}_summary.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-2 mb-6">
        <FileText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Generate Tax Report</h2>
      </div>

      <div className="space-y-6">
        {/* Year Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Tax Year</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {/* Jurisdiction Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Tax Jurisdiction</label>
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setJurisdiction('irs')}
              className={`p-4 border-2 rounded-lg transition-colors ${
                jurisdiction === 'irs'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-900 dark:text-gray-100'
              }`}
            >
              <div className="font-medium">IRS (USA)</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">FIFO cost basis</div>
            </button>
            <button
              type="button"
              onClick={() => setJurisdiction('hmrc')}
              className={`p-4 border-2 rounded-lg transition-colors ${
                jurisdiction === 'hmrc'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-900 dark:text-gray-100'
              }`}
            >
              <div className="font-medium">HMRC (UK)</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Section 104 pooling</div>
            </button>
            <button
              type="button"
              onClick={() => setJurisdiction('cra')}
              className={`p-4 border-2 rounded-lg transition-colors ${
                jurisdiction === 'cra'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-900 dark:text-gray-100'
              }`}
            >
              <div className="font-medium">CRA (Canada)</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">ACB, 50% inclusion</div>
            </button>
          </div>
        </div>

        {/* Wallet Selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Wallets to Include</label>
            {wallets.length > 0 && (
              <button
                type="button"
                onClick={selectAllWallets}
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                {selectedWallets.length === wallets.length ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>
          
          {wallets.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center bg-gray-50 dark:bg-gray-800 rounded-lg">
              Add wallets above to generate a report
            </p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {wallets.map((wallet) => (
                <label
                  key={wallet.address}
                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedWallets.includes(wallet.address)
                      ? 'bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800'
                      : 'bg-gray-50 dark:bg-gray-800 border border-transparent hover:bg-gray-100 dark:hover:bg-gray-750'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedWallets.includes(wallet.address)}
                    onChange={() => toggleWallet(wallet.address)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {wallet.alias || wallet.address.slice(0, 12) + '...'}
                    </span>
                    {!wallet.lastSyncedAt && (
                      <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">(not synced)</span>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Progress */}
        {isGenerating && progress && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              {progress.message}
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={isGenerating || wallets.length === 0}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <FileText className="w-5 h-5" />
              Generate Report
            </>
          )}
        </button>

        {/* Report Results */}
        {report && (
          <div className="mt-6 p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
              <span className="font-medium text-green-800 dark:text-green-200">Report Generated</span>
            </div>

            {/* Summary - Capital Gains Section */}
            <div className="mb-3">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2 uppercase tracking-wide">Capital Gains</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Disposals</div>
                  <div className="text-xl font-semibold text-gray-900 dark:text-white">{report.summary.totalDisposals}</div>
                </div>
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Proceeds</div>
                  <div className="text-xl font-semibold text-gray-900 dark:text-white">
                    {formatCurrency(report.summary.totalProceeds, report.summary.currency)}
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {report.jurisdiction === 'cra' ? 'ACB' : 'Cost Basis'}
                  </div>
                  <div className="text-xl font-semibold text-gray-900 dark:text-white">
                    {formatCurrency(report.summary.totalCostBasis, report.summary.currency)}
                  </div>
                </div>
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg">
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {report.summary.totalGain >= 0 ? 'Gain' : 'Loss'}
                  </div>
                  <div className={`text-xl font-semibold ${report.summary.totalGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatCurrency(Math.abs(report.summary.totalGain), report.summary.currency)}
                  </div>
                </div>
              </div>
              {report.jurisdiction === 'cra' && report.summary.taxableGain !== undefined && (
                <div className="mt-2 p-2 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300">
                  Taxable Capital Gain (50% inclusion): {formatCurrency(Math.abs(report.summary.taxableGain), report.summary.currency)}
                </div>
              )}
            </div>

            {/* Summary - Income Section */}
            {report.summary.totalIncome !== undefined && report.summary.totalIncome > 0 && (
              <div className="mb-4">
                <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2 uppercase tracking-wide">
                  {report.jurisdiction === 'irs' ? 'Ordinary Income' : 
                   report.jurisdiction === 'hmrc' ? 'Misc/Trading Income' : 
                   'Business Income'}
                </div>
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg border-2 border-purple-200 dark:border-purple-800">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-xs text-purple-600 dark:text-purple-400 uppercase tracking-wide">
                        {report.jurisdiction === 'irs' ? 'Schedule C / Schedule 1' : 
                         report.jurisdiction === 'hmrc' ? 'Self Assessment' : 
                         '100% Taxable'}
                      </div>
                      <div className="text-xl font-semibold text-purple-700 dark:text-purple-300">
                        {formatCurrency(report.summary.totalIncome, report.summary.currency)}
                      </div>
                    </div>
                    <div className="text-xs text-purple-600 dark:text-purple-400 max-w-xs text-right">
                      {report.jurisdiction === 'irs' ? 'Staking rewards & creator sales - subject to self-employment tax' : 
                       report.jurisdiction === 'hmrc' ? '£1,000 trading allowance may apply' : 
                       'Business income - NOT eligible for 50% capital gains rate'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Exchange Rate Notice for non-USD jurisdictions */}
            {(report.jurisdiction === 'hmrc' || report.jurisdiction === 'cra') && (
              <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="text-xs text-blue-800 dark:text-blue-200">
                  <strong>Exchange Rates:</strong> {report.jurisdiction === 'hmrc' ? 'GBP' : 'CAD'} values are calculated using historical daily exchange rates for each transaction date. 
                  For official filing, you may verify against {report.jurisdiction === 'hmrc' ? 'HMRC/Bank of England rates' : 'Bank of Canada daily rates'}.
                </div>
              </div>
            )}

            {/* Download Buttons */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleDownloadDisposals}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors text-gray-700 dark:text-gray-300"
              >
                <Download className="w-4 h-4" />
                Disposals CSV
              </button>
              <button
                onClick={handleDownloadLedger}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors text-gray-700 dark:text-gray-300"
              >
                <Download className="w-4 h-4" />
                Full Ledger CSV
              </button>
              <button
                onClick={handleDownloadSummary}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors text-gray-700 dark:text-gray-300"
              >
                <Download className="w-4 h-4" />
                Summary JSON
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
              Disclaimer: This is a calculation helper, not tax advice. Consult a tax professional.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
