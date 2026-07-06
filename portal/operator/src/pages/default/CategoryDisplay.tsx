import { useState, useEffect } from 'react';
import { callRpc } from '../../utils/rpc';

interface CategoryItem {
  id: string;
  label: Record<string, string>;
  color?: string;
}

interface CategoryDefinition {
  key: string;
  items: CategoryItem[];
}

// Global cache for category definitions to avoid redundant RPC calls
const categoryCache: Record<string, CategoryDefinition> = {};
const pendingRequests: Record<string, Promise<CategoryDefinition>> = {};

async function fetchCategoryDefinition(key: string): Promise<CategoryDefinition> {
  if (categoryCache[key]) return categoryCache[key];
  if (key in pendingRequests) return pendingRequests[key];

  pendingRequests[key] = (async () => {
    try {
      // 1. Locate the owner service
      const locateRes = await callRpc<any>('system.category.locate', { key });
      const { ownerService } = locateRes;
      
      if (!ownerService) throw new Error(`Category ${key} not found`);

      // 2. Fetch items from owner service
      // According to protocol, we call [service].category.get
      const categoriesRes = await callRpc<any>(`${ownerService}.category.get`, { key });
      
      const definition = {
        key,
        items: categoriesRes.items || []
      };
      
      categoryCache[key] = definition;
      return definition;
    } catch (err: any) {
      const isNotFound = err.message?.includes('404') || err.message?.toLowerCase().includes('not found');
      if (!isNotFound) {
        console.error(`Failed to resolve category ${key}:`, err);
      }
      return { key, items: [] };
    } finally {
      delete pendingRequests[key];
    }
  })();

  return pendingRequests[key];
}

interface CategoryDisplayProps {
  categories: Record<string, string>;
}

export function CategoryDisplay({ categories }: CategoryDisplayProps) {
  const [resolvedLabels, setResolvedLabels] = useState<Record<string, string>>({});

  // `categories` is a fresh object on every parent render (it's a row's field value), so
  // depending on it directly re-runs the resolve (Promise.all of RPCs) on each re-render.
  // Key the effect on a stable serialization instead.
  const categoriesKey = JSON.stringify(categories || {});

  useEffect(() => {
    const keys = Object.keys(categories || {});
    if (keys.length === 0) return;

    let isMounted = true;

    const resolveAll = async () => {
      const newLabels: Record<string, string> = {};
      
      await Promise.all(keys.map(async (key) => {
        const val = categories[key];
        const def = await fetchCategoryDefinition(key);
        const item = def.items.find(i => i.id === val);
        
        // Use zh label by default, fallback to en, then fallback to value itself
        if (item) {
          newLabels[key] = item.label?.zh || item.label?.en || val;
        } else {
          newLabels[key] = val;
        }
      }));

      if (isMounted) {
        setResolvedLabels(newLabels);
      }
    };

    resolveAll();
    return () => { isMounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriesKey]);

  if (!categories || Object.keys(categories).length === 0) return <span>-</span>;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {Object.entries(categories).map(([key, val]) => (
        <span 
          key={key}
          title={`${key}: ${val}`}
          style={{
            background: '#f1f5f9',
            color: '#475569',
            fontSize: '11px',
            padding: '2px 6px',
            borderRadius: '4px',
            border: '1px solid #e2e8f0',
            fontWeight: 500
          }}
        >
          {resolvedLabels[key] || '...'}
        </span>
      ))}
    </div>
  );
}
