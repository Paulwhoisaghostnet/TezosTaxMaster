'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import {
  Wallet,
  TxEvent,
  getEventsForWallets,
  getClassificationOverrides,
  applyOverridesToEvents,
  saveClassificationOverride,
  saveEvents,
} from '@/lib/db';
import { classifyEvents, getReviewQueue } from '@/lib/classify-events';

const LABELS: Array<{ value: NonNullable<TxEvent['classification']>; label: string }> = [
  { value: 'received_income', label: 'Income' },
  { value: 'likely_gift', label: 'Gift (disposal)' },
  { value: 'self_transfer', label: 'Own wallet' },
  { value: 'cex_deposit', label: 'CEX deposit' },
  { value: 'cex_withdrawal', label: 'CEX withdrawal' },
  { value: 'baking_reward', label: 'Staking' },
  { value: 'royalty_income', label: 'Royalty' },
  { value: 'creator_sale', label: 'Creator sale' },
  { value: 'nft_purchase', label: 'NFT purchase' },
  { value: 'nft_sale', label: 'NFT sale' },
  { value: 'ignore', label: 'Ignore / non-taxable' },
];

interface ReviewQueueProps {
  wallets: Wallet[];
}

export default function ReviewQueue({ wallets }: ReviewQueueProps) {
  const [items, setItems] = useState<TxEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (wallets.length === 0) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const addresses = wallets.map((w) => w.address);
      const events = await getEventsForWallets(addresses);
      const overrides = await getClassificationOverrides();
      const withOverrides = applyOverridesToEvents(events, overrides);
      const classified = classifyEvents(withOverrides, wallets);
      setItems(getReviewQueue(classified).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [wallets]);

  useEffect(() => {
    reload();
  }, [reload]);

  const relabel = async (event: TxEvent, classification: NonNullable<TxEvent['classification']>) => {
    setSavingId(event.id);
    setMessage(null);
    try {
      await saveClassificationOverride({
        eventId: event.id,
        classification,
        note: `Owner relabeled as ${classification}`,
        updatedAt: new Date().toISOString(),
      });
      const updated: TxEvent = {
        ...event,
        classification,
        classificationNote: `Owner relabeled as ${classification}`,
        userOverride: true,
        confidence: 'high',
      };
      await saveEvents([updated]);
      setMessage(`Relabeled ${event.opHash.slice(0, 10)}… as ${classification}`);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  if (wallets.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Review unexplained transfers
        </h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        These are not auto-counted as income or gifts. Relabel before generating a filing report.
        Add every wallet you control so transfers between them classify as own-wallet.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle className="w-4 h-4" /> No items need review (or wallets not synced yet).
        </div>
      )}

      {message && (
        <div className="mb-3 text-sm text-blue-700 dark:text-blue-300">{message}</div>
      )}

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {items.map((e) => (
          <div
            key={e.id}
            className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-sm"
          >
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-gray-800 dark:text-gray-200">
              <span className="font-mono text-xs">{e.timestamp.slice(0, 19)}</span>
              <span>
                {e.direction} {e.quantity} {e.asset === 'XTZ' ? 'XTZ' : 'token'}
              </span>
              <span className="text-gray-500 truncate max-w-[12rem]" title={e.counterparty}>
                {e.counterparty.slice(0, 12)}…
              </span>
              <a
                className="text-blue-600 dark:text-blue-400 underline"
                href={`https://tzkt.io/${e.opHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {e.opHash.slice(0, 8)}…
              </a>
            </div>
            <p className="text-xs text-gray-500 mt-1">{e.classificationNote}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {LABELS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={savingId === e.id}
                  onClick={() => relabel(e, opt.value)}
                  className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
