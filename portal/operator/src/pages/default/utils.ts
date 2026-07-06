export function renderValue(val: any, type: string) {
  if (val === null || val === undefined) return '-';
  if (type === 'datetime' || (typeof val === 'number' && val > 1000000000000)) {
    const d = new Date(val);
    const date = d.toLocaleDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${date} ${time}`;
  }
  if (type === 'boolean') {
    return val ? 'YES' : 'NO';
  }
  if (Array.isArray(val)) {
    return val.join(', ');
  }
  if (typeof val === 'object') {
    return '{...}';
  }
  return String(val);
}

export function stripPrefix(name: string, prefix?: string) {
  if (!prefix) return name;
  const p = `${prefix}_`.toLowerCase();
  if (name.toLowerCase().startsWith(p)) {
    return name.slice(p.length);
  }
  return name;
}
