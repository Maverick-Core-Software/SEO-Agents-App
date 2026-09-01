import { useEffect, useState } from 'react';
import { isSupabaseAvailable } from './supabase.js';
import { MarketingDataProvider, useMarketingData } from './lib/useMarketingData.js';
import TodayPage from './pages/TodayPage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import ApprovalInboxPage from './pages/ApprovalInboxPage.jsx';
import ContentDetailPage from './pages/ContentDetailPage.jsx';
import WebsiteTasksPage from './pages/WebsiteTasksPage.jsx';
import PerformancePage from './pages/PerformancePage.jsx';
import OperationsPage from './pages/OperationsPage.jsx';

const NAV = [
  { id: 'today', hash: '#/today', label: 'Today', Page: TodayPage },
  { id: 'calendar', hash: '#/calendar', label: 'Calendar', Page: CalendarPage },
  { id: 'approval', hash: '#/approval', label: 'Approval Inbox', Page: ApprovalInboxPage },
  { id: 'detail', hash: '#/detail', label: 'Content Detail', Page: ContentDetailPage },
  { id: 'website', hash: '#/website', label: 'Website Tasks', Page: WebsiteTasksPage },
  { id: 'performance', hash: '#/performance', label: 'Performance', Page: PerformancePage },
  { id: 'operations', hash: '#/operations', label: 'Operations', Page: OperationsPage },
];

function routeFromHash(hash) {
  if (hash.startsWith('#/detail')) return NAV.find((item) => item.id === 'detail') || NAV[0];
  return NAV.find((item) => item.hash === hash) || NAV[0];
}

function Shell() {
  const [route, setRoute] = useState(() => routeFromHash(window.location.hash));
  const data = useMarketingData();
  const attention = (data.runRecovery || []).length;
  const pending = (data.pendingPosts || []).length + (data.pendingTasks || []).length;

  useEffect(() => {
    function syncRoute() {
      if (!window.location.hash) {
        window.location.hash = '#/today';
        return;
      }
      setRoute(routeFromHash(window.location.hash));
    }

    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  const Page = route.Page;

  return (
    <div className="app">
      <a className="skipLink" href="#main">Skip to content</a>
      <header className="appHeader">
        <div className="headerBrand">
          <h1 className="appTitle">Grizzly Marketing Control</h1>
          <div className="headerMeta">
            Chicago {data.today}
            {data.loadedAt ? ` · refreshed ${String(data.loadedAt).slice(11, 16)} UTC` : ''}
          </div>
        </div>
        <nav className="appNav" aria-label="Screens">
          {NAV.map((item) => {
            const showAttention = item.id === 'today' && attention > 0;
            const showPending = item.id === 'approval' && pending > 0;
            return (
              <a
                key={item.id}
                href={item.hash}
                className={item.id === route.id ? 'navLink active' : 'navLink'}
                aria-current={item.id === route.id ? 'page' : undefined}
              >
                {item.label}
                {showAttention ? <span className="navBadge">{attention}</span> : null}
                {showPending ? <span className="navBadge">{pending}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="headerActions">
          <button
            type="button"
            className="reloadBtn"
            onClick={() => data.reload()}
            disabled={data.loading || !data.configured}
            title={data.configured ? 'Reload live data' : 'Supabase is not configured'}
          >
            {data.loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>
      <div className="readonlyBanner" role="status">
        Read-only slice — writes are disabled.
      </div>
      {!isSupabaseAvailable ? (
        <div className="configNotice" role="status">
          Supabase is not configured. Copy <code>.env.example</code> to <code>.env</code> and set
          {' '}
          <code>VITE_SUPABASE_URL</code>
          {' '}
          and
          {' '}
          <code>VITE_SUPABASE_ANON_KEY</code>
          .
        </div>
      ) : null}
      <main id="main" className="appMain">
        <Page />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <MarketingDataProvider>
      <Shell />
    </MarketingDataProvider>
  );
}
