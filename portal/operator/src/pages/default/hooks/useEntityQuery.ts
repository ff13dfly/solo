import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { callRpc } from '../../../utils/rpc';

interface FetchParams {
  serviceId: string;
  activeEntity: string;
  page: number;
  pageSize: number;
  keyword: string;
  categoryId?: string;
  source?: string;
  boundFilter?: string;
}

export function useEntityQuery({ serviceId, activeEntity, page, pageSize, keyword, categoryId, source, boundFilter }: FetchParams) {
  // Debounce the free-text keyword: typing fires at most one .list RPC per pause instead of
  // one per keystroke. page / filters stay immediate. All consumers (default + storage) benefit.
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => clearTimeout(id);
  }, [keyword]);

  return useQuery({
    queryKey: ['entities', serviceId, activeEntity, page, pageSize, debouncedKeyword, categoryId, source, boundFilter],
    queryFn: async () => {
      if (!serviceId || !activeEntity) return { items: [], total: 0 };

      const payload: any = {
        page,
        pageSize,
        offset: (page - 1) * pageSize,
        limit: pageSize,
        keyword: debouncedKeyword,
        query: debouncedKeyword,
        includeDeleted: false
      };

      if (categoryId) {
        payload.categoryId = categoryId;
      }

      if (source) {
        payload.source = source;
      }

      if (boundFilter) {
        payload.boundFilter = boundFilter;
      }

      const res = await callRpc<{ items: any[], total: number }>(`${serviceId}.${activeEntity}.list`, payload);

      return {
        items: res.items || [],
        total: res.total || 0,
      };
    },
    enabled: !!serviceId && !!activeEntity,
  });
}
