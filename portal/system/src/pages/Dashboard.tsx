import { useState, useEffect } from 'react';
import { clearSession } from '../utils/auth';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { getCurrentRouterUrl } from '../utils/routerManager';
import ServiceManagement from './ServiceManagement';
import Overview from './Overview';
import UserManagement from './UserManagement';
import BotManagement from './BotManagement';
import WorkflowManagement from './WorkflowManagement';
import NexusHub from './NexusHub';
import IngressManagement from './IngressManagement';
import ErrorLogs from './ErrorLogs';
import { useLang } from '../providers/LanguageProvider';
import Settings from './Settings';

export default function DashboardLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang, setLang } = useLang();

  const [isCollapsed, setIsCollapsed] = useState(() =>
    localStorage.getItem('solo_system_sidebar_collapsed') === 'true'
  );

  useEffect(() => {
    localStorage.setItem('solo_system_sidebar_collapsed', String(isCollapsed));
  }, [isCollapsed]);

  const handleLogout = () => {
    clearSession();
    navigate('/login');
  };

  const menuItems = [
    { label: 'Overview',       id: 'overview',   path: '/overview',   name: t('nav.dashboard'),              icon: 'O'  },
    { label: 'Service',        id: 'service',     path: '/services',   name: t('nav.services'),               icon: 'S'  },
    { label: 'User Management',id: 'users',       path: '/users',      name: t('nav.users'),                  icon: 'U'  },
    { label: 'Bot Accounts',   id: 'bots',        path: '/bots',       name: t('nav.bots'),                   icon: 'B'  },
    { label: 'Workflows',      id: 'workflows',   path: '/workflows',  name: t('nav.workflows'),              icon: 'W'  },
    { label: 'Ingress',        id: 'ingress',     path: '/ingress',    name: t('nav.ingress') || 'Ingress',   icon: 'I'  },
    { label: 'Agent Nexus',    id: 'nexus',       path: '/nexus',      name: t('nav.nexus') || 'Agent Nexus', icon: 'N'  },
    { label: 'Error Logs',     id: 'errors',      path: '/errors',     name: t('nav.errors'),                 icon: 'X'  },
  ];

  // Determine active item based on current path. Exact match, or a path-prefixed
  // sub-route (e.g. /nexus/sentinels highlights the /nexus item).
  const activeItem = menuItems.find(item =>
      location.pathname === item.path || location.pathname.startsWith(item.path + '/')) ||
    (location.pathname === '/settings' ? { id: 'settings', name: t('nav.settings'), label: 'Settings', path: '/settings' } : menuItems[0]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-primary">
      {/* Sidebar */}
      <div className={`sys-sidebar bg-bg-primary border-r border-border flex flex-col p-6 shrink-0${isCollapsed ? ' collapsed' : ''}`}>
        {/* Header */}
        <div className={`text-base font-bold text-accent mb-8 pb-3 border-b-2 border-dashed border-border flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}>
          {!isCollapsed && <span>{t('dashboard.header')}</span>}
          <button
            onClick={() => setIsCollapsed(v => !v)}
            className="bg-transparent border border-transparent text-text-secondary hover:text-accent hover:border-accent transition-all text-xs w-6 h-6 flex items-center justify-center shrink-0 font-mono"
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '»' : '«'}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-2 flex-1">
          {menuItems.map(item => (
            <button
              key={item.id}
              title={isCollapsed ? item.name : undefined}
              className={`text-left bg-transparent border text-text-primary py-2.5 cursor-pointer font-mono transition-all opacity-70 uppercase tracking-wide flex items-center text-xs
                ${isCollapsed ? 'justify-center px-0' : 'px-4'}
                ${activeItem.id === item.id ? 'border-accent bg-accent-dim !opacity-100' : 'border-transparent hover:border-accent hover:bg-accent-dim hover:opacity-100'}`}
              onClick={() => navigate(item.path)}
            >
              {isCollapsed
                ? <span className={`font-mono font-bold text-[11px] tracking-widest ${activeItem.id === item.id ? 'opacity-100 text-accent' : 'opacity-40'}`}>{item.icon}</span>
                : <><span className={`mr-2.5 ${activeItem.id === item.id ? 'opacity-100' : 'opacity-50'}`}>&gt;</span>{item.name}</>
              }
            </button>
          ))}
        </nav>

        {/* Bottom */}
        <div className={`mt-auto border-t border-border pt-4 flex gap-2.5 ${isCollapsed ? 'flex-col' : 'grid grid-cols-2'}`}>
          <button
            title={isCollapsed ? t('nav.settings') : undefined}
            className={`bg-transparent border text-text-primary cursor-pointer font-mono transition-all uppercase tracking-wide flex items-center justify-center whitespace-nowrap h-9 text-xs
              ${location.pathname === '/settings' ? 'border-accent bg-accent-dim opacity-100' : 'border-transparent opacity-70 hover:border-accent hover:bg-accent-dim hover:opacity-100'}`}
            onClick={() => navigate('/settings')}
          >
            {isCollapsed ? '⚙' : t('nav.settings')}
          </button>
          <button
            title={isCollapsed ? t('nav.logout') : undefined}
            className="bg-transparent border border-transparent !text-error !border-error cursor-pointer font-mono transition-all uppercase tracking-wide flex items-center justify-center whitespace-nowrap h-9 text-xs hover:bg-error/10"
            onClick={handleLogout}
          >
            {isCollapsed ? '×' : t('nav.logout')}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-bg-secondary">
        <div className="h-16 border-b border-border flex items-center justify-between px-8 bg-bg-primary shrink-0">
          <div className="text-sm text-text-primary">
            {t('dashboard.breadcrumb_root')} / {(activeItem as any).name.toUpperCase()}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs text-success border border-success px-2 py-1">
              {t('dashboard.session_active')}
              <span className="ml-2 opacity-60">{getCurrentRouterUrl().replace(/\/$/, '')}</span>
            </div>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as any)}
              className="bg-transparent text-text-secondary border border-border rounded px-1 py-0.5 text-xs cursor-pointer outline-none"
            >
              <option value="en">ENGLISH</option>
              <option value="zh">中文</option>
            </select>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <Routes>
            <Route path="overview" element={<Overview />} />
            <Route path="services" element={<ServiceManagement />} />
            <Route path="users" element={<UserManagement />} />
            <Route path="bots" element={<BotManagement />} />
            <Route path="workflows" element={<WorkflowManagement />} />
            <Route path="ingress" element={<IngressManagement />} />
            <Route path="nexus/*" element={<NexusHub />} />
            {/* legacy deep-links → merged Nexus hub sub-tabs */}
            <Route path="events" element={<Navigate to="/nexus/events" replace />} />
            <Route path="automation" element={<Navigate to="/nexus/control" replace />} />
            <Route path="errors" element={<ErrorLogs />} />
            <Route path="settings" element={<Settings />} />
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
