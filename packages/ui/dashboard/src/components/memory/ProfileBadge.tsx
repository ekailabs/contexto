'use client';

interface ProfileBadgeProps {
  profileName: string;
  compact?: boolean;
  animated?: boolean;
}

export default function ProfileBadge({ profileName, compact = false, animated = true }: ProfileBadgeProps) {
  // Color mapping based on profile name
  const getProfileColor = (name: string) => {
    const colors: Record<string, { bg: string; text: string; border: string; glow: string }> = {
      default: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300', glow: 'shadow-emerald-200' },
      personal: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-300', glow: 'shadow-purple-200' },
      work: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-300', glow: 'shadow-blue-200' },
      research: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-300', glow: 'shadow-amber-200' },
    };
    return colors[name.toLowerCase()] || { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-300', glow: 'shadow-teal-200' };
  };

  const colors = getProfileColor(profileName);

  if (compact) {
    return (
      <span 
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border ${colors.bg} ${colors.text} ${colors.border} ${animated ? 'animate-in fade-in zoom-in-95 duration-300' : ''}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
        {profileName}
      </span>
    );
  }

  return (
    <div 
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border shadow-sm ${colors.bg} ${colors.text} ${colors.border} ${colors.glow} ${animated ? 'animate-in fade-in slide-in-from-left-2 duration-300' : ''}`}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
      <span className="text-xs font-bold">{profileName}</span>
    </div>
  );
}

