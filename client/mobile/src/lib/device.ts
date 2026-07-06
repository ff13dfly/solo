export function isMobile(): boolean {
  // Allow bypass for E2E testing or when running in a simulator iframe
  if (typeof window !== 'undefined') {
    if (localStorage.getItem('e2e_bypass_mobile_check') === 'true' || window.self !== window.top) {
      return true;
    }
  }

  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  
  // Checks for iOS, Android, Windows Phone, etc.
  if (/android/i.test(userAgent)) return true;
  if (/iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream) return true;
  if (/windows phone/i.test(userAgent)) return true;
  
  // Also check for mobile dimensions as a fallback/secondary check?
  // But requirement says "force detect device". UA is the standard way.
  // We can also allow dev mode bypass if needed, but for now strict.
  
  return false;
}
