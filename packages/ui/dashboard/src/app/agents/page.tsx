'use client';

import { useState, useEffect } from 'react';
import { apiService } from '@/lib/api';

// ── helpers (mirrored from ProfileManagement) ──────────────────────────────────
const COLORS = [
  'bg-emerald-500', 'bg-purple-500', 'bg-blue-500', 'bg-amber-500',
  'bg-rose-500',    'bg-cyan-500',   'bg-indigo-500','bg-pink-500',
  'bg-teal-500',    'bg-orange-500',
];

function getColor(index: number) { return COLORS[index % COLORS.length]; }

function formatName(slug: string) {
  return slug.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

// ── types ──────────────────────────────────────────────────────────────────────
interface Agent {
  id: string;
  name: string;
  createdAt: number;
  soulMd?: string;
  relevancePrompt?: string;
}

interface AgentStats {
  userCount: number;
  episodic: number;
  semantic: number;
  procedural: number;
  loaded: boolean;
}

// ── sub-components (inline, one-off) ──────────────────────────────────────────
function PromptBlock({ label, text }: { label: string; text?: string }) {
  return (
    <div className="mt-3">
      <div className="text-[11px] font-bold text-stone-400 uppercase tracking-wider mb-1">{label}</div>
      {text ? (
        <pre className="font-mono text-xs text-slate-700 bg-stone-50 border border-stone-200 rounded-lg p-3 overflow-y-auto max-h-36 whitespace-pre-wrap break-words leading-relaxed">
          {text}
        </pre>
      ) : (
        <p className="text-xs text-stone-400 italic bg-stone-50 border border-stone-100 rounded-lg p-3">
          Not set
        </p>
      )}
    </div>
  );
}

// ── main page ──────────────────────────────────────────────────────────────────
export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // edit modal
  const [editTarget, setEditTarget] = useState<Agent | null>(null);
  const [editName, setEditName] = useState('');
  const [editSoul, setEditSoul] = useState('');
  const [editRelevance, setEditRelevance] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  // create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createId, setCreateId] = useState('');
  const [createName, setCreateName] = useState('');
  const [createSoul, setCreateSoul] = useState('');
  const [createRelevance, setCreateRelevance] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  // delete modal
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const loadAgents = async () => {
    try {
      setLoading(true);
      setError('');
      const { agents: list } = await apiService.getAgents();
      setAgents(list);
      // load stats lazily after paint
      setTimeout(() => loadStats(list), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async (list: Agent[]) => {
    await Promise.all(list.map(async (agent, _i) => {
      try {
        const [usersRes, summaryRes] = await Promise.all([
          apiService.getUsers(agent.id),
          apiService.getMemorySummary(1, agent.id),
        ]);
        setStats(prev => ({
          ...prev,
          [agent.id]: {
            userCount: usersRes.users.length,
            episodic:  summaryRes.summary.find(s => s.sector === 'episodic')?.count  ?? 0,
            semantic:  summaryRes.summary.find(s => s.sector === 'semantic')?.count  ?? 0,
            procedural:summaryRes.summary.find(s => s.sector === 'procedural')?.count?? 0,
            loaded: true,
          },
        }));
      } catch {
        setStats(prev => ({
          ...prev,
          [agent.id]: { userCount: 0, episodic: 0, semantic: 0, procedural: 0, loaded: true },
        }));
      }
    }));
  };

  useEffect(() => { loadAgents(); }, []);

  // ── edit handlers ────────────────────────────────────────────────────────────
  const openEdit = (agent: Agent) => {
    setEditTarget(agent);
    setEditName(agent.name ?? '');
    setEditSoul(agent.soulMd ?? '');
    setEditRelevance(agent.relevancePrompt ?? '');
    setEditError('');
  };

  const handleEditSave = async () => {
    if (!editTarget) return;
    try {
      setEditBusy(true);
      setEditError('');
      await apiService.updateAgent(editTarget.id, {
        name: editName || undefined,
        soulMd: editSoul || undefined,
        relevancePrompt: editRelevance || undefined,
      });
      setAgents(prev => prev.map(a => a.id === editTarget.id
        ? { ...a, name: editName || a.name, soulMd: editSoul, relevancePrompt: editRelevance }
        : a
      ));
      setEditTarget(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setEditBusy(false);
    }
  };

  // ── create handlers ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setCreateId(''); setCreateName(''); setCreateSoul(''); setCreateRelevance('');
    setCreateError('');
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!SLUG_RE.test(createId)) {
      setCreateError('ID must be 1-40 chars, lowercase alphanumeric, dash, or underscore');
      return;
    }
    try {
      setCreateBusy(true);
      setCreateError('');
      await apiService.createAgent(createId, {
        name: createName || undefined,
        soulMd: createSoul || undefined,
        relevancePrompt: createRelevance || undefined,
      });
      setShowCreate(false);
      await loadAgents();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create agent');
    } finally {
      setCreateBusy(false);
    }
  };

  // ── delete handlers ──────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleteBusy(true);
      setDeleteError('');
      await apiService.deleteAgent(deleteTarget.id);
      setDeleteTarget(null);
      setAgents(prev => prev.filter(a => a.id !== deleteTarget.id));
      setStats(prev => { const n = { ...prev }; delete n[deleteTarget.id]; return n; });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete agent');
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen font-sans text-slate-800" style={{ backgroundColor: '#FFFCEC' }}>
      {/* Page header */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Agents</h1>
            <p className="text-sm text-stone-500 mt-0.5">
              {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
            </p>
          </div>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Agent
          </button>
        </div>

        {error && (
          <div className="mb-6 text-sm text-rose-700 bg-rose-50 border border-rose-200 p-4 rounded-lg">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-20 text-stone-400">
            <p className="text-sm font-medium">No agents found. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {agents.map((agent, idx) => {
              const agentStats = stats[agent.id];
              const displayName = agent.name ? formatName(agent.name) : formatName(agent.id);
              const color = getColor(idx);
              return (
                <div
                  key={agent.id}
                  className="bg-white rounded-2xl border border-stone-200 shadow-sm hover:shadow-md transition-shadow p-5 flex flex-col gap-0"
                >
                  {/* Avatar + name */}
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-11 h-11 ${color} rounded-full flex items-center justify-center text-white font-bold text-lg shadow-md flex-shrink-0`}>
                      {displayName[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-slate-900 text-sm truncate">{displayName}</div>
                      <div className="text-xs text-stone-400 font-mono">{agent.id}</div>
                      {agent.createdAt > 0 && (
                        <div className="text-[10px] text-stone-400 mt-0.5">
                          Created {new Date(agent.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="flex gap-3 flex-wrap mb-1">
                    {!agentStats?.loaded ? (
                      <span className="text-[11px] text-stone-400 italic">Loading stats…</span>
                    ) : (
                      <>
                        <StatChip label="Users" value={agentStats.userCount} />
                        <StatChip label="Episodic" value={agentStats.episodic} />
                        <StatChip label="Semantic" value={agentStats.semantic} />
                        <StatChip label="Procedural" value={agentStats.procedural} />
                      </>
                    )}
                  </div>

                  {/* Soul / Relevance prompts */}
                  <PromptBlock label="Soul / Persona" text={agent.soulMd} />
                  <PromptBlock label="Relevance Filter" text={agent.relevancePrompt} />

                  {/* Actions */}
                  {agent.id !== 'default' && (
                    <div className="flex gap-2 mt-4 pt-4 border-t border-stone-100">
                      <button
                        onClick={() => openEdit(agent)}
                        className="flex-1 py-1.5 text-sm font-medium text-slate-700 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => { setDeleteError(''); setDeleteTarget(agent); }}
                        className="flex-1 py-1.5 text-sm font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Edit Modal ─────────────────────────────────────────────────────────── */}
      {editTarget && (
        <ModalOverlay onClose={() => setEditTarget(null)}>
          <h2 className="text-lg font-bold text-slate-900 mb-4">Edit Agent — {editTarget.id}</h2>
          {editError && <p className="text-sm text-rose-600 mb-3">{editError}</p>}
          <label className="block mb-3">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Name</span>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              placeholder="Display name"
            />
          </label>
          <label className="block mb-3">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Soul / Persona</span>
            <textarea
              value={editSoul}
              onChange={e => setEditSoul(e.target.value)}
              rows={8}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500 resize-y"
              placeholder="System / soul prompt markdown…"
            />
          </label>
          <label className="block mb-5">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Relevance Filter Prompt</span>
            <textarea
              value={editRelevance}
              onChange={e => setEditRelevance(e.target.value)}
              rows={4}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500 resize-y"
              placeholder="Relevance gate instructions…"
            />
          </label>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setEditTarget(null)}
              disabled={editBusy}
              className="px-4 py-2 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              disabled={editBusy}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors disabled:opacity-60"
            >
              {editBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </ModalOverlay>
      )}

      {/* ── Create Modal ───────────────────────────────────────────────────────── */}
      {showCreate && (
        <ModalOverlay onClose={() => setShowCreate(false)}>
          <h2 className="text-lg font-bold text-slate-900 mb-4">New Agent</h2>
          {createError && <p className="text-sm text-rose-600 mb-3">{createError}</p>}
          <label className="block mb-3">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">ID <span className="text-rose-500">*</span></span>
            <input
              type="text"
              value={createId}
              onChange={e => setCreateId(e.target.value.toLowerCase())}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              placeholder="my-agent-id"
            />
            <p className="text-[10px] text-stone-400 mt-1">Lowercase alphanumeric, dash, underscore · 1–40 chars</p>
          </label>
          <label className="block mb-3">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Name</span>
            <input
              type="text"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500"
              placeholder="Display name (optional)"
            />
          </label>
          <label className="block mb-3">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Soul / Persona</span>
            <textarea
              value={createSoul}
              onChange={e => setCreateSoul(e.target.value)}
              rows={6}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500 resize-y"
              placeholder="System / soul prompt markdown…"
            />
          </label>
          <label className="block mb-5">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">Relevance Filter Prompt</span>
            <textarea
              value={createRelevance}
              onChange={e => setCreateRelevance(e.target.value)}
              rows={3}
              className="mt-1 block w-full border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500 resize-y"
              placeholder="Relevance gate instructions…"
            />
          </label>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowCreate(false)}
              disabled={createBusy}
              className="px-4 py-2 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={createBusy || !createId}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors disabled:opacity-60"
            >
              {createBusy ? 'Creating…' : 'Create Agent'}
            </button>
          </div>
        </ModalOverlay>
      )}

      {/* ── Delete Confirm Modal ───────────────────────────────────────────────── */}
      {deleteTarget && (
        <ModalOverlay onClose={() => setDeleteTarget(null)}>
          <div className="flex items-start gap-3 mb-4">
            <div className="w-12 h-12 bg-rose-50 border border-rose-100 rounded-full flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Delete agent?</h3>
              <p className="text-sm text-stone-600 mt-1">
                This will permanently remove <strong>{deleteTarget.id}</strong> and all its memories. This action cannot be undone.
              </p>
            </div>
          </div>
          {deleteError && <p className="text-sm text-rose-600 mb-3">{deleteError}</p>}
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteTarget(null)}
              disabled={deleteBusy}
              className="px-4 py-2 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteBusy}
              className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors disabled:opacity-60"
            >
              {deleteBusy ? 'Deleting…' : 'Delete agent'}
            </button>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}

// ── tiny shared modal wrapper ──────────────────────────────────────────────────
function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[90vh] overflow-y-auto p-6">
        {children}
      </div>
    </div>
  );
}

// ── stat chip ──────────────────────────────────────────────────────────────────
function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-600 border border-stone-200">
      <span className="font-bold text-slate-700">{value}</span>
      {label}
    </span>
  );
}
