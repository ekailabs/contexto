'use client';

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { SectorTooltip, capitalizeSector } from './SectorTooltip';
import type { MemorySummaryResponse } from '@/lib/api';

interface BrainCompositionProps {
  data: MemorySummaryResponse | null;
  quickStats: { total: number } | null;
}

export function BrainComposition({ data, quickStats }: BrainCompositionProps) {
  const radarData = data?.summary.map((s) => ({
    subject: capitalizeSector(s.sector),
    A: s.count,
    fullMark: Math.max(...(data.summary.map((i) => i.count) || [1])) * 1.2,
  })) || [];

  return (
    <div className="bg-gradient-to-br from-white via-stone-50/30 to-white p-6 rounded-2xl border border-stone-200 shadow-lg hover:shadow-xl transition-all duration-300 relative overflow-hidden">
      {/* Subtle organic background pattern */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{
        backgroundImage: `radial-gradient(circle at 20% 50%, #0d9488 0%, transparent 50%),
                         radial-gradient(circle at 80% 80%, #14b8a6 0%, transparent 50%),
                         radial-gradient(circle at 40% 20%, #6366f1 0%, transparent 50%)`,
      }}></div>
      
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <svg className="w-6 h-6 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            Memory Landscape
          </h3>
          {quickStats && (
            <span className="text-xs font-bold text-stone-500 bg-stone-100 px-2.5 py-1 rounded-full">
              {quickStats.total} engrams
            </span>
          )}
        </div>
        <div className="h-[400px] w-full flex items-center justify-center p-4 bg-gradient-to-br from-teal-50/20 via-stone-50/40 to-teal-50/20 rounded-xl border border-stone-100 backdrop-blur-sm">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart cx="50%" cy="50%" outerRadius="75%" data={radarData}>
              <PolarGrid stroke="#d6d3d1" strokeWidth={1.5} />
              <PolarAngleAxis 
                dataKey="subject" 
                tick={{ fill: '#78716c', fontSize: 13, fontWeight: 600 }} 
              />
              <PolarRadiusAxis angle={30} domain={[0, 'auto']} tick={false} axisLine={false} />
              <Radar
                name="Memories"
                dataKey="A"
                stroke="#0d9488"
                fill="#14b8a6"
                fillOpacity={0.4}
                strokeWidth={2}
              />
              <Tooltip 
                contentStyle={{ 
                  borderRadius: '12px', 
                  border: 'none', 
                  boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)', 
                  padding: '12px',
                  backgroundColor: 'white'
                }}
                itemStyle={{ color: '#0d9488', fontWeight: 700 }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          {data?.summary.map((s) => {
            const percentage = quickStats?.total ? Math.round((s.count / quickStats.total) * 100) : 0;
            const sectorMemories = data?.recent?.filter(m => m.sector === s.sector) || [];
            const totalRetrievals = sectorMemories.reduce((sum, m) => sum + (m.retrievalCount ?? 0), 0);
            const isActive = totalRetrievals > 0;
            
            return (
              <SectorTooltip key={s.sector} sector={s.sector}>
                <div className="relative text-center p-4 bg-white/80 rounded-xl cursor-help hover:bg-white transition-all border border-stone-200 hover:border-stone-300 hover:shadow-md group overflow-hidden">
                  {/* Pulsing glow for active memories */}
                  {isActive && (
                    <div className="absolute inset-0 bg-gradient-to-br from-teal-400/10 to-transparent animate-pulse"></div>
                  )}
                  <div className="relative z-10">
                    <div className="text-3xl font-black text-slate-900 group-hover:text-teal-700 transition-colors mb-1 flex items-center justify-center gap-2">
                      {s.count}
                      {isActive && (
                        <span className="text-xs font-bold text-teal-600 bg-teal-100 px-1.5 py-0.5 rounded-full">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-2">{s.sector}</div>
                    {/* Organic progress bar - more flowing */}
                    <div className="w-full bg-stone-100 rounded-full h-2 overflow-hidden relative">
                      <div 
                        className="h-full bg-gradient-to-r from-teal-400 via-teal-500 to-teal-600 rounded-full transition-all duration-700 ease-out relative"
                        style={{ width: `${percentage}%` }}
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
                      </div>
                    </div>
                    <div className="flex items-center justify-center gap-2 mt-2 text-[10px]">
                      <span className="font-bold text-stone-400">{percentage}%</span>
                      {totalRetrievals > 0 && (
                        <>
                          <span className="text-stone-300">•</span>
                          <span className="font-bold text-teal-600">{totalRetrievals} accessed</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </SectorTooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

