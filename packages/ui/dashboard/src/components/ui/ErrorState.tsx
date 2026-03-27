interface ErrorStateProps {
  className?: string;
  title?: string;
  message: string;
  onRetry?: () => void;
}

export default function ErrorState({ 
  className = '', 
  title = "Error Loading Data",
  message,
  onRetry 
}: ErrorStateProps) {
  return (
    <div className={`card p-8 ${className}`}>
      <div className="text-red-600">
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="mb-4">{message}</p>
        {onRetry && (
          <button 
            onClick={onRetry}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}