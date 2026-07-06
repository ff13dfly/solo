import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { isValidSession } from './utils/auth';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  // Detect session expiry while the user is idle on the same page.
  React.useEffect(() => {
    const id = setInterval(() => {
      if (!isValidSession()) {
        navigate('/login', { replace: true });
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [navigate]);

  if (!isValidSession()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

import { LanguageProvider } from './providers/LanguageProvider';

// ... existing code ...

import { UIProvider } from './providers/UIProvider';

function App() {
  return (
    <UIProvider>
      <LanguageProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route 
              path="/*" 
              element={
                <RequireAuth>
                  <Dashboard />
                </RequireAuth>
              } 
            />
          </Routes>
        </BrowserRouter>
      </LanguageProvider>
    </UIProvider>
  );
}

export default App;
