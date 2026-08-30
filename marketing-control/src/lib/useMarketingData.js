import { useCallback, useEffect, useState } from 'react';
import { isSupabaseAvailable } from '../supabase.js';
import {
  fetchRuns,
  fetchPosts,
  fetchWebsiteTasks,
  fetchRunLogs,
  fetchLatestRunHealth,
} from './api.js';
import { chicagoToday, sundayOfWeek, saturdayOfWeek } from './week.js';

const EMPTY_HEALTH = { run: null, posts: [], live: 'idle', bucket: 'incomplete' };

export function partitionPosts(posts) {
  const facebook = [];
  const gbp = [];
  for (const post of posts || []) {
    const platform = String(post?.platform || '').toLowerCase();
    if (platform === 'gbp') gbp.push(post);
    else if (platform === 'facebook') facebook.push(post);
  }
  return { facebook, gbp };
}

export function useMarketingData() {
  const today = chicagoToday();
  const weekStart = sundayOfWeek(today);
  const weekEnd = saturdayOfWeek(today);
  const configured = isSupabaseAvailable;

  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState([]);
  const [posts, setPosts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [health, setHealth] = useState(EMPTY_HEALTH);

  const reload = useCallback(async () => {
    if (!isSupabaseAvailable) {
      setLoading(false);
      setError(null);
      setRuns([]);
      setPosts([]);
      setTasks([]);
      setLogs([]);
      setHealth(EMPTY_HEALTH);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextRuns, nextPosts, nextTasks, nextLogs, nextHealth] = await Promise.all([
        fetchRuns(),
        fetchPosts(weekStart, weekEnd),
        fetchWebsiteTasks(),
        fetchRunLogs(),
        fetchLatestRunHealth(),
      ]);
      setRuns(nextRuns);
      setPosts(nextPosts);
      setTasks(nextTasks);
      setLogs(nextLogs);
      setHealth(nextHealth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [weekStart, weekEnd]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { facebook, gbp } = partitionPosts(posts);

  return {
    configured,
    loading,
    error,
    weekStart,
    weekEnd,
    today,
    runs,
    posts,
    facebook,
    gbp,
    tasks,
    logs,
    health,
    reload,
  };
}
