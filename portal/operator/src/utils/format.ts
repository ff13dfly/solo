/**
 * formatDateTime
 * @why Standardized date-time formatting.
 */
export const formatDateTime = (date: string | number | Date | undefined | null): string => {
    if (!date) return '-';
    try {
        const d = new Date(date);
        return d.toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    } catch (e) {
        return String(date);
    }
};

/**
 * copyToClipboard
 * @why Centralized clipboard helper with error handling.
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        return false;
    }
};
