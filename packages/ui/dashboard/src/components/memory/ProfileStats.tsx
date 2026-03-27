'use client';

interface ProfileStatsProps {
  profileName: string;
  totalMemories: number;
  episodicCount: number;
  proceduralCount: number;
  semanticCount: number;
  totalRetrievals: number;
}

export default function ProfileStats({
  profileName,
  totalMemories,
  episodicCount,
  proceduralCount,
  semanticCount,
  totalRetrievals,
}: ProfileStatsProps) {
  const sectorData = [
    { name: 'Episodic', count: episodicCount, color: 'from-violet-500 to-purple-600', bgColor: 'bg-violet-50', borderColor: 'border-violet-200', textColor: 'text-violet-700' },
    { name: 'Procedural', count: proceduralCount, color: 'from-blue-500 to-indigo-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', textColor: 'text-blue-700' },
    { name: 'Semantic', count: semanticCount, color: 'from-emerald-500 to-teal-600', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200', textColor: 'text-emerald-700' },
  ];

  return (
    <div className="bg-gradient-to-br from-white via-stone-50/30 to-white p-6 rounded-2xl border-2 border-stone-200 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-bold text-stone-600 uppercase tracking-wider mb-1">Profile Statistics</h3>
          <p className="text-2xl font-bold text-slate-900">{profileName}</p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-teal-600">{totalMemories}</div>
          <div className="text-xs text-stone-500 font-medium">Total Memories</div>
        </div>
      </div>

      {/* Sector Breakdown */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {sectorData.map((sector) => (
          <div
            key={sector.name}
            className={`relative overflow-hidden ${sector.bgColor} p-4 rounded-xl border-2 ${sector.borderColor} shadow-sm hover:shadow-md transition-all group`}
          >
            {/* Gradient Accent Bar */}
            <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${sector.color}`}></div>
            
            <div className="relative pt-2">
              <div className="text-2xl font-bold text-slate-900 mb-1">{sector.count}</div>
              <div className={`text-xs font-semibold ${sector.textColor} uppercase tracking-wide`}>{sector.name}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Activity Meter */}
      <div className="bg-gradient-to-r from-teal-50 to-cyan-50 p-4 rounded-xl border-2 border-teal-200">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900 mb-0.5">Memory Activity</div>
            <div className="text-xs text-stone-600">Total retrievals across all sectors</div>
          </div>
          <div className="text-3xl font-bold text-teal-600">{totalRetrievals}</div>
        </div>
      </div>
    </div>
  );
}

