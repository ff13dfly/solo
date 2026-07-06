
import { useState, useEffect } from 'react';
import { useCapabilities } from '../../../hooks/useCapabilities';
import { useUI } from '../../../providers/UIProvider';

interface CategoryParamEditorProps {
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
}

interface CategoryKeyDef {
  key: string;
  owner: string;
  desc?: string;
}

interface CategoryItem {
  id: string;
  label: any;
}

export default function CategoryParamEditor({ value, onChange }: CategoryParamEditorProps) {
  const { fetchCategoryKeys, fetchCategoryItems } = useCapabilities();
  const { toast } = useUI();
  
  // Default to Raw Mode (JSON Input)
  const [isRawMode, setIsRawMode] = useState(true);
  const [rawText, setRawText] = useState('');

  // Registry State
  const [keys, setKeys] = useState<CategoryKeyDef[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  
  // Visual Selection State
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedItem, setSelectedItem] = useState('');
  const [availableItems, setAvailableItems] = useState<CategoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Sync raw text with value when value changes externally
  useEffect(() => {
    setRawText(JSON.stringify(value));
  }, [value]);

  // Handle Items fetching for Visual Mode
  useEffect(() => {
    if (!selectedKey) {
      setAvailableItems([]);
      return;
    }
    
    const def = keys.find(k => k.key === selectedKey);
    if (def) {
      setLoadingItems(true);
      fetchCategoryItems(def.owner, def.key).then(items => {
        setAvailableItems(Array.isArray(items) ? items : []);
        setLoadingItems(false);
      });
    }
  }, [selectedKey, keys, fetchCategoryItems]);

  const handleManualSwitchToVisual = async () => {
    // 1. Try to fetch registry
    setLoadingKeys(true);
    try {
      const list = await fetchCategoryKeys();
      const safeList = Array.isArray(list) ? list : [];
      
      if (safeList.length > 0) {
        // 2. Validate that current keys exist in the registry
        let currentObj = value;
        try {
             if (rawText.trim()) {
                 const parsed = JSON.parse(rawText);
                 if (typeof parsed === 'object' && parsed) currentObj = parsed;
             } else {
                 currentObj = {};
             }
        } catch (e) {
             toast.error("Invalid JSON content");
             setLoadingKeys(false);
             return;
        }

        const currentKeys = Object.keys(currentObj);
        const missingKeys = currentKeys.filter(k => !safeList.find(def => def.key === k));

        if (missingKeys.length > 0) {
             toast.error(`Cannot switch: Registry missing keys [${missingKeys.join(', ')}]`);
        } else {
             setKeys(safeList);
             setIsRawMode(false); // Enable Visual Mode
             toast.success(`Connected to Registry (${safeList.length} categories)`);
        }
      } else {
        toast.error('Registry is empty or unavailable');
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to connect to Registry');
    } finally {
      setLoadingKeys(false);
    }
  };

  const handleAdd = () => {
    if (selectedKey && selectedItem) {
      onChange({
        ...value,
        [selectedKey]: selectedItem
      });
      // Reset selection
      setSelectedKey('');
      setSelectedItem('');
      setAvailableItems([]);
    }
  };

  const handleRemove = (keyToRemove: string) => {
    const next = { ...value };
    delete next[keyToRemove];
    onChange(next);
  };

  const handleRawChange = (text: string) => {
    setRawText(text);
    try {
      if (!text.trim()) {
         onChange({});
      } else {
         const obj = JSON.parse(text);
         if (typeof obj === 'object' && obj !== null) {
            onChange(obj);
         }
      }
    } catch (e) {
      // Invalid JSON, ignore
    }
  };

  const inputStyle = {
    padding: '4px 8px',
    background: '#1c2128',
    border: '1px solid #444',
    borderRadius: '4px',
    color: 'white',
    fontSize: '11px',
    width: '100%'
  };

  if (isRawMode) {
     return (
        <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
           <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
               <input
                  type="text"
                  value={rawText}
                  onChange={e => handleRawChange(e.target.value)}
                  style={{ ...inputStyle, fontFamily: 'monospace', flex: 1 }}
                  placeholder='{"role": "employee"}'
               />
               <button 
                  onClick={handleManualSwitchToVisual}
                  disabled={loadingKeys}
                  style={{ 
                    background: loadingKeys ? '#444' : '#3b82f6', 
                    border: 'none', 
                    color: 'white', 
                    cursor: loadingKeys ? 'not-allowed' : 'pointer', 
                    fontSize: '10px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                    height: '24px' // Match input height roughly
                  }}
                  title="Check against Registry and Switch to Visual Mode"
               >
                  {loadingKeys ? '...' : 'Check'}
               </button>
           </div>
        </div>
     );
  }

  // Visual Mode
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
      {/* Header with switch back */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
        <button 
            onClick={() => setIsRawMode(true)}
            style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '9px', padding: 0 }}
        >
            Switch to JSON
        </button>
      </div>

      {/* Existing Categories List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: Object.keys(value || {}).length ? '8px' : '0' }}>
        {Object.entries(value || {}).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
            <span style={{ color: '#f59e0b', width: '80px', textAlign: 'right' }}>{k}:</span>
            <span style={{ flex: 1, fontFamily: 'monospace' }}>
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </span>
            <button 
              onClick={() => handleRemove(k)}
              style={{ border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', opacity: 0.8 }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Add New Row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', borderTop: '1px dashed #444', paddingTop: '8px' }}>
        {/* Key Selector */}
        <select 
          value={selectedKey} 
          onChange={e => setSelectedKey(e.target.value)}
          style={{ ...inputStyle, width: '100px' }}
        >
          <option value="">+ Dimension...</option>
          {keys.filter(k => !value[k.key]).map(k => (
            <option key={k.key} value={k.key}>{k.key}</option>
          ))}
        </select>

        {/* Item Selector */}
        <select
          value={selectedItem}
          onChange={e => setSelectedItem(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
          disabled={!selectedKey || loadingItems}
        >
          <option value="">{loadingItems ? 'Loading...' : '-- Select Value --'}</option>
          {availableItems.map(item => (
            <option key={item.id} value={item.id}>
              {typeof item.label === 'string' ? item.label : (item.label?.zh || item.id)} ({item.id})
            </option>
          ))}
        </select>

        <button
          onClick={handleAdd}
          disabled={!selectedKey || !selectedItem}
          style={{ 
            background: '#f59e0b', 
            color: 'black', 
            border: 'none', 
            borderRadius: '4px', 
            width: '24px', 
            height: '24px',
            cursor: 'pointer',
            opacity: (!selectedKey || !selectedItem) ? 0.5 : 1
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}
