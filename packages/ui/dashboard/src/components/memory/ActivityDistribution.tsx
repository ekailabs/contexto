'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { capitalizeSector } from './SectorTooltip';
import type { MemorySummaryResponse } from '@/lib/api';

interface ActivityDistributionProps {
  data: MemorySummaryResponse | null;
  quickStats: { totalRetrievals: number } | null;
}

export function ActivityDistribution({ data, quickStats }: ActivityDistributionProps) {
  const activityData = (() => {
    if (!data?.recent) return [];
    const counts: Record<string, number> = {};
    data.recent.forEach((r) => {
      counts[r.sector] = (counts[r.sector] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name: capitalizeSector(name), value }));
  })();

  const colors = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500'];

  return (
    <div className="bg-gradient-to-br from-white to-stone-50/50 p-6 rounded-2xl border border-stone-200 shadow-lg hover:shadow-xl transition-all duration-300">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          Activity Distribution
        </h3>
        {data?.recent && (
          <div className="flex items-center gap-2 text-xs font-bold text-stone-500">
            <span className="w-2 h-2 rounded-full bg-teal-500 animate-pulse"></span>
            {data.recent.length} recent
          </div>
        )}
      </div>
      <div className="h-[320px] w-full bg-white/50 rounded-xl p-4 border border-stone-100">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={activityData} barSize={60}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" strokeWidth={1} />
            <XAxis 
              dataKey="name" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#78716c', fontSize: 12, fontWeight: 600 }} 
              dy={10}
            />
            <YAxis 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#a8a29e', fontSize: 11 }} 
            />
            <Tooltip 
              cursor={{ fill: '#f5f5f4', radius: 8 }}
              contentStyle={{ 
                borderRadius: '12px', 
                border: 'none', 
                boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)', 
                padding: '12px',
                backgroundColor: 'white'
              }}
              itemStyle={{ color: '#0d9488', fontWeight: 700 }}
            />
            <Bar 
              dataKey="value" 
              fill="url(#colorGradient)" 
              radius={[12, 12, 0, 0]}
            >
              <defs>
                <linearGradient id="colorGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#14b8a6" stopOpacity={1}/>
                  <stop offset="100%" stopColor="#0d9488" stopOpacity={1}/>
                </linearGradient>
              </defs>
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs font-medium text-stone-600">
          {activityData.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span className={`w-3 h-3 rounded-full ${colors[idx % colors.length]}`}></span>
              <span>{item.name}: {item.value}</span>
            </div>
          ))}
        </div>
        {quickStats && quickStats.totalRetrievals > 0 && (
          <div className="text-xs font-bold text-teal-700 bg-teal-50 px-3 py-1.5 rounded-full">
            {quickStats.totalRetrievals} total retrievals
          </div>
        )}
      </div>
    </div>
  );
}

