'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiService } from '@/lib/api';

interface GraphDetailsPanelProps {
  entity: string;
  onClose: () => void;
  onChanged?: () => void;
}

interface Triple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  validTo: number | null;
}

interface DeleteTripleModalProps {
  triple: Triple | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

function DeleteTripleModal({ triple, isOpen, onClose, onConfirm, isDeleting }: DeleteTripleModalProps) {
  if (!isOpen || !triple) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full transform transition-all">
          <div className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="flex-shrink-0 w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900">Delete Triple?</h3>
              </div>
            </div>

            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-3">
                This triple will be permanently deleted. This action cannot be undone.
              </p>
              <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1 font-medium">Triple:</p>
                <p className="text-sm text-gray-700 font-mono">
                  {triple.subject} → {triple.predicate} → {triple.object}
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Valid since {new Date(triple.validFrom).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </p>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GraphDetailsPanel({ entity, onClose, onChanged }: GraphDetailsPanelProps) {
  const [triples, setTriples] = useState<{ incoming: Triple[]; outgoing: Triple[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteModal, setDeleteModal] = useState<{ triple: Triple; isOpen: boolean } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch both directions
      const [incomingData, outgoingData] = await Promise.all([
        apiService.getGraphTriples({ entity, direction: 'incoming', maxResults: 50 }),
        apiService.getGraphTriples({ entity, direction: 'outgoing', maxResults: 50 })
      ]);

      setTriples({
        incoming: incomingData.triples,
        outgoing: outgoingData.triples
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load details');
    } finally {
      setLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    fetchData().catch(() => {
      /* error handled in fetchData */
    });
  }, [fetchData]);

  const handleDeleteClick = (triple: Triple) => {
    setDeleteModal({ triple, isOpen: true });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteModal) return;

    try {
      setDeletingId(deleteModal.triple.id);
      setDeleteModal(null);
      setError(null);
      await apiService.deleteGraphTriple(deleteModal.triple.id);
      await fetchData();
      if (onChanged) {
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete triple');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteModal(null);
  };

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-white shadow-2xl border-l border-stone-200 z-50 flex flex-col animate-in slide-in-from-right duration-300">
      {/* Header */}
      <div className="p-6 border-b border-stone-100 flex items-center justify-between bg-stone-50">
        <div>
          <h3 className="text-lg font-bold text-slate-900">{entity}</h3>
          <p className="text-xs text-stone-500 font-medium uppercase tracking-wider mt-1">Entity Details</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-stone-200 rounded-lg transition-colors text-stone-500 hover:text-stone-700"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="space-y-4">
            <div className="h-4 bg-stone-100 rounded w-3/4 animate-pulse"></div>
            <div className="h-20 bg-stone-50 rounded animate-pulse"></div>
            <div className="h-4 bg-stone-100 rounded w-1/2 animate-pulse delay-75"></div>
            <div className="h-20 bg-stone-50 rounded animate-pulse delay-75"></div>
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">
            {error}
          </div>
        ) : (
          <div className="space-y-8">
            {/* Outgoing Facts */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <span className="p-1.5 bg-teal-100 text-teal-600 rounded-md">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </span>
                <h4 className="text-sm font-bold text-stone-900">Outgoing Facts</h4>
                <span className="text-xs font-medium text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">
                  {triples?.outgoing.length || 0}
                </span>
              </div>
              
              {triples?.outgoing.length === 0 ? (
                <p className="text-sm text-stone-400 italic pl-9">No outgoing facts recorded.</p>
              ) : (
                <div className="space-y-3 pl-3 border-l-2 border-stone-100 ml-3">
                  {triples?.outgoing.map((t) => (
                    <div key={t.id} className="relative pl-6 py-1 group">
                      <div className="absolute left-[-5px] top-3 w-2.5 h-2.5 bg-stone-200 rounded-full group-hover:bg-teal-400 transition-colors border-2 border-white"></div>
                      <div className="flex items-start justify-between gap-2 text-sm">
                        <div>
                          <span className="text-teal-600 font-semibold">{t.predicate}</span>
                          <span className="mx-1.5 text-stone-300">→</span>
                          <span className="text-slate-900 font-medium bg-stone-50 px-1.5 py-0.5 rounded border border-stone-200">
                            {t.object}
                          </span>
                          <div className="mt-1 text-[10px] text-stone-500">
                            Valid since {new Date(t.validFrom).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric'
                            })}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteClick(t)}
                          disabled={deletingId === t.id}
                          className="text-rose-500 hover:text-rose-700 p-1 rounded-md hover:bg-rose-50 transition-colors disabled:opacity-60"
                          title="Delete triple"
                        >
                          {deletingId === t.id ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Incoming Facts */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <span className="p-1.5 bg-amber-100 text-amber-600 rounded-md">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                  </svg>
                </span>
                <h4 className="text-sm font-bold text-stone-900">Incoming References</h4>
                <span className="text-xs font-medium text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">
                  {triples?.incoming.length || 0}
                </span>
              </div>

              {triples?.incoming.length === 0 ? (
                <p className="text-sm text-stone-400 italic pl-9">No incoming references found.</p>
              ) : (
                <div className="space-y-3 pl-3 border-l-2 border-stone-100 ml-3">
                  {triples?.incoming.map((t) => (
                    <div key={t.id} className="relative pl-6 py-1 group">
                      <div className="absolute left-[-5px] top-3 w-2.5 h-2.5 bg-stone-200 rounded-full group-hover:bg-amber-400 transition-colors border-2 border-white"></div>
                      <div className="flex items-start justify-between gap-2 text-sm">
                        <div>
                          <span className="text-slate-900 font-medium bg-stone-50 px-1.5 py-0.5 rounded border border-stone-200">
                            {t.subject}
                          </span>
                          <span className="mx-1.5 text-stone-300">→</span>
                          <span className="text-amber-600 font-semibold">{t.predicate}</span>
                          <div className="mt-1 text-[10px] text-stone-500">
                            Valid since {new Date(t.validFrom).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric'
                            })}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteClick(t)}
                          disabled={deletingId === t.id}
                          className="text-rose-500 hover:text-rose-700 p-1 rounded-md hover:bg-rose-50 transition-colors disabled:opacity-60"
                          title="Delete triple"
                        >
                          {deletingId === t.id ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        <DeleteTripleModal
          triple={deleteModal?.triple || null}
          isOpen={deleteModal?.isOpen || false}
          onClose={handleDeleteCancel}
          onConfirm={handleDeleteConfirm}
          isDeleting={deletingId !== null}
        />
      </div>
    </div>
  );
}

