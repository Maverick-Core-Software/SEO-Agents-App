import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { StatusChip } from '../components/StatusChip.jsx';
import { FIXTURE_TASKS, FIXTURE_WEBSITE_ADAPTER } from '../fixtures/detail.js';
import { useMarketingData } from '../lib/useMarketingData.js';
import { POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const PRIORITY_COLOR = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#6366f1',
  low: '#4b5563',
};

const card = {
  background: '#161922',
  border: '1px solid #2a2f45',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
};

const h2 = { margin: '0 0 12px', fontSize: 16, fontWeight: 650, color: '#f1f5f9' };

const th = {
  textAlign: 'left',
  color: '#94a3b8',
  fontWeight: 600,
  padding: '8px 10px',
  borderBottom: '1px solid #2a2f45',
  whiteSpace: 'nowrap',
};

const td = {
  padding: '8px 10px',
  borderBottom: '1px solid #2a2f45',
  verticalAlign: 'top',
  color: '#f1f5f9',
};

function sortByPriority(tasks) {
  return [...(tasks || [])].sort((a, b) => {
    const pa = PRIORITY_RANK[String(a?.priority || '').toLowerCase()] ?? 4;
    const pb = PRIORITY_RANK[String(b?.priority || '').toLowerCase()] ?? 4;
    if (pa !== pb) return pa - pb;
    return String(a?.created_at || '') < String(b?.created_at || '') ? -1 : 1;
  });
}

function siteSection(task) {
  const details = task?.details || {};
  return details.section || details.site_section || '—';
}

function capability(task) {
  const action = task?.details?.website_action_type;
  if (action) return action;
  return task?.type || '—';
}

function previewPath(task) {
  const details = task?.details || {};
  if (details.preview_path) return details.preview_path;
  const hay = [details.mode, details.execution_mode, task?.status, details.preview]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  if (hay.includes('dry-run') || hay.includes('dry_run') || hay.includes('preview')) {
    return 'outputs/website_preview/';
  }
  return '—';
}

function StatusFor({ status }) {
  const key = String(status || '').toLowerCase();
  const label = POST_STATUS_LABEL[key] || (key ? key.replace(/_/g, ' ').toUpperCase() : '—');
  const color = POST_STATUS_COLOR[key] || '#4b5563';
  return <StatusChip label={label} color={color} />;
}

export default function WebsiteTasksPage(props) {
  const { configured, loading, error, tasks } = useMarketingData();
  const usingLive = configured;
  const list = sortByPriority(usingLive ? tasks : FIXTURE_TASKS);
  const adapter = FIXTURE_WEBSITE_ADAPTER;

  return (
    <section className="page">
      <h1>Website Tasks</h1>
      <p>
        Priority list
        {usingLive ? ' from live website_tasks.' : ' from fixtures (Supabase not configured).'}
      </p>
      {loading ? <p style={{ marginTop: 8 }}>Loading tasks…</p> : null}
      {error ? <p style={{ marginTop: 8 }}>Could not load tasks: {error}</p> : null}

      <div style={card}>
        <h2 style={h2}>Adapter capabilities</h2>
        <p style={{ marginBottom: 10 }}>
          {adapter.name} — {adapter.state}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(adapter.capabilities || []).map((cap) => (
            <span
              key={cap}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid #2a2f45',
                background: '#0f1117',
                color: '#f1f5f9',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {cap}
            </span>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Queue</h2>
        {list.length === 0 ? (
          <p>No website tasks.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['title', 'priority', 'status', 'error', 'type / capability', 'site section', 'preview path', ''].map(
                    (col) => (
                      <th key={col || 'actions'} style={th}>
                        {col}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {list.map((task) => {
                  const priority = String(task.priority || '').toLowerCase();
                  return (
                    <tr key={task.id || task.title}>
                      <td style={td}>{task.title || '—'}</td>
                      <td style={td}>
                        <StatusChip
                          label={(task.priority || '—').toString().toUpperCase()}
                          color={PRIORITY_COLOR[priority] || '#4b5563'}
                        />
                      </td>
                      <td style={td}>
                        <StatusFor status={task.status} />
                      </td>
                      <td style={td}>{task.error || '—'}</td>
                      <td style={td}>{capability(task)}</td>
                      <td style={td}>{siteSection(task)}</td>
                      <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>
                        {previewPath(task)}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <ReadOnlyButton>Approve</ReadOnlyButton>
                          <ReadOnlyButton>Skip</ReadOnlyButton>
                          <ReadOnlyButton>Retry</ReadOnlyButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
