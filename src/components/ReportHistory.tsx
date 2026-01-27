'use client';

import { useState, useEffect } from 'react';
import { History, Download, Trash2, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { TaxReport, getReports, deleteReport } from '@/lib/db';
import { disposalsToCSV, ledgerToCSV, IRSDisposal, HMRCDisposal, CRADisposal } from '@/lib/tax-calculations';

export default function ReportHistory() {
  const [reports, setReports] = useState<TaxReport[]>([]);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);

  const loadReports = async () => {
    const loaded = await getReports();
    setReports(loaded);
  };

  useEffect(() => {
    loadReports();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this report?')) return;
    await deleteReport(id);
    await loadReports();
  };

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleDownloadDisposals = (report: TaxReport) => {
    const disposals = JSON.parse(report.disposalsJson) as IRSDisposal[] | HMRCDisposal[] | CRADisposal[];
    const csv = disposalsToCSV(disposals, report.jurisdiction);
    downloadCSV(csv, `${report.jurisdiction}_${report.year}_disposals.csv`);
  };

  const handleDownloadLedger = (report: TaxReport) => {
    const ledger = JSON.parse(report.eventsJson);
    const csv = ledgerToCSV(ledger);
    downloadCSV(csv, `${report.jurisdiction}_${report.year}_ledger.csv`);
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (reports.length === 0) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-2 mb-6">
        <History className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Report History</h2>
      </div>

      <div className="space-y-3">
        {reports.map((report) => (
          <div
            key={report.id}
            className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
          >
            {/* Header */}
            <button
              onClick={() => setExpandedReport(expandedReport === report.id ? null : report.id)}
              className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-gray-400 dark:text-gray-500" />
                <div className="text-left">
                  <div className="font-medium text-gray-900 dark:text-white">
                    {report.jurisdiction.toUpperCase()} {report.year}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Generated {formatDate(report.createdAt)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className={`text-sm font-medium ${
                  report.summary.totalGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {report.summary.totalGain >= 0 ? '+' : ''}
                  {formatCurrency(report.summary.totalGain, report.summary.currency)}
                </div>
                {expandedReport === report.id ? (
                  <ChevronUp className="w-5 h-5 text-gray-400 dark:text-gray-500" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-gray-400 dark:text-gray-500" />
                )}
              </div>
            </button>

            {/* Expanded Content */}
            {expandedReport === report.id && (
              <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-800">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Disposals</div>
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">{report.summary.totalDisposals}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Proceeds</div>
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      {formatCurrency(report.summary.totalProceeds, report.summary.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Cost Basis</div>
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      {formatCurrency(report.summary.totalCostBasis, report.summary.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      {report.summary.totalGain >= 0 ? 'Gain' : 'Loss'}
                    </div>
                    <div className={`text-lg font-semibold ${
                      report.summary.totalGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatCurrency(Math.abs(report.summary.totalGain), report.summary.currency)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleDownloadDisposals(report)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-650 transition-colors text-gray-700 dark:text-gray-300"
                  >
                    <Download className="w-4 h-4" />
                    Disposals CSV
                  </button>
                  <button
                    onClick={() => handleDownloadLedger(report)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-650 transition-colors text-gray-700 dark:text-gray-300"
                  >
                    <Download className="w-4 h-4" />
                    Ledger CSV
                  </button>
                  <button
                    onClick={() => handleDelete(report.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition-colors ml-auto"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>

                <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                  Wallets: {report.walletAddresses.map(a => a.slice(0, 8) + '...').join(', ')}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
