import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';
import { useLang } from '../providers/LanguageProvider';
import { useUI } from '../providers/UIProvider';
import CategoryManager from '../components/CategoryManager';
import WorkflowDetailModal from '../components/workflow-registry/WorkflowDetailModal';
import ApprovalReviewModal from '../components/workflow-registry/ApprovalReviewModal';
import SigningKeyModal from '../components/workflow-registry/SigningKeyModal';
import WorkflowIOSection from '../components/workflow-registry/WorkflowIOSection';
import WorkflowSnapshotModal from '../components/workflow-registry/WorkflowSnapshotModal';
import WorkflowRecycleBinModal from '../components/workflow-registry/WorkflowRecycleBinModal';
import WorkflowRawJsonModal from '../components/workflow-registry/WorkflowRawJsonModal';
import { formatDate } from '../utils/format';

import type { Workflow, CategoryConfig, WorkflowStep } from '../types';
import { useWorkflows } from '../hooks/useWorkflows';

export default function WorkflowManagement() {
  const { t } = useLang();
  const { toast, confirm } = useUI();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const {
    workflows,
    total,
    loading,
    error: fetchError,
    refresh: fetchWorkflows,
    deleteWorkflow,
    restoreWorkflow
  } = useWorkflows({ page, pageSize });

  const [error, setError] = useState('');
  const [isServiceError, setIsServiceError] = useState(false);
  const [serviceUrl, setServiceUrl] = useState('');

  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [deletedWorkflows, setDeletedWorkflows] = useState<Workflow[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [snapshotWorkflows, setSnapshotWorkflows] = useState<any[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotTimestamp, setSnapshotTimestamp] = useState<number | null>(null);

  // Category State
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [showCatModal, setShowCatModal] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<CategoryConfig | null>(null);
  const [rawJsonWorkflow, setRawJsonWorkflow] = useState<Workflow | null>(null);
  const [lastActiveId, setLastActiveId] = useState<string | null>(null);

  const [denyModal, setDenyModal] = useState<{ id: string; name: string } | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const RPC_METHOD = 'orchestrator.workflow.list';

  void fetchError; void setError; void setServiceUrl; void error; void serviceUrl; void setIsServiceError;

  const fetchDeletedWorkflows = async () => {
    setDeletedLoading(true);
    try {
      const result = await callRpc<{ items: Workflow[] }>(RPC_METHOD, {
        includeDeleted: true,
        limit: 100, // Just get last 100 deleted
        offset: 0
      });
      setDeletedWorkflows((result.items || []).filter(w => w.status === 'DELETED'));
    } catch (err) {
      console.error('Failed to fetch deleted workflows:', err);
    } finally {
      setDeletedLoading(false);
    }
  };

  const fetchSnapshot = async () => {
    setSnapshotLoading(true);
    try {
      const result = await callRpc<{ items: any[], timestamp: number }>('orchestrator.workflow.snapshot', {});
      setSnapshotWorkflows(result.items || []);
      setSnapshotTimestamp(result.timestamp);
    } catch (err) {
      console.error('Failed to fetch snapshot:', err);
      toast.error('Failed to fetch AI snapshot');
    } finally {
      setSnapshotLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const result = await callRpc<CategoryConfig[] | { categories: CategoryConfig[] }>('orchestrator.category.list', {});
      let catList: CategoryConfig[] = [];
      if (Array.isArray(result)) {
        catList = result;
      } else if (result && 'categories' in result && Array.isArray(result.categories)) {
        catList = result.categories;
      }
      setCategories(catList);
    } catch (e) {
      console.warn('Failed to load categories', e);
    }
  };

  const openCategoryModal = (cat: CategoryConfig) => {
    setSelectedCategory(cat);
    setShowCatModal(true);
  };

  useEffect(() => {
    fetchWorkflows();
    fetchCategories();
  }, [page, fetchWorkflows]);

  const handleDelete = async (id: string) => {
    const isConfirmed = await confirm({
      message: `Delete workflow "${id}"?`,
      confirmLabel: 'DELETE',
      isDangerous: true
    });
    if (!isConfirmed) return;

    try {
      await callRpc('orchestrator.workflow.delete', { id });
      toast.success('Workflow deleted');
      await fetchWorkflows();
    } catch (e: any) {
      toast.error('Delete failed: ' + e.message);
    }
  };

  const handleRestore = async (id: string) => {
    try {
      await callRpc('orchestrator.workflow.restore', { id });
      toast.success('Workflow restored — pending re-approval');
      await fetchWorkflows();
    } catch (e: any) {
      toast.error('Restore failed: ' + e.message);
    }
  };

  // §3.3 — approval now goes through the review modal (footprint/subscriptions/schema/diff
  // + risk-based sign-off), never a blind one-click approve.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [showSigningKey, setShowSigningKey] = useState(false);
  const handleApprove = (id: string) => setReviewId(id);

  const openDenyModal = (wf: Workflow) => {
    setDenyReason('');
    setDenyModal({ id: wf.id, name: wf.name });
  };

  const handleDenyConfirm = async () => {
    if (!denyModal || !denyReason.trim()) return;
    try {
      await callRpc('orchestrator.workflow.deny', { id: denyModal.id, reason: denyReason.trim() });
      toast.success('Workflow denied');
      setDenyModal(null);
      await fetchWorkflows();
    } catch (e: any) {
      toast.error('Deny failed: ' + e.message);
    }
  };


  const totalPages = Math.ceil(total / pageSize);

  const openWorkflowDetail = (wf: Workflow) => {
    setSelectedWorkflow(wf);
    setLastActiveId(wf.id);
  };

  const handleBuild = async () => {
    // We can't use 'loading' from hook as it's read-only.
    // We should either use a separate loading state or just rely on the hook's refresh.
    try {
      const result = await callRpc<{ success: boolean, count: number }>('orchestrator.workflow.build', {});
      if (result.success) {
        toast.success(`Successfully built ${result.count} workflows to AI snapshot`);
      } else {
        toast.error('Build failed');
      }
    } catch (e: any) {
      toast.error('Build failed: ' + e.message);
    }
  };


  const handleCreate = () => {
    setSelectedWorkflow({
      id: '',
      name: '',
      desc: '',
      category: {},
      priority: 0,
      status: 'ACTIVE',
      steps: [],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvers: {},
      keywords: [],
      prompts: []
    } as any); // Type cast as we are mocking a new object
  };

  const handleExport = async () => {
    try {
      // Fetch all workflows (limit 1000 should cover current usage)
      const res = await callRpc<{ items: Workflow[] }>('orchestrator.workflow.list', { limit: 1000, includeDeleted: false });

      // Filter out metadata fields for clean export
      const cleanItems = res.items.map(({ id, status, createdAt, updatedAt, ...rest }: any) => rest);

      const dataStr = JSON.stringify(cleanItems, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `workflow_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${res.items.length} workflows`);
    } catch (e: any) {
      toast.error('Export failed: ' + e.message);
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const items = JSON.parse(content);
          if (!Array.isArray(items)) throw new Error('Invalid format: root must be array');

          if (!await confirm({
            title: 'Import Workflows',
            message: `Import ${items.length} workflows? Existing IDs will be skipped/overwritten based on logic.`
          })) return;

          let successCount = 0;
          let failCount = 0;

          for (const item of items) {
            try {
              // Try to create first (cleanest for restoration)
              // If it exists, we could try update, or just skip. 
              // For now, let's try create, if it fails with ALREADY_EXISTS, we try Update.
              try {
                // Ensure critical fields
                if (!item.name || !item.steps) continue;
                await callRpc('orchestrator.workflow.create', item);
                successCount++;
              } catch (createErr: any) {
                if (createErr.message.includes('ALREADY_EXISTS') || createErr.message.includes('WORKFLOW_ALREADY_EXISTS')) {
                  // Fallback to update
                  try {
                    await callRpc('orchestrator.workflow.update', item);
                    successCount++;
                  } catch (updateErr) {
                    throw updateErr;
                  }
                } else {
                  throw createErr;
                }
              }
            } catch (err) {
              console.error(`Failed to import ${item.id}:`, err);
              failCount++;
            }
          }

          toast.success(`Import complete: ${successCount} imported, ${failCount} failed`);
          fetchWorkflows(); // Refresh list
        } catch (err: any) {
          toast.error('Import parsing failed: ' + err.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <div className="border border-border bg-bg-primary flex flex-col h-full">
      {/* Title Bar */}
      <div className="px-4 h-[60px] border-b border-border font-bold text-accent bg-white/[0.03] flex justify-between items-center">
        <div className="flex items-center gap-4">
          <span>WORKFLOW REGISTRY</span>
          {/* Category Management Buttons */}
          <div className="flex gap-2">
            {categories.map(cat => (
              <button
                key={cat.key}
                className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 h-6 text-[10px] font-medium hover:bg-[#1f6feb] hover:text-white transition-all opacity-80"
                onClick={() => openCategoryModal(cat)}
              >
                {cat.key}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-4 items-center bg-white/[0.03] px-3 py-1 rounded-md border border-white/5">
          <button className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-1 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all" onClick={handleCreate}>
            + ADD
          </button>
          <button className="bg-accent-dim border border-[#f1e05a]/40 text-[#f1e05a] rounded-md px-2 py-1 text-xs font-medium hover:bg-[#f1e05a]/20 transition-all disabled:opacity-50" onClick={handleBuild} disabled={loading}>
            BUILD & DEPLOY
          </button>
          <div className="w-px h-4 bg-white/10"></div>
          <button
            className="bg-transparent border-none text-base px-2 py-0 hover:opacity-80 transition-opacity"
            onClick={() => { setShowSnapshot(true); fetchSnapshot(); }}
            title="AI Capability Snapshot"
          >
            🕸️
          </button>
          <button
            className="bg-transparent border-none text-base px-2 py-0 hover:opacity-80 transition-opacity"
            onClick={() => { setShowRecycleBin(true); fetchDeletedWorkflows(); }}
            title="Recycle Bin"
          >
            🗑️
          </button>
          <button
            className="bg-transparent border-none text-base px-2 py-0 hover:opacity-80 transition-opacity"
            onClick={() => setShowSigningKey(true)}
            title={t('approval.key_title')}
            data-test="open-signing-key"
          >
            🔑
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {error && (
          <div className={`p-4 ${isServiceError ? 'bg-orange-500/10' : ''}`}>
            <div className={`text-error ${isServiceError ? 'mb-2' : ''}`}>Error: {error}</div>
            {isServiceError && serviceUrl && (
              <div className="p-3 bg-orange-500/15 rounded-md border border-orange-500/30 text-[13px] flex items-center gap-3">
                <span className="text-orange-500">⚠️ 服务未注册，请在 <strong className="text-accent">Service Registry</strong> 添加:</span>
                <code className="bg-black/30 px-2 py-1 rounded text-white">{serviceUrl}</code>
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-2 py-0.5 text-[11px] hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => { navigator.clipboard.writeText(serviceUrl); toast.success('已复制'); }}
                >
                  COPY
                </button>
              </div>
            )}
          </div>
        )}

        {/* Header Row */}
        <div className="grid gap-4 px-5 py-3 border-b-2 border-border bg-bg-secondary font-bold text-accent text-[11px] uppercase tracking-wider sticky top-0 z-10" style={{ gridTemplateColumns: '60px 2fr 0.6fr 0.5fr 0.5fr 0.5fr 0.5fr 0.8fr 1fr 1fr 160px' }}>
          <div>RAW</div>
          <div>NAME</div>
          <div>PRIORITY</div>
          <div>POS</div>
          <div>NEG</div>
          <div>SYN</div>
          <div>STEPS</div>
          <div>STATUS</div>
          <div>CATEGORY</div>
          <div>UPDATED</div>
          <div>ACTION</div>
        </div>

        {/* Data Rows */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-5 text-center opacity-50">Loading...</div>}

          {!loading && workflows.map(wf => (
            <div key={wf.id}>
              <div
                className={`grid gap-4 px-5 border-b border-border items-center h-[52px] hover:bg-white/[0.02] transition-colors border-l-2 ${wf.status === 'DELETED' ? 'opacity-50 border-l-transparent' : wf.id === lastActiveId ? 'bg-accent/10 !border-l-accent' : wf.status === 'PENDING_REVIEW' ? 'border-l-yellow-400/60' : wf.status === 'REJECTED' ? 'border-l-red-400/40' : 'border-l-transparent'}`}
                style={{ gridTemplateColumns: '60px 2fr 0.6fr 0.5fr 0.5fr 0.5fr 0.5fr 0.8fr 1fr 1fr 160px' }}
              >
                <div className="flex items-center">
                  <button
                    className="bg-accent-dim border border-accent/40 text-accent rounded-md text-[11px] px-4 py-1.5 hover:bg-[#1f6feb] hover:text-white transition-all"
                    onClick={(e) => { e.stopPropagation(); setRawJsonWorkflow(wf); }}
                  >
                    RAW
                  </button>
                </div>
                <div
                  onClick={() => openWorkflowDetail(wf)}
                  className="cursor-pointer"
                >
                  <div className="font-semibold text-accent hover:underline">{wf.name}</div>
                  <div className="text-[10px] opacity-60">{wf.desc?.substring(0, 50)}{wf.desc?.length > 50 ? '...' : ''}</div>
                </div>
                <div className="text-[11px]">{wf.priority}</div>
                <div className="text-[11px] text-[#7ee787]">{wf.examples?.length || 0}</div>
                <div className="text-[11px] text-[#ff7b72]">{wf.negative?.length || 0}</div>
                <div className="text-[11px] text-[#a5d6ff]">{Object.keys(wf.synonyms || {}).length}</div>
                <div className="text-[11px]">{wf.steps?.length || 0}</div>
                <div>
                  {wf.status === 'PENDING_REVIEW' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-yellow-400/30 text-yellow-400 bg-yellow-400/10 font-medium">PENDING</span>
                  )}
                  {wf.status === 'ACTIVE' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-green-500/30 text-green-400 bg-green-500/10 font-medium">ACTIVE</span>
                  )}
                  {wf.status === 'REJECTED' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-red-400/30 text-red-400 bg-red-400/10 font-medium" title={wf.denialReason || ''}>REJECTED</span>
                  )}
                  {wf.status === 'DELETED' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-white/10 text-white/30 font-medium">DELETED</span>
                  )}
                </div>
                <div>
                  <span className="bg-white/5 border border-border rounded-xl px-2 py-0.5 text-[11px] text-text-secondary">{typeof wf.category === 'object' ? JSON.stringify(wf.category) : wf.category}</span>
                </div>
                <div className="text-[11px] opacity-60">{formatDate(wf.updatedAt)}</div>
                <div className="flex gap-1 flex-wrap">
                  {wf.status === 'PENDING_REVIEW' && (<>
                    <button
                      data-test={`approve-${wf.id}`}
                      className="bg-green-500/10 border border-green-500/40 text-green-400 rounded-md px-2 py-1 text-[10px] font-medium hover:bg-green-600 hover:text-white transition-all"
                      onClick={(e) => { e.stopPropagation(); handleApprove(wf.id); }}
                    >
                      APPROVE
                    </button>
                    <button
                      className="bg-yellow-500/10 border border-yellow-500/40 text-yellow-400 rounded-md px-2 py-1 text-[10px] font-medium hover:bg-yellow-600 hover:text-white transition-all"
                      onClick={(e) => { e.stopPropagation(); openDenyModal(wf); }}
                    >
                      DENY
                    </button>
                  </>)}
                  <button
                    className="bg-error/10 border border-error/40 text-error rounded-md px-2 py-1 text-[10px] font-medium hover:bg-error hover:text-white transition-all"
                    onClick={(e) => { e.stopPropagation(); handleDelete(wf.id); }}
                  >
                    DEL
                  </button>
                </div>
              </div>
            </div>
          ))}

          {!loading && workflows.length === 0 && (
            <div className="p-6 text-center opacity-50">
              No workflows found.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-bg-secondary flex justify-between items-center">
          <WorkflowIOSection
            onImport={handleImport}
            onExport={handleExport}
          />
          <div className="flex items-center gap-3">
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              PREV
            </button>
            <span className="text-xs text-text-secondary">PAGE {page} OF {totalPages || 1} (TOTAL: {total})</span>
            <button
              className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(page + 1)}
            >
              NEXT
            </button>
          </div>
        </div>
      </div>

      {/* Category Management Modal */}
      {showCatModal && selectedCategory && (
        <CategoryManager
          category={selectedCategory}
          onClose={() => setShowCatModal(false)}
          onUpdate={fetchCategories}
          servicePrefix="orchestrator"
        />
      )}

      {/* Workflow Detail Modal */}
      {selectedWorkflow && (
        <WorkflowDetailModal
          workflow={selectedWorkflow}
          onClose={() => setSelectedWorkflow(null)}
          onUpdate={async () => {
            await fetchWorkflows();
          }}
        />
      )}

      {/* RAW JSON Modal */}
      {rawJsonWorkflow && (
        <WorkflowRawJsonModal
          workflow={rawJsonWorkflow}
          onClose={() => setRawJsonWorkflow(null)}
        />
      )}

      {/* Recycle Bin Modal */}
      {showRecycleBin && (
        <WorkflowRecycleBinModal
          loading={deletedLoading}
          workflows={deletedWorkflows}
          onClose={() => setShowRecycleBin(false)}
          onRestore={handleRestore}
          onRefresh={fetchDeletedWorkflows}
        />
      )}

      {/* Snapshot Modal */}
      {showSnapshot && (
        <WorkflowSnapshotModal
          loading={snapshotLoading}
          workflows={snapshotWorkflows}
          timestamp={snapshotTimestamp}
          onClose={() => setShowSnapshot(false)}
        />
      )}

      {/* §3.3 — Approval review + sign-off */}
      {reviewId && (
        <ApprovalReviewModal
          workflowId={reviewId}
          onClose={() => setReviewId(null)}
          onDone={fetchWorkflows}
        />
      )}

      {/* §3.2 — Signing key setup/management */}
      {showSigningKey && <SigningKeyModal onClose={() => setShowSigningKey(false)} />}

      {/* Deny Reason Modal */}
      {denyModal && (
        <div className="fixed inset-0 bg-black/70 flex justify-center items-center z-[9999]">
          <div className="w-[480px] bg-bg-primary border border-border shadow-[0_8px_24px_rgba(0,0,0,0.5)] rounded-lg">
            <div className="px-4 py-3 border-b border-border font-bold text-error">
              DENY WORKFLOW
            </div>
            <div className="p-4">
              <p className="mb-3 text-sm text-text-primary">
                Deny <strong className="text-accent">{denyModal.name}</strong>? This moves it to REJECTED status.
              </p>
              <label className="block text-[10px] text-text-secondary mb-1.5 uppercase tracking-wider font-bold">
                Reason (required)
              </label>
              <textarea
                className="w-full bg-bg-secondary border border-border rounded-md px-3 py-2 text-sm text-text-primary resize-none focus:outline-none focus:border-accent/60"
                rows={3}
                placeholder="Explain why this workflow is being denied..."
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-3 mt-4">
                <button
                  className="bg-accent-dim border border-accent/40 text-accent rounded-md px-3 py-1.5 text-xs font-medium hover:bg-[#1f6feb] hover:text-white transition-all"
                  onClick={() => setDenyModal(null)}
                >
                  CANCEL
                </button>
                <button
                  className="bg-error/10 border border-error/40 text-error rounded-md px-3 py-1.5 text-xs font-medium hover:bg-error hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleDenyConfirm}
                  disabled={!denyReason.trim()}
                >
                  DENY WORKFLOW
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
