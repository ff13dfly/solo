export function transformExcelData(rawData) {
  if (!Array.isArray(rawData) || rawData.length === 0) return [];

  const groups = {};
  
  // 1. Identify valid data rows
  const dataRows = rawData.filter(row => {
    const val = String(row['创建时间'] || row['__EMPTY_14'] || '').trim();
    return val && val !== '创建时间' && val !== '单据日期' && val.includes('202');
  });

  if (dataRows.length === 0) return [];

  dataRows.forEach((row) => {
    const timeKey = row['创建时间'] || row['__EMPTY_14'];
    if (!timeKey) return;

    if (!groups[timeKey]) {
      groups[timeKey] = {
        id: timeKey,
        common: {}, // Header/Common fields
        items: [],  // Repeating product fields
        summary: {
          totalQuantity: 0,
          totalAmount: 0,
          totalVolume: 0
        }
      };
    }

    // 2. Extract item-specific data
    const quantity = parseFloat(row['数量'] || row['__EMPTY_25'] || 0);
    const amount = parseFloat(row['金额'] || row['__EMPTY_30'] || 0);
    const volume = parseFloat(row['总体积'] || row['__EMPTY_32'] || 0);

    const item = {
      sku: row['存货编码'] || row['__EMPTY_1'],
      name: row['中文名称'] || row['__EMPTY_10'],
      spec: row['中包规格'] || row['__EMPTY_22'],
      quantity,
      unit: row['采购单位'] || row['__EMPTY_24'],
      price: row['单价'] || row['__EMPTY_29'],
      amount,
      volume
    };

    // Also copy all __EMPTY_... keys for robustness in mapping if needed later
    Object.keys(row).forEach(key => {
      if (key.startsWith('__EMPTY_')) {
        item[key] = row[key];
      }
    });

    groups[timeKey].items.push(item);

    // 3. Update Summary
    groups[timeKey].summary.totalQuantity += quantity;
    groups[timeKey].summary.totalAmount += amount;
    groups[timeKey].summary.totalVolume += volume;

    // 4. On first row of group, also capture 'common' fields (Header)
    if (groups[timeKey].items.length === 1) {
      const COMMON_KEYS = [
        '创建时间', '单据日期', '合同号', '业务员名字', '供应商', '厂家', 
        '__EMPTY_14', '__EMPTY_3', '__EMPTY_18', '__EMPTY_2'
      ];
      COMMON_KEYS.forEach(k => {
        if (row[k] !== undefined) {
          groups[timeKey].common[k] = row[k];
        }
      });
      // Fallback: anything not in item might be common? 
      // Actually, let's just use the explicit common keys for now.
    }
  });

  return Object.values(groups).sort((a, b) => 
    new Date(b.id).getTime() - new Date(a.id).getTime()
  );
}
