'use client';

import { useState, useEffect, useRef } from 'react';
import { apiService } from '@/lib/api';

interface AgentUser {
  userId: string;
  firstSeen: number;
  lastSeen: number;
  interactionCount: number;
}

interface UserFilterProps {
  currentProfile: string;
  selectedUserId: string | null;
  onUserChange: (userId: string | null) => void;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function UserFilter({ currentProfile, selectedUserId, onUserChange }: UserFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [users, setUsers] = useState<AgentUser[]>([]);
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

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        setLoading(true);
        const response = await apiService.getUsers(currentProfile);
        setUsers(response.users);
      } catch (err) {
        console.error('Failed to fetch users', err);
        setUsers([]);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, [currentProfile]);

  const selectedUser = users.find(u => u.userId === selectedUserId);
  const hasUsers = users.length > 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => hasUsers && setIsOpen(!isOpen)}
        className={`flex items-center gap-2.5 px-3.5 py-2.5 bg-white border-2 rounded-xl transition-all duration-200 group ${
          hasUsers
            ? 'border-stone-200 hover:border-stone-300 hover:shadow-md cursor-pointer'
            : 'border-stone-100 cursor-default opacity-60'
        } ${selectedUserId ? 'border-teal-300 bg-teal-50/30' : ''}`}
        disabled={!hasUsers}
      >
        {/* User icon */}
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
          selectedUserId ? 'bg-teal-500 text-white' : 'bg-stone-200 text-stone-500'
        }`}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>

        <div className="flex flex-col items-start">
          <span className="text-[10px] text-stone-500 font-medium leading-tight">User Scope</span>
          <span className="text-xs font-bold text-slate-900 leading-tight">
            {!hasUsers ? 'No users' : selectedUserId ? selectedUser?.userId ?? selectedUserId : 'All Users'}
          </span>
        </div>

        {hasUsers && (
          <svg
            className={`w-3.5 h-3.5 text-stone-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-72 bg-white border-2 border-stone-200 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Header */}
          <div className="px-4 py-3 bg-gradient-to-r from-stone-50 to-white border-b border-stone-200">
            <h3 className="text-xs font-bold text-stone-600 uppercase tracking-wider">Filter by User</h3>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {/* All Users option */}
            <button
              onClick={() => {
                onUserChange(null);
                setIsOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gradient-to-r hover:from-stone-50 hover:to-white transition-all ${
                !selectedUserId ? 'bg-teal-50 border-l-4 border-teal-500' : 'border-l-4 border-transparent'
              }`}
            >
              <div className="w-8 h-8 bg-stone-200 rounded-full flex items-center justify-center text-stone-500">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1 text-left">
                <div className="text-sm font-semibold text-slate-900">All Users</div>
                <div className="text-xs text-stone-500">Show all memories (unfiltered)</div>
              </div>
              {!selectedUserId && (
                <div className="w-2 h-2 rounded-full bg-teal-500 animate-pulse" />
              )}
            </button>

            {/* User list */}
            {users.map((user) => (
              <button
                key={user.userId}
                onClick={() => {
                  onUserChange(user.userId);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gradient-to-r hover:from-stone-50 hover:to-white transition-all ${
                  selectedUserId === user.userId ? 'bg-teal-50 border-l-4 border-teal-500' : 'border-l-4 border-transparent'
                }`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs ${
                  selectedUserId === user.userId ? 'bg-teal-500' : 'bg-stone-400'
                }`}>
                  {user.userId[0].toUpperCase()}
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">{user.userId}</div>
                  <div className="text-xs text-stone-500">
                    {user.interactionCount} interactions &middot; {formatTimeAgo(user.lastSeen)}
                  </div>
                </div>
                {selectedUserId === user.userId && (
                  <div className="w-2 h-2 rounded-full bg-teal-500 animate-pulse" />
                )}
              </button>
            ))}
          </div>

          {loading && (
            <div className="px-4 py-3 bg-gradient-to-r from-white to-stone-50 border-t border-stone-200">
              <div className="text-center text-sm text-stone-500">Loading users...</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
