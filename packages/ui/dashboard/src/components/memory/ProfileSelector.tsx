'use client';

import { useState, useEffect, useRef } from 'react';
import { apiService } from '@/lib/api';

export interface Profile {
  slug: string;
  displayName: string;
  color: string;
  memoryCount?: number;
}

interface ProfileSelectorProps {
  currentProfile: string;
  onProfileChange: (profileSlug: string) => void;
  onManageProfiles: () => void;
}

// Color mapping for profiles
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

const formatProfileName = (slug: string): string => {
  return slug
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export default function ProfileSelector({ currentProfile, onProfileChange, onManageProfiles }: ProfileSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load agents from backend
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setLoading(true);
        const response = await apiService.getAgents();
        const profileList: Profile[] = response.agents.map((agent, index) => ({
          slug: agent.id,
          displayName: agent.name ? formatProfileName(agent.name) : formatProfileName(agent.id),
          color: getProfileColor(agent.id, index),
        }));
        setProfiles(profileList);
      } catch (err) {
        console.error('Failed to fetch agents', err);
        // Fallback to default profile if fetch fails
        setProfiles([{ slug: 'default', displayName: 'Default', color: 'bg-emerald-500' }]);
      } finally {
        setLoading(false);
      }
    };

    fetchAgents();
  }, []);

  const currentProfileData = profiles.find(p => p.slug === currentProfile) || (profiles[0] || { slug: 'default', displayName: 'Default', color: 'bg-emerald-500' });

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 px-4 py-2.5 bg-white border-2 border-stone-200 rounded-xl hover:border-stone-300 hover:shadow-md transition-all duration-200 group"
      >
        {/* Profile Avatar */}
        <div className={`w-8 h-8 ${currentProfileData.color} rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md group-hover:scale-110 transition-transform`}>
          {currentProfileData.displayName[0].toUpperCase()}
        </div>
        
        {/* Profile Name */}
        <div className="flex flex-col items-start">
          <span className="text-xs text-stone-500 font-medium">Active Profile</span>
          <span className="text-sm font-bold text-slate-900">{currentProfileData.displayName}</span>
        </div>

        {/* Dropdown Icon */}
        <svg 
          className={`w-4 h-4 text-stone-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} 
          fill="none" 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-72 bg-white border-2 border-stone-200 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Header */}
          <div className="px-4 py-3 bg-gradient-to-r from-stone-50 to-white border-b border-stone-200 flex items-center justify-between">
            <h3 className="text-xs font-bold text-stone-600 uppercase tracking-wider">Switch Profile</h3>
            <button
              onClick={() => {
                setIsOpen(false);
                onManageProfiles();
              }}
              className="text-xs font-semibold text-teal-600 hover:text-teal-700"
            >
              Manage
            </button>
          </div>

          {/* Profile List */}
          <div className="max-h-80 overflow-y-auto">
            {profiles.map((profile) => (
              <button
                key={profile.slug}
                onClick={() => {
                  onProfileChange(profile.slug);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gradient-to-r hover:from-stone-50 hover:to-white transition-all ${
                  profile.slug === currentProfile ? 'bg-teal-50 border-l-4 border-teal-500' : 'border-l-4 border-transparent'
                }`}
              >
                {/* Profile Avatar */}
                <div className={`w-10 h-10 ${profile.color} rounded-full flex items-center justify-center text-white font-bold shadow-md flex-shrink-0`}>
                  {profile.displayName[0].toUpperCase()}
                </div>

                {/* Profile Info */}
                <div className="flex-1 text-left">
                  <div className="text-sm font-semibold text-slate-900">{profile.displayName}</div>
                  <div className="text-xs text-stone-500">{profile.slug}</div>
                  {profile.memoryCount !== undefined && (
                    <div className="text-xs text-stone-400 mt-0.5">{profile.memoryCount} memories</div>
                  )}
                </div>

                {/* Active Indicator */}
                {profile.slug === currentProfile && (
                  <div className="w-2 h-2 rounded-full bg-teal-500 animate-pulse"></div>
                )}
              </button>
            ))}
          </div>

          {loading && (
            <div className="px-4 py-3 bg-gradient-to-r from-white to-stone-50 border-t border-stone-200">
              <div className="text-center text-sm text-stone-500">Loading profiles...</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

