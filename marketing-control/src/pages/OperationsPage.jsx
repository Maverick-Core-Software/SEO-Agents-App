import { useEffect, useState } from 'react';
import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { StatusChip } from '../components/StatusChip.jsx';
import { FIXTURE_ADAPTERS, FIXTURE_LOGS, FIXTURE_RUNS } from '../fixtures/detail.js';
import { fetchWorkerStatus } from '../lib/api.js';
import { useMarketingData } from '../lib/useMarketingData.js';
import { bucketStatusCount, liveRunStatus, POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|anon[_-]?key|authorization|cookie|credential|private[_-]?key|service[_-]?role/i;

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

const ADAPTER_COLOR = {
  live_ready: '#10b981',
  approval_ready: '#f59e0b',
  missing: '#ef4444',
  blocked: '#ef4444',
  error: '#ef4444',
};

function StatusFor({ status }) {
  const key = String(status || '').toLowerCase();
  const label = POST_STATUS_LABEL[key] || (key ? key.replace(/_/g, ' ').toUpperCase() : '—');
  const color = POST_STATUS_COLOR[key] || ADAPTER_COLOR[key] || '#4b5563';
  return <StatusChip label={label} color={color} />;
}

function dash(value) {
  if (value == null || value === '') return '—';
  return String(value);
}

function redactSecrets(value, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, k);
    return out;
  }
  return value;
}

function summarizeWorker(data) {
  if (!data || typeof data !== 'object') return data;
  const keys = ['state', 'statusCounts', 'faults', 'updatedAt', 'activeWorkflow', 'runHealth'];
  const summary = {};
  for (const key of keys) {
    if (key in data) summary[key] = data[key];
  }
  return Object.keys(summary).length ? summary : data;
}

function postsByRunId(posts, health) {
  const map = {};
  for (const post of posts || []) {
    if (!post?.run_id) continue;
    (map[post.run_id] = map[post.run_id] || []).push(post);
  }
  if (health?.run?.id && Array.isArray(health.posts) && health.posts.length) {
    map[health.run.id] = health.posts;
  }
  return map;
}

function liveOrFrozen(run, runPosts) {
  if (runPosts && runPosts.length) return liveRunStatus(run, runPosts);
  return run?.status || 'idle';
}

export default function OperationsPage(props) {
  const { configured, loading, error, runs, posts, logs, health } = useMarketingData();
  const [worker, setWorker] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchWorkerStatus()
      .then((result) => {
        if (!cancelled) setWorker(result);
      })
      .catch(() => {
        if (!cancelled) setWorker({ ok: false, unreachable: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const usingLive = configured;
  const runList = usingLive ? runs : FIXTURE_RUNS;
  const logList = usingLive ? logs : FIXTURE_LOGS;
  const healthView = usingLive
    ? health
    : {
        run: FIXTURE_RUNS[0] || null,
        posts: [],
        live: liveOrFrozen(FIXTURE_RUNS[0], []),
        bucket: bucketStatusCount(liveOrFrozen(FIXTURE_RUNS[0], [])),
      };
  const byRun = postsByRunId(posts, healthView);

  let workerBody = 'checking worker…';
  if (worker) {
    if (worker.unreachable || !worker.ok) {
      workerBody = 'worker unreachable';
    } else if (worker.data == null) {
      workerBody = 'worker reachable — empty body';
    } else {
      try {
        workerBody = JSON.stringify(redactSecrets(summarizeWorker(worker.data)), null, 2);
      } catch {
        workerBody = 'worker reachable — could not render status';
      }
    }
  }

  return (
    <section className="page">
      <h1>Operations</h1>
      <p>
        Adapter readiness, run history, and worker health
        {usingLive ? ' — live reads where configured.' : ' — fixture data (Supabase not configured).'}
      </p>
      {loading ? <p style={{ marginTop: 8 }}>Loading operations…</p> : null}
      {error ? <p style={{ marginTop: 8 }}>Could not load operations: {error}</p> : null}

      <div style={card}>
        <h2 style={h2}>Adapter readiness</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {FIXTURE_ADAPTERS.map((adapter) => (
            <div
              key={adapter.id}
              style={{
                background: '#0f1117',
                border: '1px solid #2a2f45',
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong style={{ color: '#f1f5f9' }}>{adapter.label}</strong>
                <StatusFor status={adapter.state} />
              </div>
              {adapter.missing?.length ? (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#94a3b8' }}>
                  {adapter.missing.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ marginTop: 8 }}>No missing checks.</p>
              )}
            </div>
          ))}
        </div>
        {usingLive && healthView ? (
          <p style={{ marginTop: 12 }}>
            Live run health overlay: {dash(healthView.live)} / {dash(healthView.bucket)}
            {healthView.run?.week_of ? ` (week_of ${healthView.run.week_of})` : ''}.
          </p>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>Latest run health</h2>
        <p style={{ marginBottom: 10 }}>
          Derived from seo_runs + weekly_posts (no run_health table). mav-bridge runHealth is currently null.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 1fr',
            gap: '8px 12px',
            color: '#f1f5f9',
          }}
        >
          <div style={{ color: '#94a3b8', fontWeight: 600 }}>health.live</div>
          <div>
            <StatusFor status={healthView?.live} />
          </div>
          <div style={{ color: '#94a3b8', fontWeight: 600 }}>health.bucket</div>
          <div>{dash(healthView?.bucket)}</div>
          <div style={{ color: '#94a3b8', fontWeight: 600 }}>run.week_of</div>
          <div>{dash(healthView?.run?.week_of)}</div>
          <div style={{ color: '#94a3b8', fontWeight: 600 }}>run.status</div>
          <div>
            <StatusFor status={healthView?.run?.status} />
          </div>
          <div style={{ color: '#94a3b8', fontWeight: 600 }}>run.error</div>
          <div>{dash(healthView?.run?.error)}</div>
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Run history</h2>
        {runList.length === 0 ? (
          <p>No runs.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['week_of', 'frozen status', 'live status', 'error'].map((col) => (
                    <th key={col} style={th}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runList.map((run) => {
                  const live = liveOrFrozen(run, byRun[run.id]);
                  return (
                    <tr key={run.id || run.week_of}>
                      <td style={td}>{dash(run.week_of)}</td>
                      <td style={td}>
                        <StatusFor status={run.status} />
                      </td>
                      <td style={td}>
                        <StatusFor status={live} />
                      </td>
                      <td style={td}>{dash(run.error)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <h2 style={h2}>run_logs</h2>
        {logList.length === 0 ? (
          <p>No logs.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['created_at', 'phase', 'level', 'message'].map((col) => (
                    <th key={col} style={th}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logList.map((log, i) => (
                  <tr key={log.id || `${log.created_at}-${i}`}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{dash(log.created_at)}</td>
                    <td style={td}>{dash(log.phase)}</td>
                    <td style={td}>
                      <StatusChip
                        label={String(log.level || 'info').toUpperCase()}
                        color={
                          String(log.level).toLowerCase() === 'error'
                            ? '#ef4444'
                            : String(log.level).toLowerCase() === 'warn'
                              ? '#f59e0b'
                              : '#4b5563'
                        }
                      />
                    </td>
                    <td style={td}>{dash(log.message)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <h2 style={h2}>Fault ack state</h2>
        <p>acks are local to MCC (state/fault-acks.json) — not in Supabase. Phase 2.</p>
      </div>

      <div style={card}>
        <h2 style={h2}>Worker health</h2>
        <p style={{ marginBottom: 10 }}>GET-only probe (VITE_SEO_STATUS_URL). Secrets are redacted.</p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: '#0f1117',
            border: '1px solid #2a2f45',
            borderRadius: 6,
            color: '#f1f5f9',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            maxHeight: 280,
          }}
        >
          {workerBody}
        </pre>
      </div>

      <div style={card}>
        <h2 style={h2}>Task event log</h2>
        <p>Task activity log lives in MCC memory — not in Supabase.</p>
      </div>

      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <ReadOnlyButton>Clear lock</ReadOnlyButton>
        <ReadOnlyButton>Ack faults</ReadOnlyButton>
      </div>
    </section>
  );
}
