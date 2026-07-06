import { useState, useEffect } from 'react';
import { callRpc } from '../utils/rpc';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';

import type { CategoryItem, CategoryConfig } from '../types';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';

interface CategoryManagerProps {
  category: CategoryConfig;
  onClose: () => void;
  onUpdate: () => void;
  servicePrefix?: string; // Default: 'user'
}

export default function CategoryManager({ category, onClose, onUpdate, servicePrefix = 'user' }: CategoryManagerProps) {
  const { toast, confirm } = useUI();
  const { lang } = useLang();
  const [items, setItems] = useState<CategoryItem[]>([]);
  const [newItemName, setNewItemName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ labelZh: '', labelEn: '', desc: '' });
  const [loading, setLoading] = useState(false);
  const [workflowUsage, setWorkflowUsage] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchItems();
  }, [category.key]);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const freshCat = await callRpc<CategoryConfig>(`${servicePrefix}.category.get`, { key: category.key });
      setItems(freshCat.items || []);

      // Fetch workflow usage if this is orchestrator category
      if (servicePrefix === 'orchestrator' && category.key === 'TYPE') {
        await fetchWorkflowUsage(freshCat.items || []);
      }
    } catch (e: any) {
      toast.error('Failed to load items: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchWorkflowUsage = async (categoryItems: CategoryItem[]) => {
    try {
      const result = await callRpc<{ items: { category: string }[] }>('orchestrator.workflow.list', {});
      const workflows = result.items || [];
      const usage: Record<string, number> = {};

      categoryItems.forEach(item => {
        usage[item.id] = workflows.filter(wf => wf.category === item.id).length;
      });

      setWorkflowUsage(usage);
    } catch (e) {
      console.warn('Failed to fetch workflow usage', e);
    }
  };

  // Generate ID from name (lowercase, underscore)
  const generateId = (name: string) => {
    return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  };

  const handleCreate = async () => {
    if (!newItemName.trim()) return;

    const id = generateId(newItemName);
    if (items.some(i => i.id === id)) {
      toast.error('Item with this ID already exists');
      return;
    }

    try {
      await callRpc(`${servicePrefix}.category.item.add`, {
        key: category.key,
        id,
        label: { zh: newItemName, en: newItemName },
        desc: ''
      });
      setNewItemName('');
      await fetchItems();
      onUpdate();
      toast.success('Item created');
    } catch (e: any) {
      toast.error('Create failed: ' + e.message);
    }
  };

  const handleExpand = (item: CategoryItem) => {
    if (expandedId === item.id) {
      setExpandedId(null);
    } else {
      setExpandedId(item.id);
      const labelObj = typeof item.label === 'object' ? item.label : { zh: String(item.label), en: String(item.label) };
      setEditForm({
        labelZh: (labelObj as Record<string, string>).zh || '',
        labelEn: (labelObj as Record<string, string>).en || '',
        desc: item.desc || ''
      });
    }
  };

  const handleUpdate = async (itemId: string) => {
    try {
      await callRpc(`${servicePrefix}.category.item.update`, {
        key: category.key,
        id: itemId,
        label: { zh: editForm.labelZh, en: editForm.labelEn },
        desc: editForm.desc
      });
      setExpandedId(null);
      await fetchItems();
      onUpdate();
      toast.success('Item updated');
    } catch (e: any) {
      toast.error('Update failed: ' + e.message);
    }
  };

  const handleDelete = async (itemId: string) => {
    // Check if category is in use by workflows
    const usageCount = Number(workflowUsage[itemId]) || 0;
    if (usageCount > 0) {
      toast.error(`Cannot delete: ${usageCount} workflow(s) are using this category`);
      return;
    }

    const isConfirmed = await confirm({
      message: 'Delete this item?',
      confirmLabel: 'DELETE',
      isDangerous: true
    });
    if (!isConfirmed) return;

    try {
      await callRpc(`${servicePrefix}.category.item.remove`, {
        key: category.key,
        id: itemId
      });
      setExpandedId(null);
      await fetchItems();
      onUpdate();
      toast.success('Item deleted');
    } catch (e: any) {
      toast.error('Delete failed: ' + e.message);
    }
  };

  const getLabel = (item: CategoryItem) => {
    if (typeof item.label === 'object') {
      return (item.label as Record<string, string>)[lang] || (item.label as Record<string, string>).en || item.id;
    }
    return String(item.label);
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={category.key}
      size="md"
    >
      <div className="flex flex-col h-[60vh]">
        {/* Create Section */}
        <div className="flex gap-2">
          <Input
            placeholder="New item name..."
            value={newItemName}
            onChange={e => setNewItemName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            className="flex-1"
          />
          <Button
            onClick={handleCreate}
            disabled={!newItemName.trim() || loading}
            variant="primary"
          >
            CREATE
          </Button>
        </div>

        {/* Items List */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-2 no-scrollbar">
          {loading && <div className="py-10 text-center opacity-50 text-sm">Loading...</div>}

          {!loading && items.map(item => (
            <div key={item.id} className={`
              overflow-hidden rounded-lg border transition-all duration-200
              ${expandedId === item.id
                ? 'bg-bg-secondary/30 border-accent/50 shadow-lg'
                : 'bg-white/5 border-transparent hover:bg-white/10'}
            `}>
              {/* Collapsed Row */}
              <div
                onClick={() => handleExpand(item)}
                className="p-3 cursor-pointer flex justify-between items-center group"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{getLabel(item)}</span>
                  <span className="text-[10px] font-mono opacity-40 group-hover:opacity-60">{item.id}</span>
                  {workflowUsage[item.id] > 0 && (
                    <span className="px-2 py-0.5 bg-accent/20 text-accent rounded-full text-[10px] font-medium">
                      {workflowUsage[item.id]} workflow{workflowUsage[item.id] > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <span className={`text-xs opacity-30 transition-transform duration-200 ${expandedId === item.id ? 'rotate-180' : ''}`}>
                  ▼
                </span>
              </div>

              {/* Expanded Edit Form */}
              {expandedId === item.id && (
                <div className="p-3 border-t border-border/50 bg-black/20 animate-in slide-in-from-top-1 duration-200">
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Label (中文)</label>
                      <Input
                        value={editForm.labelZh}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(prev => ({ ...prev, labelZh: e.target.value }))}
                        size="sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Label (English)</label>
                      <Input
                        value={editForm.labelEn}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(prev => ({ ...prev, labelEn: e.target.value }))}
                        size="sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-1 mb-4">
                    <label className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Description</label>
                    <Input
                      value={editForm.desc}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditForm(prev => ({ ...prev, desc: e.target.value }))}
                      placeholder="Optional description for AI context..."
                      size="sm"
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleDelete(item.id)}
                      className="!h-7"
                    >
                      DELETE
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleUpdate(item.id)}
                      className="!h-7 px-4"
                    >
                      SAVE
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {!loading && items.length === 0 && (
            <div className="py-20 text-center opacity-30 text-sm italic">
              No items yet. Create one above.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
