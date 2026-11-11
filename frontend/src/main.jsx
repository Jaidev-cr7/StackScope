import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App.jsx';
import './styles/tokens.css';
import './styles/app.css';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Every failure mode this app has is worth showing to the user
        // verbatim (a 401 means "log in again", a 404 means "that run is
        // gone"). Blind retries only delay that message.
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({ client, children }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

function mount() {
  const container = document.getElementById('root');
  if (!container) throw new Error('index.html is missing its #root element');
  createRoot(container).render(
    <StrictMode>
      <AppProviders client={createQueryClient()}>
        <App />
      </AppProviders>
    </StrictMode>,
  );
}

if (typeof window !== 'undefined' && !import.meta.env?.VITEST) {
  mount();
}