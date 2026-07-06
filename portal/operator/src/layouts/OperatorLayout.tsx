import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { clearSession, getSessionUser } from '../utils/auth';
import { useUI } from '../providers/UIProvider';
import { useLang } from '../providers/LanguageProvider';
import { useServices } from '../providers/ServicesProvider';
import { NON_DISCOVERABLE_SERVICES, ExtensionRegistry } from '../ExtensionRegistry';
import { getCurrentRouterUrl } from '../utils/routerManager';
import { IconButton } from '../components/ui';

// ── Icon Map ─────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ReactNode> = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>,
  qr: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><rect x="14" y="14" width="3" height="3"/></svg>,
  product: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  group: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
  brand: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  category: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  default: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
};

export default function OperatorLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm, isCollapsed, setIsCollapsed } = useUI();
  const { t, lang, setLang } = useLang();
  const { services } = useServices();

  const [hoveredNav, setHoveredNav] = useState<{ label: string; top: number } | null>(null);
  const sessionUser = getSessionUser();

  // Sync state to CSS layout tokens
  useEffect(() => {
    localStorage.setItem('solo_sidebar_collapsed', String(isCollapsed));
    document.documentElement.style.setProperty('--sidebar-width', isCollapsed ? '72px' : '250px');
  }, [isCollapsed]);

  // Determine active service based on path
  const currentPath = location.pathname;
  const activeServiceId = currentPath.split('/')[1];
  const isDashboard = currentPath === '/dashboard' || currentPath === '/';

  const handleLogout = async () => {
    const isConfirmed = await confirm({
      title: t('common.confirm'),
      message: t('dashboard.confirm_logout', { defaultValue: 'Are you sure you want to end your session?' }),
      confirmLabel: t('nav.logout'),
      isDangerous: false
    });

    if (isConfirmed) {
      clearSession();
      navigate('/login');
    }
  };

  // Show all discovered services EXCEPT those in the NON_DISCOVERABLE_SERVICES blacklist.
  // ALSO hide services that have no entities AND no specialized UI.
  const allServiceIds = services
    .filter(s => {
      const isNotBlacklisted = !NON_DISCOVERABLE_SERVICES.includes(s.id);
      const hasEntities = s.entities && Object.keys(s.entities).length > 0;
      const hasSpecializedUI = !!ExtensionRegistry[s.id];
      return isNotBlacklisted && (hasEntities || hasSpecializedUI);
    })
    .map(s => s.id)
    .sort();

  return (
    <div className={`dashboard-container ${isCollapsed ? 'collapsed' : ''}`}>
      <div className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
        {/* Sidebar Header */}
        <div style={{ 
          paddingBottom: '12px', 
          borderBottom: '1px solid var(--border-color)', 
          marginBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isCollapsed ? 'center' : 'stretch',
          minHeight: 'auto'
        }}>
          {!isCollapsed ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--accent-color)', letterSpacing: '-0.02em' }}>{t('nav.brand_title')}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, opacity: 0.8, marginTop: '2px' }}>{t('nav.brand_subtitle')}</div>
              </div>
              <IconButton
                variant="secondary"
                size="sm"
                onClick={() => setIsCollapsed(true)}
                label={t('nav.collapse_sidebar')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </IconButton>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
              <div style={{ fontSize: '20px', fontWeight: 900, color: 'var(--accent-color)' }}>S</div>
              <IconButton
                variant="secondary"
                size="sm"
                onClick={() => setIsCollapsed(false)}
                label={t('nav.expand_sidebar')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </IconButton>
            </div>
          )}
        </div>

        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '6px', 
          flex: 1, 
          overflowY: 'auto',
          alignItems: isCollapsed ? 'center' : 'stretch'
        }}>
          <NavButton
            active={isDashboard}
            collapsed={isCollapsed}
            onClick={() => navigate('/dashboard')}
            label={t('nav.dashboard')}
            icon={ICON_MAP.dashboard}
            onHover={setHoveredNav}
          />

          {/* External users (passport) — managed in the operator console, separate
              from internal user/bot (system console). authority.md. */}
          <NavButton
            active={activeServiceId === 'passport'}
            collapsed={isCollapsed}
            onClick={() => navigate('/passport')}
            label={t('nav.passport', { defaultValue: 'Users' })}
            onHover={setHoveredNav}
          />

          {allServiceIds.map(id => (
            <NavButton
              key={id}
              active={activeServiceId === id}
              collapsed={isCollapsed}
              onClick={() => navigate(`/${id}`)}
              label={t(`nav.${id}`, { defaultValue: '' }) || (id.charAt(0).toUpperCase() + id.slice(1))}
              icon={ICON_MAP[id]}
              onHover={setHoveredNav}
            />
          ))}
        </div>

        <div style={{ 
          paddingTop: '16px', 
          borderTop: '1px solid var(--border-color)', 
          display: 'flex', 
          flexDirection: 'column',
          gap: '12px',
          alignItems: isCollapsed ? 'center' : 'stretch'
        }}>

          {/* Current user */}
          {sessionUser && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 10px',
              borderRadius: '8px',
              background: 'var(--accent-surface, #eff6ff)',
              border: '1px solid var(--accent-color, #3b82f6)22',
              justifyContent: isCollapsed ? 'center' : 'flex-start',
            }}>
              <div style={{
                width: '26px', height: '26px', borderRadius: '50%',
                background: 'var(--accent-color)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '12px', fontWeight: 700, flexShrink: 0,
              }}>
                {sessionUser.charAt(0).toUpperCase()}
              </div>
              {!isCollapsed && (
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-color)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sessionUser}
                </span>
              )}
            </div>
          )}

          {/* Logout Button */}
          <button
            onClick={handleLogout}
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid transparent',
              color: '#ef4444',
              padding: '10px',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: isCollapsed ? 'center' : 'flex-start',
              alignItems: 'center',
              gap: '12px',
              fontWeight: 600,
              fontSize: '13px'
            }}
            title={isCollapsed ? t('nav.logout') : ''}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            {!isCollapsed && t('nav.logout')}
          </button>
        </div>
      </div>

      <div className="main-content">
        <div className={`content-header ${isCollapsed ? 'compact' : ''}`} style={{ background: '#fff', borderBottom: isCollapsed ? 'none' : '1px solid var(--border-color)' }}>
          {!isCollapsed && (
            <>
              <div className="breadcrumb" style={{ fontSize: '14px', fontWeight: 600 }}>
                {isDashboard ? t('nav.dashboard') : (
                  activeServiceId ? t(`nav.${activeServiceId}`, { defaultValue: activeServiceId.charAt(0).toUpperCase() + activeServiceId.slice(1) }) : ''
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                <span className="session-timer" style={{ whiteSpace: 'nowrap', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {t('nav.session_active')}
                  <span style={{ fontSize: '11px', fontWeight: 400, opacity: 0.6, fontFamily: 'var(--font-mono)', letterSpacing: 0 }}>
                    {getCurrentRouterUrl().replace(/\/$/, '')}
                  </span>
                </span>

                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as any)}
                  style={{
                    fontSize: '13px',
                    padding: '5px 10px',
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                    background: 'white',
                    color: '#334155',
                    cursor: 'pointer',
                    outline: 'none',
                    minWidth: '100px'
                  }}
                >
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                </select>
              </div>
            </>
          )}
        </div>

        <div className={`content-body ${isCollapsed ? 'compact' : ''}`}>
          <Outlet />
        </div>
      </div>

      {isCollapsed && hoveredNav && (
        <div className="nav-tooltip" style={{ top: `${hoveredNav.top}px` }}>
          {hoveredNav.label}
        </div>
      )}
    </div>
  );
}

function NavButton({ active, collapsed, onClick, label, icon, onHover }: { 
  active: boolean; 
  collapsed: boolean;
  onClick: () => void; 
  label: string;
  icon?: React.ReactNode;
  onHover: (data: { label: string; top: number } | null) => void;
}) {
  // If icon is provided, use it. If not, generate a "Character Icon"
  const renderIcon = () => {
    const iconContainerStyle: React.CSSProperties = {
      width: '28px',
      height: '28px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0
    };

    if (icon) {
      return (
        <div style={iconContainerStyle}>
          {icon}
        </div>
      );
    }
    
    // Character Icon logic
    const firstChar = label.trim().charAt(0).toUpperCase();
    return (
      <div className="nav-character-icon" style={{ 
        ...iconContainerStyle,
        borderRadius: '8px', 
        fontSize: '14px',
        fontWeight: 800,
        background: active ? 'var(--accent-color)' : '#f1f5f9',
        color: active ? 'white' : '#64748b',
        transition: 'all 0.2s'
      }}>
        {firstChar}
      </div>
    );
  };

  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => {
        if (collapsed) {
          const rect = e.currentTarget.getBoundingClientRect();
          onHover({ label, top: rect.top + rect.height / 2 });
        }
      }}
      onMouseLeave={() => onHover(null)}
      style={{
        width: '100%',
        textAlign: 'left',
        background: active ? (collapsed ? 'transparent' : '#f3f4f6') : 'transparent',
        color: active ? 'var(--accent-color)' : 'var(--text-secondary)',
        border: 'none',
        fontWeight: active ? 600 : 500,
        padding: '8px 12px',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'all 0.2s',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: '12px',
        position: 'relative'
      }}
    >
      {renderIcon()}
      {!collapsed && <span style={{ fontSize: '13px' }}>{label}</span>}
    </button>
  );
}
