import { LAYOUT_STORAGE_KEY, DEFAULT_LAYOUT, DEFAULT_ROW_HEIGHT } from '../constants';

export function saveLayout(fields, rowHeight) {
  const data = {
    width: 1176,
    height: 832,
    rowHeight: rowHeight || DEFAULT_ROW_HEIGHT,
    fields: fields.map(f => ({
      mapping: f.mapping,
      label: f.label || f.mapping,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height
    }))
  };
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data));
}

export function loadSavedLayout() {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return { width: 1176, height: 832, rowHeight: DEFAULT_ROW_HEIGHT, fields: parsed };
      }
      if (parsed.rowHeight === undefined) parsed.rowHeight = DEFAULT_ROW_HEIGHT;
      return parsed;
    } catch (e) {
      console.error('Failed to parse saved layout', e);
    }
  }
  
  const defaultData = { width: 1176, height: 832, rowHeight: DEFAULT_ROW_HEIGHT, fields: DEFAULT_LAYOUT };
  saveLayout(DEFAULT_LAYOUT, DEFAULT_ROW_HEIGHT);
  return defaultData;
}
