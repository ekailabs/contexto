'use client';

import { useState, useEffect } from 'react';
import { apiService } from '@/lib/api';

interface Profile {
  slug: string;
  displayName: string;
  color: string;
}

interface ProfileManagementProps {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: string;
  onProfileDeleted?: (profile: string) => void;
}

const formatProfileName = (slug: string): string => {
  return slug
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const getProfileColor = (slug: string, index: number): string => {
  const colors = [
    'bg-emerald-500',
    'bg-purple-500',
    'bg-blue-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-cyan-500',
    'bg-indigo-500',
    'bg-pink-500',
    'bg-teal-500',
    'bg-orange-500',
  ];
  return colors[index % colors.length];
};

export default function ProfileManagement({ isOpen, onClose, currentProfile, onProfileDeleted }: ProfileManagementProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);

  const loadProfiles = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await apiService.getAgents();
      const profileList: Profile[] = response.agents.map((agent, index) => ({
        slug: agent.id,
        displayName: agent.name ? formatProfileName(agent.name) : formatProfileName(agent.id),
        color: getProfileColor(agent.id, index),
      }));
      setProfiles(profileList);
    } catch (err) {
      setError('Failed to load profiles');
      console.error('Failed to fetch agents', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    loadProfiles();
  }, [isOpen]);

  const handleDeleteProfile = async (slug: string) => {
    try {
      setDeleting(slug);
      setDeleteError('');
      await apiService.deleteAgent(slug);
      if (onProfileDeleted) onProfileDeleted(slug);
      await loadProfiles();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete profile';
      setDeleteError(message);
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-4 duration-300">
        {/* Header */}
        <div className="px-6 py-5 bg-gradient-to-r from-teal-500 to-teal-600 text-white">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">Profile Management</h2>
              <p className="text-teal-100 text-sm mt-1">Create and organize your memory profiles</p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {loading ? (
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
              <p className="mt-4 text-sm text-stone-600">Loading profiles...</p>
            </div>
          ) : error ? (
            <div className="bg-rose-50 border-2 border-rose-200 rounded-xl p-6 text-center">
              <p className="text-rose-700 font-semibold">{error}</p>
            </div>
          ) : (
            <div>
              {deleteError && (
                <div className="mb-4 bg-rose-50 border-2 border-rose-200 rounded-xl p-3 text-sm text-rose-700">
                  {deleteError}
                </div>
              )}
              <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Available Profiles
              </h3>

              {profiles.length === 0 ? (
                <div className="bg-stone-50 border-2 border-stone-200 rounded-xl p-8 text-center">
                  <p className="text-stone-600 font-medium">No profiles found</p>
                  <p className="text-sm text-stone-500 mt-2">Profiles are created automatically when memories are ingested with a profile parameter.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {profiles.map((profile) => (
                    <div
                      key={profile.slug}
                      className="flex items-center gap-4 p-4 bg-white border-2 border-stone-200 rounded-xl hover:border-stone-300 hover:shadow-md transition-all"
                    >
                      <div className={`w-12 h-12 ${profile.color} rounded-full flex items-center justify-center text-white font-bold text-lg shadow-md`}>
                        {profile.displayName[0].toUpperCase()}
                      </div>
                      
                      <div className="flex-1">
                        <div className="text-sm font-bold text-slate-900">{profile.displayName}</div>
                        <div className="text-xs text-stone-500">{profile.slug}</div>
                      </div>

                      {profile.slug === currentProfile && (
                        <span className="px-3 py-1 bg-teal-100 text-teal-700 text-xs font-bold rounded-full">
                          Active
                        </span>
                      )}

                      {profile.slug !== 'default' && (
                        <button
                          onClick={() => setDeleteTarget(profile)}
                          className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors"
                          disabled={deleting === profile.slug}
                          title="Delete profile"
                        >
                          {deleting === profile.slug ? (
                            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          ) : (
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-white border-2 border-stone-300 text-stone-700 font-semibold rounded-lg hover:bg-stone-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6 border border-stone-200">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-12 h-12 bg-rose-50 border border-rose-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-slate-900">Delete profile?</h3>
                <p className="text-sm text-stone-600 mt-1">
                  This will remove the profile &quot;{deleteTarget.displayName}&quot; and all of its memories. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm font-semibold text-stone-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition-colors"
                disabled={deleting === deleteTarget.slug}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteProfile(deleteTarget.slug)}
                className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors disabled:opacity-60"
                disabled={deleting === deleteTarget.slug}
              >
                {deleting === deleteTarget.slug ? 'Deleting…' : 'Delete profile'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

