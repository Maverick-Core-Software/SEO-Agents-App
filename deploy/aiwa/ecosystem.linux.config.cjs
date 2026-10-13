// PM2 definitions for the AIWA SEO host (Debian 12 LXC `seo-prod`, app root /opt/seo).
// Cutover item B4. Long-running apps only; the Friday and daily jobs are systemd
// timers (deploy/aiwa/systemd/*.timer).
//
// Secrets: none in this file. Each script loads /opt/seo/.env itself from its
// PROJECT_ROOT (mav-bridge.mjs:43-47, gbp-worker.mjs:34-36, facebook-comment-agent.mjs:35-37),
// so no env_file option is needed. The .env is shipped and checked by render-env.sh (decision D2).
//
// Known gap: mav-bridge.mjs listens on a hard-coded 127.0.0.1 (scripts/mav-bridge.mjs:1473) and
// has no bind-host env. MCC on CT 103 cannot reach it until one exists. See deploy/aiwa/README.md.
//
// Deploy: pm2 start deploy/aiwa/ecosystem.linux.config.cjs && pm2 save
// install.sh does NOT start these apps. Each start is a Carter-approved step.

const APP_ROOT = '/opt/seo';
const ENV = { TZ: 'America/Chicago', NODE_ENV: 'production' };

const base = {
  cwd: APP_ROOT,
  interpreter: 'node',
  watch: false,
  autorestart: true,
  max_restarts: 10,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
};

const logs = (name) => ({
  out_file: `${APP_ROOT}/logs/${name}.log`,
  error_file: `${APP_ROOT}/logs/${name}.log`,
  merge_logs: true,
});

module.exports = {
  apps: [
    {
      ...base,
      ...logs('mav-bridge'),
      name: 'mav-bridge',
      script: `${APP_ROOT}/scripts/mav-bridge.mjs`,
      restart_delay: 5000,
      env: { ...ENV },
    },
    {
      ...base,
      ...logs('gbp-worker'),
      name: 'gbp-worker',
      // gbp-worker-service.mjs sets argv[1] then imports gbp-worker.mjs. A pm2 fork
      // wrapper that imports gbp-worker.mjs directly trips its import-safe guard and
      // the worker never starts (same reason as the PC ecosystem.config.cjs).
      script: `${APP_ROOT}/scripts/gbp-worker-service.mjs`,
      restart_delay: 15000,
      env: { ...ENV, GBP_POSTER: 'api' },
    },
    {
      ...base,
      ...logs('fb-comment-agent'),
      name: 'fb-comment-agent',
      script: `${APP_ROOT}/scripts/facebook-comment-agent.mjs`,
      restart_delay: 5000,
      // The PC file sets PORT, which this script never reads. The port variable is FB_COMMENT_AGENT_PORT.
      // The script still listens on all interfaces; B6 moves it to 127.0.0.1 by default.
      env: { ...ENV, FB_COMMENT_AGENT_PORT: '8795' },
    },
  ],
};
