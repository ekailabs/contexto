'use client';

import { SectorTooltip, sectorColors, capitalizeSector } from './SectorTooltip';
import type { MemorySummaryResponse } from '@/lib/api';

interface MemoryStrengthProps {
  data: MemorySummaryResponse | null;
}

export function MemoryStrength({ data }: MemoryStrengthProps) {
  if (!data?.recent || data.recent.length === 0) return null;

  return (
    <div className="bg-gradient-to-br from-white via-stone-50/30 to-white p-6 rounded-2xl border border-stone-200 shadow-lg">
      <h3 className="text-xl font-bold text-slate-900 mb-6 flex items-center gap-2">
        <svg className="w-6 h-6 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        Memory Strength & Retrieval Patterns
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {data.summary.map((sector) => {
          const sectorMemories = data.recent.filter(m => m.sector === sector.sector);
          const avgRetrievals = sectorMemories.length > 0 
            ? Math.round(sectorMemories.reduce((sum, m) => sum + (m.retrievalCount ?? 0), 0) / sectorMemories.length)
            : 0;
          const mostRecent = sectorMemories[0]?.createdAt;
          const daysSinceLast = mostRecent ? Math.floor((Date.now() - mostRecent) / (24 * 60 * 60 * 1000)) : null;
          
          // Calculate "memory strength" - combination of recency and retrieval frequency
          const strength = daysSinceLast !== null 
            ? Math.max(0, 100 - (daysSinceLast * 2) + (avgRetrievals * 10))
            : 0;
          const strengthPercent = Math.min(100, Math.max(0, strength));
          
          return (
            <div key={sector.sector} className="relative bg-white/80 rounded-xl p-5 border border-stone-200 hover:border-stone-300 hover:shadow-md transition-all group overflow-hidden">
              {/* Strength indicator - organic flowing background */}
              <div 
                className="absolute inset-0 opacity-5 group-hover:opacity-10 transition-opacity"
                style={{
                  background: `radial-gradient(circle at center, ${(sectorColors[sector.sector] ?? '').includes('indigo') ? '#6366f1' : (sectorColors[sector.sector] ?? '').includes('emerald') ? '#10b981' : (sectorColors[sector.sector] ?? '').includes('amber') ? '#f59e0b' : '#f43f5e'} 0%, transparent 70%)`,
                }}
              ></div>
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-3">
                  <SectorTooltip sector={sector.sector}>
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${sectorColors[sector.sector]}`}>
                      {capitalizeSector(sector.sector)}
                    </span>
                  </SectorTooltip>
                  <div className="text-xs font-bold text-stone-400">{sector.count}</div>
                </div>
                
                {/* Memory strength visualization - organic blob */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-stone-600">Strength</span>
                    <span className="text-xs font-black text-slate-900">{Math.round(strengthPercent)}%</span>
                  </div>
                  <div className="relative h-3 bg-stone-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-1000 ease-out ${
                        strengthPercent > 70 ? 'bg-gradient-to-r from-emerald-400 to-emerald-600' :
                        strengthPercent > 40 ? 'bg-gradient-to-r from-amber-400 to-amber-600' :
                        'bg-gradient-to-r from-stone-300 to-stone-400'
                      }`}
                      style={{ 
                        width: `${strengthPercent}%`,
                        boxShadow: strengthPercent > 50 ? `0 0 8px rgba(${strengthPercent > 70 ? '16,185,129' : '245,158,11'}, 0.4)` : 'none'
                      }}
                    ></div>
                  </div>
                </div>
                
                {/* Retrieval frequency */}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-stone-500">Avg retrievals</span>
                  <span className="font-bold text-slate-700 flex items-center gap-1">
                    {avgRetrievals > 0 ? (
                      <>
                        <svg className="w-3 h-3 text-teal-500" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                        {avgRetrievals}
                      </>
                    ) : (
                      <span className="text-stone-400">Dormant</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

