'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wallet, Plus, Trash2, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import { 
  Wallet as WalletType, 
  addWallet, 
  getWallets, 
  deleteWallet, 
  updateWalletSyncTime,
  saveEvents,
  clearEventsForWallet,
  getDB
} from '@/lib/db';
import { isValidTezosAddress, getAccountInfo, fetchAllTransactions, buildEvents } from '@/lib/tzkt';
import { classifyEvents } from '@/lib/classify-events';

interface WalletManagerProps {
  onWalletsChange?: (wallets: WalletType[]) => void;
}

export default function WalletManager({ onWalletsChange }: WalletManagerProps) {
  const [wallets, setWallets] = useState<WalletType[]>([]);
  const [newAddress, setNewAddress] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [syncingWallet, setSyncingWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadWallets = useCallback(async () => {
    const loaded = await getWallets();
    setWallets(loaded);
    onWalletsChange?.(loaded);
  }, [onWalletsChange]);

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

  const handleAddWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const address = newAddress.trim();
    
    if (!address) {
      setError('Please enter a wallet address');
      return;
    }

    if (!isValidTezosAddress(address)) {
      setError('Invalid Tezos address format. Must start with tz1, tz2, tz3, or KT1');
      return;
    }

    if (wallets.some(w => w.address === address)) {
      setError('This wallet is already added');
      return;
    }

    setIsAdding(true);

    try {
      // Verify account exists and get delegation info
      const info = await getAccountInfo(address);
      if (!info) {
        setError('Could not find this address on Tezos mainnet');
        setIsAdding(false);
        return;
      }

      // Add wallet with delegate info
      const db = await getDB();
      const wallet: WalletType = {
        address: address.trim(),
        alias: newAlias.trim() || undefined,
        addedAt: new Date().toISOString(),
        delegate: info.delegate,
        delegateName: info.delegateAlias,
      };
      await db.put('wallets', wallet);
      
      setNewAddress('');
      setNewAlias('');
      setSuccess(info.delegate 
        ? `Wallet added (delegated to ${info.delegateAlias || info.delegate.slice(0, 8) + '...'})` 
        : 'Wallet added successfully');
      await loadWallets();
    } catch (err) {
      setError(`Failed to add wallet: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteWallet = async (address: string) => {
    if (!confirm('Delete this wallet and all its synced data?')) return;
    
    try {
      await deleteWallet(address);
      setSuccess('Wallet deleted');
      await loadWallets();
    } catch (err) {
      setError(`Failed to delete wallet: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleSyncWallet = async (address: string) => {
    setError(null);
    setSuccess(null);
    setSyncingWallet(address);

    try {
      // Update delegate info first
      const info = await getAccountInfo(address);
      if (info) {
        const db = await getDB();
        const existingWallet = await db.get('wallets', address);
        if (existingWallet) {
          existingWallet.delegate = info.delegate;
          existingWallet.delegateName = info.delegateAlias;
          await db.put('wallets', existingWallet);
        }
      }
      
      // Clear existing events
      await clearEventsForWallet(address);
      
      // Fetch all transactions
      const { xtzOps, tokenOps } = await fetchAllTransactions(address);
      
      // Build events
      const events = buildEvents(address, xtzOps, tokenOps);
      
      // Apply smart classification
      const allWallets = await getWallets();
      const classifiedEvents = classifyEvents(events, allWallets);
      
      // Save to IndexedDB
      await saveEvents(classifiedEvents);
      await updateWalletSyncTime(address);
      
      // Count classifications for summary
      const stats: Record<string, number> = {};
      for (const e of classifiedEvents) {
        const c = e.classification || 'unknown';
        stats[c] = (stats[c] || 0) + 1;
      }
      
      const summaryParts = [];
      if (stats.baking_reward) summaryParts.push(`${stats.baking_reward} baking rewards`);
      if (stats.swap) summaryParts.push(`${stats.swap} swaps`);
      if (stats.likely_gift) summaryParts.push(`${stats.likely_gift} likely gifts`);
      
      const summary = summaryParts.length > 0 
        ? ` (${summaryParts.join(', ')})` 
        : '';
      
      setSuccess(`Synced ${classifiedEvents.length} events${summary}`);
      await loadWallets();
    } catch (err) {
      setError(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSyncingWallet(null);
    }
  };

  const formatDate = (iso?: string) => {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-2 mb-6">
        <Wallet className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Wallets</h2>
      </div>

      {/* Add Wallet Form */}
      <form onSubmit={handleAddWallet} className="mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="wallet-address" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Wallet Address
            </label>
            <input
              id="wallet-address"
              type="text"
              placeholder="tz1... or KT1..."
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
            />
          </div>
          <div className="sm:w-40">
            <label htmlFor="wallet-alias" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Nickname (optional)
            </label>
            <input
              id="wallet-alias"
              type="text"
              placeholder="e.g. Main Wallet"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
            />
          </div>
          <div className="sm:self-end">
            <button
              type="submit"
              disabled={isAdding}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              {isAdding ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
      </form>

      {/* Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg text-green-700 dark:text-green-300 text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {/* Wallet List */}
      {wallets.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm text-center py-8">
          No wallets added yet. Add your Tezos wallet address above.
        </p>
      ) : (
        <div className="space-y-3">
          {wallets.map((wallet) => (
            <div
              key={wallet.address}
              className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg gap-3"
            >
              <div className="min-w-0 flex-1">
                {wallet.alias && (
                  <p className="font-medium text-gray-900 dark:text-white">{wallet.alias}</p>
                )}
                <p className="text-sm text-gray-600 dark:text-gray-400 font-mono truncate">
                  {wallet.address}
                </p>
                <div className="flex flex-wrap gap-x-3 text-xs text-gray-400 dark:text-gray-500 mt-1">
                  <span>Last synced: {formatDate(wallet.lastSyncedAt)}</span>
                  {wallet.delegate && (
                    <span className="text-blue-500 dark:text-blue-400">
                      Delegated to: {wallet.delegateName || wallet.delegate.slice(0, 8) + '...'}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleSyncWallet(wallet.address)}
                  disabled={syncingWallet === wallet.address}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-lg transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${syncingWallet === wallet.address ? 'animate-spin' : ''}`} />
                  {syncingWallet === wallet.address ? 'Syncing...' : 'Sync'}
                </button>
                <button
                  onClick={() => handleDeleteWallet(wallet.address)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
