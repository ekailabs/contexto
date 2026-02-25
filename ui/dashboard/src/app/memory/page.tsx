'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  apiService,
  type MemorySummaryResponse,
} from '@/lib/api';
import { SectorTooltip, sectorColors, capitalizeSector } from '@/components/memory/SectorTooltip';
import { ProceduralCard } from '@/components/memory/ProceduralCard';
import { DeleteModal, EditModal } from '@/components/memory/MemoryModals';
import { BrainComposition } from '@/components/memory/BrainComposition';
import { ActivityDistribution } from '@/components/memory/ActivityDistribution';
import { MemoryStrength } from '@/components/memory/MemoryStrength';
import { SemanticGraph } from '@/components/memory/SemanticGraph';
import ProfileSelector from '@/components/memory/ProfileSelector';
import UserFilter from '@/components/memory/UserFilter';
import ProfileManagement from '@/components/memory/ProfileManagement';
import ProfileStats from '@/components/memory/ProfileStats';
import ProfileBadge from '@/components/memory/ProfileBadge';


export default function MemoryVaultPage() {
  const [data, setData] = useState<MemorySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'logs' | 'graph'>('logs');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSector, setFilterSector] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteModal, setDeleteModal] = useState<{ type: 'single'; id: string; preview?: string } | { type: 'bulk' } | null>(null);
  const [bulkScope, setBulkScope] = useState<'current' | 'all'>('current');
  const [editModal, setEditModal] = useState<{ id: string; content: string; sector: string; userScope: string | null } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [currentProfile, setCurrentProfile] = useState('default');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [profileResolved, setProfileResolved] = useState(false);
  const [showProfileManagement, setShowProfileManagement] = useState(false);
  const [profileSwitching, setProfileSwitching] = useState(false);
  // On mount, pick the first non-default agent (or fall back to 'default')
  useEffect(() => {
    apiService.getAgents().then(({ agents }) => {
      const agent = agents.find(a => a.id !== 'default');
      if (agent) setCurrentProfile(agent.id);
      setProfileResolved(true);
    }).catch(() => {
      setProfileResolved(true);
    });
  }, []);

  const fetchData = useCallback(async () => {
    if (!profileResolved) return;
    try {
      setLoading(true);
      setError(null);
      // Fetch more items for better visualization (limit=100)
      const res = await apiService.getMemorySummary(100, currentProfile, selectedUserId || undefined);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memory summary');
    } finally {
      setLoading(false);
    }
  }, [currentProfile, profileResolved, selectedUserId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleProfileChange = (profileSlug: string) => {
    setProfileSwitching(true);
    setCurrentProfile(profileSlug);
    setSelectedUserId(null);
    setSearchTerm('');
    setFilterSector('all');
    setExpandedId(null);
    
    // Reset switching state after animation
    setTimeout(() => setProfileSwitching(false), 500);
  };

  const handleProfileDeleted = (profileSlug: string) => {
    if (profileSlug === currentProfile) {
      handleProfileChange('default');
    } else {
      fetchData();
    }
  };

  const handleEditClick = (id: string, content: string, sector: string, userScope?: string | null) => {
    setEditModal({ id, content, sector, userScope: userScope ?? null });
  };

  const handleDeleteClick = (id: string, preview?: string) => {
    setDeleteModal({ type: 'single', id, preview });
  };

  const handleBulkDeleteClick = () => {
    setBulkScope('current');
    setDeleteModal({ type: 'bulk' });
  };

  const handleEditConfirm = async () => {
    if (!editModal) return;

    try {
      setEditBusy(true);
      setError(null);
      await apiService.updateMemory(editModal.id, editModal.content, editModal.sector, currentProfile, editModal.userScope);
      setEditModal(null);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update memory');
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteModal) return;

    try {
      if (deleteModal.type === 'single') {
        setBusyId(deleteModal.id);
        setError(null);
        await apiService.deleteMemory(deleteModal.id, currentProfile);
      } else {
        setBulkBusy(true);
        setError(null);
        if (bulkScope === 'current') {
          await apiService.deleteAllMemories(currentProfile);
        } else {
          const { agents } = await apiService.getAgents();
          // Delete sequentially to surface the first failing agent clearly
          const targets = agents.length ? agents.map(a => a.id) : ['default'];
          for (const agentId of targets) {
            await apiService.deleteAllMemories(agentId);
          }
        }
      }
      setDeleteModal(null);
      await fetchData();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : deleteModal.type === 'single'
            ? 'Failed to delete memory'
            : bulkScope === 'current'
              ? `Failed to delete memories in "${currentProfile}" profile`
              : 'Failed to delete memories across profiles'
      );
    } finally {
      setBusyId(null);
      setBulkBusy(false);
    }
  };


  const filteredMemories = useMemo(() => {
    if (!data?.recent) return [];
    return data.recent.filter((item) => {
      // Exclude reflective memories (disabled)
      if (item.sector === 'reflective') return false;
      const matchesSearch = !searchTerm || item.preview.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesSector = filterSector === 'all' || item.sector === filterSector;
      const matchesUser = !selectedUserId || item.userScope === selectedUserId;
      return matchesSearch && matchesSector && matchesUser;
    });
  }, [data, searchTerm, filterSector, selectedUserId]);

  // Filter out reflective memories from display data, and apply user scope filter
  const displayData = useMemo(() => {
    if (!data) return null;
    const filtered = data.recent?.filter(r => {
      if (r.sector === 'reflective') return false;
      if (selectedUserId && r.userScope !== selectedUserId) return false;
      return true;
    });
    // Recompute summary counts from filtered recent items when user filter is active
    const summary = selectedUserId
      ? data.summary
          .filter(s => s.sector !== 'reflective')
          .map(s => ({
            ...s,
            count: filtered?.filter(r => r.sector === s.sector).length ?? 0,
          }))
      : data.summary.filter(s => s.sector !== 'reflective');
    return {
      ...data,
      summary,
      recent: filtered,
    };
  }, [data, selectedUserId]);

  // Calculate quick stats
  const quickStats = useMemo(() => {
    if (!displayData) return null;
    const total = displayData.summary.reduce((sum, s) => sum + s.count, 0);
    const totalRetrievals = displayData.recent?.reduce((sum, r) => sum + (r.retrievalCount ?? 0), 0) ?? 0;
    const mostRecent = displayData.recent?.[0]?.createdAt;
    const oldest = displayData.recent?.[displayData.recent.length - 1]?.createdAt;
    
    return {
      total,
      totalRetrievals,
      avgRetrievals: displayData.recent?.length ? Math.round(totalRetrievals / displayData.recent.length) : 0,
      mostRecent,
      oldest,
    };
  }, [displayData]);

  // Calculate sector counts for ProfileStats
  const sectorCounts = useMemo(() => {
    if (!displayData) return { episodic: 0, procedural: 0, semantic: 0 };
    return {
      episodic: displayData.summary.find(s => s.sector === 'episodic')?.count ?? 0,
      procedural: displayData.summary.find(s => s.sector === 'procedural')?.count ?? 0,
      semantic: displayData.summary.find(s => s.sector === 'semantic')?.count ?? 0,
    };
  }, [displayData]);

  // Wait for profile resolution before rendering
  if (!profileResolved) {
    return (
      <div className="min-h-screen font-sans text-slate-800 flex items-center justify-center" style={{ backgroundColor: '#FFFCEC' }}>
        <div className="text-stone-400 text-sm">Loading profiles...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans text-slate-800" style={{ backgroundColor: '#FFFCEC' }}>
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-stone-200 sticky top-11 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Memory Vault</h1>
                <p className="text-sm text-stone-500 mt-0.5">
                  {data?.recent?.length ?? 0} active engrams loaded
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ProfileSelector
                currentProfile={currentProfile}
                onProfileChange={handleProfileChange}
                onManageProfiles={() => setShowProfileManagement(true)}
              />
              <UserFilter
                currentProfile={currentProfile}
                selectedUserId={selectedUserId}
                onUserChange={setSelectedUserId}
              />
              <button
                onClick={fetchData}
                className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-all"
                title="Refresh"
                disabled={loading}
              >
                <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <button
                onClick={handleBulkDeleteClick}
                className="px-4 py-2 text-sm font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors border border-rose-200 shadow-sm"
                disabled={loading || bulkBusy}
              >
                {bulkBusy ? 'Deleting…' : `Delete all (${currentProfile})`}
              </button>
            </div>
          </div>
          
          {/* Tabs */}
          <div className="flex gap-8 mt-8 border-b border-stone-200/60">
            <button
              onClick={() => setActiveTab('overview')}
              className={`pb-3 text-sm font-semibold transition-all border-b-2 relative ${
                activeTab === 'overview'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-stone-500 hover:text-stone-700'
              }`}
            >
              Overview
              {activeTab === 'overview' && (
                <span className="absolute bottom-[-2px] left-0 right-0 h-[2px] bg-slate-900 rounded-full"></span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`pb-3 text-sm font-semibold transition-all border-b-2 relative ${
                activeTab === 'logs'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-stone-500 hover:text-stone-700'
              }`}
            >
              Memory Logs
              {activeTab === 'logs' && (
                <span className="absolute bottom-[-2px] left-0 right-0 h-[2px] bg-slate-900 rounded-full"></span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('graph')}
              className={`pb-3 text-sm font-semibold transition-all border-b-2 relative ${
                activeTab === 'graph'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-stone-500 hover:text-stone-700'
              }`}
            >
              Knowledge Graph
              {activeTab === 'graph' && (
                <span className="absolute bottom-[-2px] left-0 right-0 h-[2px] bg-slate-900 rounded-full"></span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Profile Switch Notification */}
      {profileSwitching && (
        <div className="fixed top-20 right-6 z-30 animate-in slide-in-from-top-2 fade-in duration-300">
          <div className="bg-gradient-to-r from-teal-500 to-teal-600 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 border-2 border-teal-400">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="font-semibold text-sm">Switching to {currentProfile} profile...</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 text-sm text-red-600 bg-red-50 p-4 rounded-lg border border-red-100 flex items-center gap-2">
             <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
             {error}
          </div>
        )}

        {activeTab === 'overview' ? (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Profile Statistics - New! */}
            <ProfileStats
              profileName={currentProfile}
              totalMemories={quickStats?.total ?? 0}
              episodicCount={sectorCounts.episodic}
              proceduralCount={sectorCounts.procedural}
              semanticCount={sectorCounts.semantic}
              totalRetrievals={quickStats?.totalRetrievals ?? 0}
            />
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <BrainComposition data={displayData} quickStats={quickStats} />
              <ActivityDistribution data={displayData} quickStats={quickStats} />
            </div>
            <MemoryStrength data={displayData} />
          </div>
        ) : activeTab === 'graph' ? (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <SemanticGraph maxDepth={2} maxNodes={50} height={600} agent={currentProfile} userId={selectedUserId} />
          </div>
        ) : (
          <div className="bg-gradient-to-br from-white via-stone-50/20 to-white rounded-2xl border border-stone-200 shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-hidden">
            {/* Note about semantic memories */}
            <div className="p-4 bg-teal-50 border-b border-teal-100 flex items-start gap-3">
              <svg className="w-5 h-5 text-teal-600 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-teal-900 font-medium">Semantic memories are visualized in the Knowledge Graph tab</p>
                <p className="text-xs text-teal-700 mt-0.5">Switch to the &quot;Knowledge Graph&quot; tab to explore semantic relationships as an interactive graph.</p>
              </div>
            </div>
            {/* Enhanced Toolbar */}
            <div className="p-6 border-b border-stone-200/60 flex flex-col sm:flex-row gap-4 justify-between items-center bg-gradient-to-r from-white to-stone-50/30 backdrop-blur-sm">
              <div className="flex items-center gap-3 flex-1 flex-wrap">
                <ProfileBadge profileName={currentProfile} animated={true} />
                <div className="relative w-full sm:w-96 group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-4 w-4 text-stone-400 group-focus-within:text-teal-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    placeholder="Search memories..."
                    className="block w-full pl-10 pr-4 py-2.5 border border-stone-200 rounded-xl leading-5 bg-stone-50 placeholder-stone-400 focus:outline-none focus:placeholder-stone-300 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 focus:bg-white sm:text-sm transition-all"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
              <div className="relative">
                <select
                  className="block w-full sm:w-48 pl-4 pr-10 py-2.5 text-sm font-medium text-slate-700 border-stone-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 rounded-xl bg-stone-50 focus:bg-white appearance-none transition-all cursor-pointer"
                  value={filterSector}
                  onChange={(e) => setFilterSector(e.target.value)}
                >
                  <option value="all">All Sectors</option>
                  <option value="episodic">Episodic</option>
                  <option value="procedural">Procedural</option>
                  <option value="semantic">Semantic</option>
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                  <svg className="w-4 h-4 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Table View */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-stone-100">
                <thead>
                  <tr className="bg-gradient-to-r from-stone-50 to-white">
                    <th scope="col" className="px-6 py-4 text-left text-xs font-bold text-stone-600 uppercase tracking-wider w-32">
                      Sector
                    </th>
                    <th scope="col" className="px-6 py-4 text-left text-xs font-bold text-stone-600 uppercase tracking-wider">
                      Memory Content
                    </th>
                    <th scope="col" className="px-6 py-4 text-left text-xs font-bold text-stone-600 uppercase tracking-wider w-48">
                      Created
                    </th>
                    <th scope="col" className="px-6 py-4 text-left text-xs font-bold text-stone-600 uppercase tracking-wider w-24">
                      Retrievals
                    </th>
                    <th scope="col" className="relative px-6 py-4 w-16">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-stone-100/50">
                  {filteredMemories.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-16 text-center">
                        <div className="flex flex-col items-center justify-center text-stone-400">
                          <svg className="w-12 h-12 mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <p className="text-sm font-medium">No memories found matching your criteria.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredMemories.map((item) => {
                      const age = Date.now() - item.createdAt;
                      const daysOld = Math.floor(age / (24 * 60 * 60 * 1000));
                      const isRecent = daysOld < 7;
                      const retrievalCount = item.retrievalCount ?? 0;
                      const isActive = retrievalCount > 0;
                      
                      return (
                        <tr 
                          key={item.id} 
                          className={`transition-all cursor-pointer group relative ${
                            expandedId === item.id 
                              ? 'bg-gradient-to-r from-teal-50/50 via-white to-teal-50/50' 
                              : 'hover:bg-gradient-to-r hover:from-stone-50/30 hover:via-white hover:to-stone-50/30'
                          }`}
                          onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                        >
                          <td className="px-6 py-5 whitespace-nowrap align-top relative">
                            {/* Left border indicator for active memories */}
                            {isActive && (
                              <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-teal-500 to-teal-600"></div>
                            )}
                            <div className="flex flex-col gap-1.5">
                              <SectorTooltip sector={item.sector}>
                                <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-[11px] font-bold border shadow-sm transition-all group-hover:scale-105 cursor-help ${
                                  isActive ? 'ring-2 ring-teal-200' : ''
                                } ${sectorColors[item.sector]}`}>
                                  {capitalizeSector(item.sector)}
                                  {isRecent && (
                                    <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                                  )}
                                </span>
                              </SectorTooltip>
                              {item.userScope ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200 w-fit" title={`Scoped to user: ${item.userScope}`}>
                                  @ {item.userScope.length > 12 ? item.userScope.slice(0, 12) + '...' : item.userScope}
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-stone-50 text-stone-400 border border-stone-100 w-fit">
                                  shared
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-5 align-top">
                            <div className={`text-sm text-slate-700 leading-relaxed transition-all ${expandedId === item.id ? '' : 'line-clamp-2 font-medium'}`}>
                              {item.preview}
                            </div>
                            
                            {expandedId === item.id && (
                              <div className="animate-in fade-in slide-in-from-top-2 duration-300 ease-out mt-3">
                                {item.sector === 'procedural' && item.details ? (
                                  <ProceduralCard details={item.details} />
                                ) : null}
                                
                                <div className="mt-4 pt-4 border-t border-stone-200 text-[11px] font-medium text-stone-500 flex gap-6 items-center flex-wrap">
                                  <span className="flex items-center gap-1.5 text-stone-500">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Last accessed: {new Date(item.lastAccessed).toLocaleString()}
                                  </span>
                                  {item.source && (
                                    <span className="flex items-center gap-1.5 text-stone-500">
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                      </svg>
                                      Source: {item.source}
                                    </span>
                                  )}
                                  {isRecent && (
                                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[10px] font-bold">
                                      New
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-xs font-medium text-stone-500 align-top">
                            <div className="flex flex-col gap-0.5">
                              <span>{new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                              <span className="text-[10px] text-stone-400">{new Date(item.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-sm text-stone-600 align-top">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                              isActive 
                                ? 'bg-teal-50 text-teal-700 border border-teal-200 shadow-sm' 
                                : 'bg-stone-100 text-stone-500'
                            }`}>
                              {isActive && (
                                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                </svg>
                              )}
                              {retrievalCount}
                            </span>
                          </td>
                          <td className="px-6 py-5 whitespace-nowrap text-right text-sm font-medium align-top">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEditClick(item.id, item.preview, item.sector, item.userScope);
                                }}
                                className="text-stone-400 hover:text-blue-600 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 p-2 rounded-lg hover:bg-blue-50 transform hover:scale-110"
                                title="Edit memory"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteClick(item.id, item.preview);
                                }}
                                className="text-stone-400 hover:text-rose-600 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 p-2 rounded-lg hover:bg-rose-50 transform hover:scale-110"
                                disabled={busyId === item.id}
                                title="Delete memory"
                              >
                                {busyId === item.id ? (
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
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modals */}
        <DeleteModal
          deleteModal={deleteModal}
          busyId={busyId}
          bulkBusy={bulkBusy}
          profile={currentProfile}
          bulkScope={bulkScope}
          onScopeChange={setBulkScope}
          onClose={() => setDeleteModal(null)}
          onConfirm={handleDeleteConfirm}
        />
        <EditModal
          editModal={editModal}
          editBusy={editBusy}
          onClose={() => setEditModal(null)}
          onConfirm={handleEditConfirm}
          onUpdate={(updates) => setEditModal(editModal ? { ...editModal, ...updates } as typeof editModal : null)}
        />
        <ProfileManagement
          isOpen={showProfileManagement}
          onClose={() => setShowProfileManagement(false)}
          currentProfile={currentProfile}
          onProfileDeleted={handleProfileDeleted}
        />
      </main>
    </div>
  );
}
