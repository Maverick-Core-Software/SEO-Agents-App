import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react';
import { isSupabaseAvailable } from '../supabase.js';
import {
  fetchRuns,
  fetchPosts,
  fetchWebsiteTasks,
  fetchRunLogs,
  fetchLatestRunHealth,
  fetchWorkerStatus,
} from './api.js';
import { isPendingApproval, isWaitingOnOwner, isAttentionItem, recoveryClass, RECOVERY_CLASS, isOnGraph } from './status.js';
import { chicagoToday, sundayOfWeek, saturdayOfWeek, addDays } from './week.js';

const EMPTY_HEALTH = { run: null, posts: [], live: 'idle', bucket: 'incomplete' };
const EMPTY_WORKER = { ok: false, unreachable: true };
const MarketingDataContext = createContext(null);

export function partitionPosts(posts) {
  const facebook = [];
  const gbp = [];
  for (const post of posts || []) {
    const platform = String(post?.platform || '').toLowerCase();
    if (platform === 'gbp') gbp.push(post);
    else facebook.push(post); // unknown platforms must not vanish
  }
  return { facebook, gbp };
}

/** Span of the post list's own dates, falling back to the current calendar week. */
export function spanFromPosts(list, fallbackStart, fallbackEnd) {
  const dates = (list || []).map((p) => p.post_date).filter(Boolean).sort();
  if (!dates.length) return { weekStart: fallbackStart, weekEnd: fallbackEnd };
  return { weekStart: dates[0], weekEnd: dates[dates.length - 1] };
}

function useMarketingDataState() {
  const today = chicagoToday();
  const calWeekStart = sundayOfWeek(today);
  const calWeekEnd = saturdayOfWeek(today);
  const lookbackStart = addDays(calWeekStart, -21);
  const lookbackEnd = saturdayOfWeek(addDays(today, 21));
  const configured = isSupabaseAvailable;

  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState([]);
  const [posts, setPosts] = useState([]);
  const [lookbackPosts, setLookbackPosts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [health, setHealth] = useState(EMPTY_HEALTH);
  const [worker, setWorker] = useState(EMPTY_WORKER);
  const [loadedAt, setLoadedAt] = useState(null);

  const reload = useCallback(async () => {
    if (!isSupabaseAvailable) {
      setLoading(false);
      setError(null);
      setRuns([]);
      setPosts([]);
      setLookbackPosts([]);
      setTasks([]);
      setLogs([]);
      setHealth(EMPTY_HEALTH);
      setWorker(EMPTY_WORKER);
      setLoadedAt(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextRuns, nextLookback, nextTasks, nextLogs, nextHealth, nextWorker] =
        await Promise.all([
          fetchRuns(),
          fetchPosts(lookbackStart, lookbackEnd),
          fetchWebsiteTasks(),
          fetchRunLogs(),
          fetchLatestRunHealth(),
          fetchWorkerStatus(),
        ]);
      setRuns(nextRuns);
      setPosts(nextHealth.posts || []);
      setLookbackPosts(nextLookback);
      setTasks(nextTasks);
      setLogs(nextLogs);
      setHealth(nextHealth);
      setWorker(nextWorker || EMPTY_WORKER);
      setLoadedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lookbackStart, lookbackEnd]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { facebook, gbp } = partitionPosts(posts);
  const { weekStart, weekEnd } = spanFromPosts(posts, calWeekStart, calWeekEnd);

  const pendingPosts = posts.filter((p) => isPendingApproval(p.status));
  const pendingTasks = tasks.filter((t) => isPendingApproval(t.status));
  const waitingOnOwner = tasks.filter((t) => isWaitingOnOwner(t.status));
  const currentRunId = health.run?.id || null;
  // Primary attention = current-run execution / verification / owner items only.
  // Historical/skipped backlog (other runs, skips) never enters the primary view.
  const runRecovery = [...posts, ...tasks].filter((item) =>
    isAttentionItem(item, { today, currentRunId }),
  );
  const priorRecovery = [...lookbackPosts, ...tasks].filter(
    (item) => recoveryClass(item, { today, currentRunId }) === RECOVERY_CLASS.historical,
  );

  return {
    configured,
    loading,
    error,
    weekStart,
    weekEnd,
    calWeekStart,
    calWeekEnd,
    today,
    runs,
    posts,
    facebook,
    gbp,
    tasks,
    logs,
    health,
    lookbackPosts,
    worker,
    pendingPosts,
    pendingTasks,
    waitingOnOwner,
    runRecovery,
    priorRecovery,
    facebookOnGraph: facebook.filter(isOnGraph).length,
    gbpOnGraph: gbp.filter(isOnGraph).length,
    loadedAt,
    reload,
  };
}

export function MarketingDataProvider({ children }) {
  const value = useMarketingDataState();
  return createElement(MarketingDataContext.Provider, { value }, children);
}

/** Shared live marketing snapshot. Pages must render under MarketingDataProvider. */
export function useMarketingData() {
  const ctx = useContext(MarketingDataContext);
  if (!ctx) {
    throw new Error('useMarketingData requires MarketingDataProvider');
  }
  return ctx;
}
