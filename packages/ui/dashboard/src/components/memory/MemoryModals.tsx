'use client';

interface DeleteModalProps {
  deleteModal: { type: 'single'; id: string; preview?: string } | { type: 'bulk' } | null;
  busyId: string | null;
  bulkBusy: boolean;
  profile: string;
  bulkScope: 'current' | 'all';
  onScopeChange: (scope: 'current' | 'all') => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteModal({
  deleteModal,
  busyId,
  bulkBusy,
  profile,
  bulkScope,
  onScopeChange,
  onClose,
  onConfirm,
}: DeleteModalProps) {
  if (!deleteModal) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full transform transition-all">
          <div className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="flex-shrink-0 w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900">
                  {deleteModal.type === 'bulk' ? 'Delete All Memories?' : 'Delete Memory?'}
                </h3>
              </div>
            </div>
            
            <div className="mb-6">
              {deleteModal.type === 'bulk' ? (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Choose what to delete. This action cannot be undone.
                  </p>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 hover:border-rose-300 transition-colors">
                      <input
                        type="radio"
                        name="bulk-delete-scope"
                        className="mt-1 h-4 w-4 text-rose-600 border-gray-300 focus:ring-rose-500"
                        checked={bulkScope === 'current'}
                        onChange={() => onScopeChange('current')}
                      />
                      <div className="text-sm">
                        <div className="font-semibold text-gray-900">Delete current profile</div>
                        <div className="text-gray-600 text-xs">Remove every memory in the &quot;{profile}&quot; profile only.</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 hover:border-rose-300 transition-colors">
                      <input
                        type="radio"
                        name="bulk-delete-scope"
                        className="mt-1 h-4 w-4 text-rose-600 border-gray-300 focus:ring-rose-500"
                        checked={bulkScope === 'all'}
                        onChange={() => onScopeChange('all')}
                      />
                      <div className="text-sm">
                        <div className="font-semibold text-gray-900">Delete all profiles</div>
                        <div className="text-gray-600 text-xs">Remove memories from every profile. Use with caution.</div>
                      </div>
                    </label>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-gray-600 mb-3">
                    This memory will be permanently deleted from the &quot;{profile}&quot; profile. This action cannot be undone.
                  </p>
                  {deleteModal.preview && (
                    <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
                      <p className="text-xs text-gray-500 mb-1 font-medium">Preview:</p>
                      <p className="text-sm text-gray-700 line-clamp-3">{deleteModal.preview}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                disabled={busyId !== null || bulkBusy}
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busyId !== null || bulkBusy}
              >
                {busyId !== null || bulkBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface EditModalProps {
  editModal: { id: string; content: string; sector: string; userScope?: string | null } | null;
  editBusy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onUpdate: (updates: { content?: string; sector?: string; userScope?: string | null }) => void;
}

export function EditModal({ editModal, editBusy, onClose, onConfirm, onUpdate }: EditModalProps) {
  if (!editModal) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full transform transition-all">
          <div className="p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="flex-shrink-0 w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-gray-900">Edit Memory</h3>
              </div>
            </div>
            
            <div className="mb-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Sector
                </label>
                <select
                  className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md bg-white"
                  value={editModal.sector}
                  onChange={(e) => onUpdate({ sector: e.target.value })}
                >
                  <option value="episodic">Episodic</option>
                  <option value="semantic">Semantic</option>
                  <option value="procedural">Procedural</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Content
                </label>
                <textarea
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm resize-y min-h-[200px]"
                  value={editModal.content}
                  onChange={(e) => onUpdate({ content: e.target.value })}
                  placeholder="Enter memory content..."
                />
                <p className="mt-1 text-xs text-gray-500">
                  The embedding will be regenerated automatically when you save.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  User Scope
                </label>
                <input
                  type="text"
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  value={editModal.userScope ?? ''}
                  onChange={(e) => onUpdate({ userScope: e.target.value || null })}
                  placeholder="Leave empty for shared/global"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Assign this memory to a specific user ID, or leave empty for shared access.
                </p>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                disabled={editBusy}
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={editBusy || !editModal.content.trim()}
              >
                {editBusy ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

