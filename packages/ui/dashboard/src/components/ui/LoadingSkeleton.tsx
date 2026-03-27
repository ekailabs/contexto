type SkeletonVariant = 'chart' | 'table' | 'card' | 'grid';

interface LoadingSkeletonProps {
  className?: string;
  variant?: SkeletonVariant;
  /**
   * Optional height in px for chart variant.
   */
  height?: number;
  /**
   * How many rows to render for table variant or cards for grid variant.
   */
  count?: number;
}

export default function LoadingSkeleton({
  className = '',
  variant = 'chart',
  height = 256,
  count = 5
}: LoadingSkeletonProps) {
  const renderChart = () => (
    <div className="animate-pulse">
      <div className="h-6 bg-gray-200 rounded w-1/3 mb-6"></div>
      <div className="rounded bg-gray-200" style={{ height }}></div>
    </div>
  );

  const renderTable = () => (
    <div className="animate-pulse">
      <div className="h-6 bg-gray-200 rounded w-1/3 mb-6"></div>
      <div className="space-y-3">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="h-12 bg-gray-200 rounded"></div>
        ))}
      </div>
    </div>
  );

  const renderCard = () => (
    <div className="animate-pulse space-y-3">
      <div className="h-4 bg-gray-200 rounded w-24"></div>
      <div className="h-6 bg-gray-200 rounded w-40"></div>
      <div className="h-3 bg-gray-200 rounded w-3/4"></div>
      <div className="h-3 bg-gray-200 rounded w-1/2"></div>
      <div className="h-10 bg-gray-200 rounded w-32"></div>
    </div>
  );

  const renderGrid = () => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-4 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-24 mb-2"></div>
          <div className="h-6 bg-gray-200 rounded w-32"></div>
        </div>
      ))}
    </div>
  );

  const baseClass =
    variant === 'grid' ? className : `card p-8 ${className}`.trim();

  return (
    <div className={baseClass}>
      {variant === 'chart' && renderChart()}
      {variant === 'table' && renderTable()}
      {variant === 'card' && renderCard()}
      {variant === 'grid' && renderGrid()}
    </div>
  );
}