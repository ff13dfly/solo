import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';
import { useUI } from '../../providers/UIProvider';
import { useLang } from '../../providers/LanguageProvider';
import { Button } from '../../components/ui';
import './DefaultPage.css';

interface CategoryItem {
  id: string;
  label: Record<string, string>;
  parentId: string | null;
  desc?: string;
}

interface Category {
  key: string;
  owner: string;
  scope: string;
  type: string;
  status: string;
  desc?: string;
  items?: CategoryItem[];
}

interface CategoryManagerProps {
  serviceId: string;
}

export function CategoryManager({ serviceId }: CategoryManagerProps) {
  const { toast } = useUI();
  const { t } = useLang();
  const [categories, setCategories] = useState<Category[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingItems, setEditingItems] = useState<CategoryItem[]>([]);

  // Form states
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');
  
  // Item Edit states
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [itemEditForm, setItemEditForm] = useState({ zh: '', en: '', desc: '' });
  const [newItemName, setNewItemName] = useState('');
  const [erpSyncing, setErpSyncing] = useState(false);

  const fetchCategories = async () => {
    try {
      const res = await callRpc<any>(`${serviceId}.category.list`, {});
      setCategories(Array.isArray(res) ? res : res.items || []);
    } catch (err: any) {
      // Silently handle 404 (Method Not Found) errors as categories are optional
      const isNotFound = err.message?.includes('404') || err.message?.toLowerCase().includes('not found');
      if (!isNotFound) {
        console.error('Failed to fetch categories:', err);
      }
      setCategories([]);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, [serviceId]);

  const handleCreate = async () => {
    if (!newKey) return;
    try {
      await callRpc(`${serviceId}.category.create`, {
        key: newKey.toUpperCase(),
        desc: newDesc,
        type: 'TREE',
        scope: 'GLOBAL'
      });
      setShowCreateModal(false);
      setNewKey('');
      setNewDesc('');
      fetchCategories();
    } catch (err: any) {
      toast.error(t('category.err_create', { msg: err.message }));
    }
  };

  const handleEditCategory = async (cat: Category) => {
    setEditingCategory(cat);
    try {
      const res = await callRpc<any>(`${serviceId}.category.get`, { key: cat.key });
      setEditingItems(res.items || []);
    } catch (err: any) {
      const isNotFound = err.message?.includes('404') || err.message?.toLowerCase().includes('not found');
      if (!isNotFound) {
        console.error('Failed to get items:', err);
      }
      setEditingItems([]);
    }
  };

  const handleAddItem = async () => {
    if (!editingCategory || !newItemName.trim()) return;
    
    try {
      const id = newItemName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      await callRpc(`${serviceId}.category.item.add`, {
        key: editingCategory.key,
        id,
        label: { zh: newItemName, en: newItemName },
        desc: ''
      });
      setNewItemName('');
      handleEditCategory(editingCategory);
    } catch (err: any) {
      toast.error(`Add failed: ${err.message}`);
    }
  };

  const handleUpdateItem = async (itemId: string) => {
    if (!editingCategory) return;
    try {
      await callRpc(`${serviceId}.category.item.update`, {
        key: editingCategory.key,
        id: itemId,
        label: { zh: itemEditForm.zh, en: itemEditForm.en },
        desc: itemEditForm.desc
      });
      setExpandedItemId(null);
      handleEditCategory(editingCategory);
    } catch (err: any) {
      toast.error(`Update failed: ${err.message}`);
    }
  };

  const toggleExpand = (item: CategoryItem) => {
    if (expandedItemId === item.id) {
      setExpandedItemId(null);
    } else {
      setExpandedItemId(item.id);
      setItemEditForm({
        zh: item.label?.zh || '',
        en: item.label?.en || '',
        desc: item.desc || ''
      });
    }
  };

  const handleErpClassSync = async () => {
    if (!editingCategory) return;
    setErpSyncing(true);
    try {
      const classResult = await callRpc<any>('erp.stock.class.query', {});
      const classes = Array.isArray(classResult?.items) ? classResult.items : [];
      const allCodes = new Set(classes.map((c: any) => c.Code as string));

      // Infer parentId from code prefix (3-level: E → EA → EA01)
      const inferParent = (code: string): string | null => {
        if (code.length <= 1) return null;
        // Try progressively shorter prefixes until one exists in the set
        for (let len = code.length - 1; len >= 1; len--) {
          const prefix = code.slice(0, len);
          if (allCodes.has(prefix)) return prefix;
        }
        return null;
      };

      const items = classes.map((c: any) => ({
        id: c.Code,
        label: { zh: c.Name || c.Code },
        parentId: inferParent(c.Code),
      }));

      const result = await callRpc<any>(`${serviceId}.category.item.sync`, { key: editingCategory.key, items });
      toast.success(t('category.sync_success', { added: result.added, updated: result.updated }));
      handleEditCategory(editingCategory);
    } catch (err: any) {
      toast.error(t('category.err_sync', { msg: err.message }));
    } finally {
      setErpSyncing(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!editingCategory) return;
    try {
      await callRpc(`${serviceId}.category.item.remove`, {
        key: editingCategory.key,
        id: itemId
      });
      handleEditCategory(editingCategory);
    } catch (err: any) {
      toast.error(`Remove failed: ${err.message}`);
    }
  };

  return (
    <div className="category-manager-container">
      <span className="category-title-badge">
        {t('default.title_categories')}
      </span>

      <div className="category-pill-list">
        {categories.map(cat => (
          <Button
            key={cat.key}
            variant="secondary"
            size="sm"
            onClick={() => handleEditCategory(cat)}
            className="category-pill-btn"
            icon={<span style={{ opacity: 0.5 }}>#</span>}
          >
            {cat.key}
          </Button>
        ))}

        <Button
          variant="tonal"
          size="sm"
          pill
          onClick={() => setShowCreateModal(true)}
          icon={<span style={{ fontSize: '14px', lineHeight: 1, fontWeight: 700 }}>+</span>}
        >
          {t('default.btn_add')}
        </Button>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="modal-overlay" style={{ zIndex: 1000 }} onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: '400px' }}>
            <div className="modal-header">
              <h3>{t('default.modal_create_title')}</h3>
              <button className="close-btn" onClick={() => setShowCreateModal(false)}>×</button>
            </div>
            <div className="modal-content" style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>{t('default.label_category_key')}</label>
                <input 
                  type="text" 
                  value={newKey} 
                  onChange={e => setNewKey(e.target.value)} 
                  placeholder={t('default.placeholder_category_key')}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>{t('default.label_description')}</label>
                <textarea 
                  value={newDesc} 
                  onChange={e => setNewDesc(e.target.value)} 
                  style={{ height: '80px' }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <Button variant="secondary" onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={handleCreate}>{t('common.confirm')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Items Modal */}
      {editingCategory && (
        <div className="modal-overlay" style={{ zIndex: 1000 }} onClick={() => setEditingCategory(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: '500px', height: '70vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, whiteSpace: 'nowrap' }}>{t('default.modal_edit_title', { key: editingCategory.key })}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                {editingCategory.key === 'PRODUCT_CATEGORY' && (
                  <button
                    onClick={handleErpClassSync}
                    disabled={erpSyncing}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '4px',
                      padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
                      border: '1px solid #10b981', color: erpSyncing ? '#a7f3d0' : '#10b981',
                      background: 'transparent', cursor: erpSyncing ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    {erpSyncing ? t('default.btn_syncing') : t('default.btn_sync_erp')}
                  </button>
                )}
                <button className="close-btn" onClick={() => setEditingCategory(null)}>×</button>
              </div>
            </div>
            <div className="modal-content" style={{ padding: '20px', flex: 1, overflowY: 'auto' }}>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    placeholder={t('default.placeholder_item_name')} 
                    value={newItemName}
                    onChange={e => setNewItemName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddItem()}
                    style={{ flex: 1, fontSize: '13px' }}
                  />
                  <Button
                    variant={newItemName.trim() ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={handleAddItem}
                    disabled={!newItemName.trim()}
                  >
                    + {t('default.btn_add_item')}
                  </Button>
                </div>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {editingItems.length === 0 && <div style={{ textAlign: 'center', color: '#94a3b8', padding: '20px' }}>{t('default.no_items')}</div>}
                {editingItems.map(item => (
                  <div key={item.id} className={`category-item-card${expandedItemId === item.id ? ' expanded' : ''}`}>
                    <div 
                      onClick={() => toggleExpand(item)}
                      className="category-item-header"
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '13px' }}>{item.label?.zh || item.id}</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>{item.id}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '12px', opacity: 0.5 }}>{expandedItemId === item.id ? '▲' : '▼'}</span>
                      </div>
                    </div>

                    {expandedItemId === item.id && (
                      <div className="category-item-form">
                        <div style={{ display: 'flex', gap: '10px' }}>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('default.label_label_zh')}</label>
                            <input
                              type="text"
                              value={itemEditForm.zh}
                              onChange={e => setItemEditForm(prev => ({ ...prev, zh: e.target.value }))}
                              style={{ width: '100%', fontSize: '13px' }}
                            />
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('default.label_label_en')}</label>
                            <input
                              type="text"
                              value={itemEditForm.en}
                              onChange={e => setItemEditForm(prev => ({ ...prev, en: e.target.value }))}
                              style={{ width: '100%', fontSize: '13px' }}
                            />
                          </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('default.label_description')}</label>
                          <textarea
                            value={itemEditForm.desc}
                            onChange={e => setItemEditForm(prev => ({ ...prev, desc: e.target.value }))}
                            rows={2}
                            style={{ width: '100%', fontSize: '13px', resize: 'none', fontFamily: 'inherit' }}
                          />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '4px' }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveItem(item.id)}
                            style={{ color: '#ef4444' }}
                          >
                            {t('default.btn_delete_item')}
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleUpdateItem(item.id)}
                          >
                            {t('default.btn_save_changes')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
