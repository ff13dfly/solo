import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import PassportManagement from './pages/PassportManagement';
import { isValidSession } from './utils/auth';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isValidSession()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

import { LanguageProvider } from './providers/LanguageProvider';
import { ServicesProvider, useServices } from './providers/ServicesProvider';
import { DisplayConfigProvider } from './providers/DisplayConfigProvider';
import OperatorLayout from './layouts/OperatorLayout';
import { NON_DISCOVERABLE_SERVICES, getComponentForService, ExtensionRegistry } from './ExtensionRegistry';
import GenericEntityPage from './pages/default';

function DynamicRoutes() {
  const { services } = useServices();

  // Show all discovered services EXCEPT those in the NON_DISCOVERABLE_SERVICES blacklist.
  // ALSO hide services that have no entities AND no specialized UI.
  const allServiceIds = services
    .filter(s => {
      const isNotBlacklisted = !NON_DISCOVERABLE_SERVICES.includes(s.id);
      const hasEntities = s.entities && Object.keys(s.entities).length > 0;
      const hasSpecializedUI = !!ExtensionRegistry[s.id];
      return isNotBlacklisted && (hasEntities || hasSpecializedUI);
    })
    .map(s => s.id);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <OperatorLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/passport" element={<PassportManagement />} />

        {/* Dynamic Service Routes */}
        {allServiceIds.map(id => {
          const ServiceComponent = getComponentForService(id, GenericEntityPage);
          return (
            <Route
              key={id}
              path={`/${id}`}
              element={<ServiceComponent serviceId={id} />}
            />
          );
        })}

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

function App() {
  return (
    <LanguageProvider>
        <BrowserRouter>
          <ServicesProvider>
            <DisplayConfigProvider>
              <DynamicRoutes />
            </DisplayConfigProvider>
          </ServicesProvider>
        </BrowserRouter>
    </LanguageProvider>
  );
}

export default App;
