export const formatDate = (val: string | number | undefined | null) => {
  if (!val) return '-';
  try {
    return new Date(val).toLocaleString();
  } catch (e) {
    return String(val);
  }
};
