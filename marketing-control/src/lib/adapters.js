import { isOnGraph } from './status.js';

/**
 * Shared adapter-readiness derivation for Today and Operations.
 * live_ready = something actually published; worker = queued for the 9am tick;
 * error = current-run recovery on that platform; unknown otherwise.
 */
export function deriveAdapters({ facebook, gbp, tasks, waitingOnOwner, runRecovery }) {
  const platformRecovery = (platform) =>
    (runRecovery || []).some((item) => String(item.platform || '') === platform);

  const facebookStatus = platformRecovery('facebook')
    ? 'error'
    : (facebook || []).some((p) => isOnGraph(p) || p.status === 'posted' || p.status === 'done')
      ? 'live_ready'
      : 'unknown';

  const gbpStatus = platformRecovery('gbp')
    ? 'error'
    : (gbp || []).some((p) => p.status === 'posted' || p.status === 'done')
      ? 'live_ready'
      : (gbp || []).some((p) => p.status === 'scheduled_native')
        ? 'worker'
        : 'unknown';

  const websiteStatus =
    (waitingOnOwner || []).length ||
    (tasks || []).some((t) => t.status === 'error' || t.status === 'failed')
      ? 'error'
      : (tasks || []).some((t) => t.status === 'done')
        ? 'live_ready'
        : 'unknown';

  return [
    { id: 'facebook', label: 'Facebook', status: facebookStatus },
    { id: 'gbp', label: 'GBP', status: gbpStatus },
    { id: 'website', label: 'Website', status: websiteStatus },
  ];
}
