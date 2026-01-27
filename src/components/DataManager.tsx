'use client';

import { useState, useRef } from 'react';
import { Database, Download, Upload, Trash2, AlertCircle, CheckCircle } from 'lucide-react';
import { exportAllData, importData, clearAllData } from '@/lib/db';

interface DataManagerProps {
  onDataChange?: () => void;
}

export default function DataManager({ onDataChange }: DataManagerProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setMessage(null);

    try {
      const data = await exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `taxmaster-backup-${new Date().toISOString().split('T')[0]}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      
      setMessage({ type: 'success', text: 'Data exported successfully' });
    } catch (err) {
      setMessage({ type: 'error', text: `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}` });
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setMessage(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate structure
      if (!data.wallets && !data.events && !data.reports) {
        throw new Error('Invalid backup file format');
      }

      await importData(data);
      
      setMessage({ 
        type: 'success', 
        text: `Imported ${data.wallets?.length || 0} wallets, ${data.events?.length || 0} events, ${data.reports?.length || 0} reports` 
      });
      
      onDataChange?.();
    } catch (err) {
      setMessage({ type: 'error', text: `Import failed: ${err instanceof Error ? err.message : 'Unknown error'}` });
    } finally {
      setIsImporting(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClearAll = async () => {
    if (!confirm('This will permanently delete all your wallets, synced data, and reports. This cannot be undone. Continue?')) {
      return;
    }

    try {
      await clearAllData();
      setMessage({ type: 'success', text: 'All data cleared' });
      onDataChange?.();
    } catch (err) {
      setMessage({ type: 'error', text: `Clear failed: ${err instanceof Error ? err.message : 'Unknown error'}` });
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-2 mb-6">
        <Database className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Data Management</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        All your data is stored locally in your browser. Use these tools to backup, restore, or clear your data.
      </p>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 mb-4 rounded-lg text-sm ${
          message.type === 'success' 
            ? 'bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300' 
            : 'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
          )}
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Export */}
        <button
          onClick={handleExport}
          disabled={isExporting}
          className="flex items-center justify-center gap-2 px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          <Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {isExporting ? 'Exporting...' : 'Export Backup'}
          </span>
        </button>

        {/* Import */}
        <button
          onClick={handleImportClick}
          disabled={isImporting}
          className="flex items-center justify-center gap-2 px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          <Upload className="w-4 h-4 text-green-600 dark:text-green-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {isImporting ? 'Importing...' : 'Import Backup'}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Clear */}
        <button
          onClick={handleClearAll}
          className="flex items-center justify-center gap-2 px-4 py-3 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
        >
          <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
          <span className="text-sm font-medium text-red-600 dark:text-red-400">Clear All Data</span>
        </button>
      </div>

      <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg">
        <p className="text-xs text-amber-800 dark:text-amber-200">
          <strong>Privacy Note:</strong> Your transaction data and tax reports are stored only in your browser&apos;s local database (IndexedDB). 
          Nothing is sent to any server. If you clear your browser data, this information will be lost unless you export a backup.
        </p>
      </div>
    </div>
  );
}
