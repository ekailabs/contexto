'use client';

import type { MemoryRecentItem } from '@/lib/api';

interface ProceduralCardProps {
  details: NonNullable<MemoryRecentItem['details']>;
}

export function ProceduralCard({ details }: ProceduralCardProps) {
  // Safely handle steps - could be array or string
  const steps = Array.isArray(details.steps) 
    ? details.steps 
    : (typeof details.steps === 'string' ? JSON.parse(details.steps) : []);

  return (
    <div className="mt-4 bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      <div className="bg-amber-50/50 px-4 py-2 border-b border-amber-100 flex items-center gap-2">
        <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">Procedure Workflow</span>
      </div>
      
      <div className="p-5 space-y-6">
        {/* Goal Section */}
        {details.goal && (
          <div className="flex gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <div className="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
                Goal
              </div>
              <div className="text-sm text-gray-900 font-medium bg-indigo-50/50 p-3 rounded-md border border-indigo-100">
                {details.goal}
              </div>
            </div>
          </div>
        )}
        
        {/* Steps Section */}
        {steps && Array.isArray(steps) && steps.length > 0 && (
          <div className="flex gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                Execution Flow
              </div>
              <div className="relative">
                <div className="absolute left-3.5 top-2 bottom-2 w-0.5 bg-gradient-to-b from-amber-200 to-amber-50/0"></div>
                <ul className="space-y-4 relative">
                  {steps.map((step, idx) => (
                    <li key={idx} className="flex gap-4 items-start group">
                      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-white border-2 border-amber-200 text-xs font-bold text-amber-600 flex items-center justify-center mt-0.5 shadow-sm group-hover:border-amber-400 group-hover:text-amber-700 transition-colors z-10">
                        {idx + 1}
                      </div>
                      <div className="flex-1 pt-1">
                        <span className="text-sm text-gray-700 leading-relaxed block">{step}</span>
                        {idx < steps.length - 1 && (
                          <div className="mt-2 text-amber-300/50 pl-1">
                            <svg className="w-4 h-4 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                            </svg>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Context & Result Grid */}
        {(details.result || details.context) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-gray-100">
            {details.result && (
              <div className="bg-emerald-50/50 rounded-md p-3 border border-emerald-100">
                <div className="text-xs font-bold text-emerald-600 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Outcome
                </div>
                <div className="text-sm text-gray-800 leading-relaxed">{details.result}</div>
              </div>
            )}
            {details.context && (
              <div className="bg-gray-50/80 rounded-md p-3 border border-gray-200">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Context
                </div>
                <div className="text-sm text-gray-600 italic leading-relaxed">{details.context}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

