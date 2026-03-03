'use client';

import { useState } from 'react';
import type { MemorySectorSummary } from '@/lib/api';

const sectorColors: Record<string, string> = {
  episodic: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  semantic: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  procedural: 'bg-amber-100 text-amber-700 border-amber-200',
  reflective: 'bg-rose-100 text-rose-700 border-rose-200',
};

const sectorDescriptions: Record<string, string> = {
  episodic: 'Personal events and experiences the system has encountered.',
  semantic: 'Facts, concepts, and general knowledge extracted from interactions.',
  procedural: 'Multi-step skills, workflows, and how-to instructions.',
  reflective: 'Self-observations and meta-cognitive insights about behavior patterns.',
};

const capitalizeSector = (sector: string): string => {
  return sector.charAt(0).toUpperCase() + sector.slice(1);
};

interface SectorTooltipProps {
  sector: MemorySectorSummary['sector'];
  children: React.ReactNode;
}

export function SectorTooltip({ sector, children }: SectorTooltipProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {children}
      {showTooltip && (
        <div className="absolute z-50 w-56 p-3 text-xs text-gray-700 bg-white border border-gray-200 rounded-lg shadow-xl top-full left-0 mt-2 pointer-events-none">
          <div className="font-semibold text-gray-900 mb-1 flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${sectorColors[sector].split(' ')[0]}`}></span>
            {capitalizeSector(sector)}
          </div>
          <div className="text-gray-500 leading-relaxed">{sectorDescriptions[sector]}</div>
          {/* Arrow */}
          <div className="absolute bottom-full left-4 -mb-1">
            <div className="w-2.5 h-2.5 bg-white border-l border-t border-gray-200 transform rotate-45"></div>
          </div>
        </div>
      )}
    </div>
  );
}

export { sectorColors, sectorDescriptions, capitalizeSector };

