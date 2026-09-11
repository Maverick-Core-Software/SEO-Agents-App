// PM2 process definition for the Facebook comment agent.
// Secrets come from .env (loaded by the script itself) — never hardcode here.
module.exports = {
  apps: [
    {
      name: 'fb-comment-agent',
      script: 'C:\\Workspace\\Active\\SEO-Agents-App\\scripts\\facebook-comment-agent.mjs',
      cwd: 'C:\\Workspace\\Active\\SEO-Agents-App',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        PORT: '8795',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      windowsHide: true,
    },
    {
      // GBP worker under pm2 (service session 0) since 2026-09-11. It used to run
      // from the 'Grizzly SEO GBP Worker' scheduled task in the interactive desktop
      // session, where the headed Playwright Chromium it needs for Google Business
      // Profile cannot initialise while the desktop is locked (every 9:00 post
      // timed out at launchPersistentContext on 2026-09-11 after the PC was locked
      // the night before). The task-launched instance still starts each morning
      // and exits at once on the single-instance pidfile lock.
      name: 'gbp-worker',
      // gbp-worker-service.mjs sets argv[1] then imports gbp-worker.mjs; pm2's fork
      // wrapper otherwise trips the worker's import-safe guard and it never starts.
      script: 'C:\\Workspace\\Active\\SEO-Agents-App\\scripts\\gbp-worker-service.mjs',
      cwd: 'C:\\Workspace\\Active\\SEO-Agents-App',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 15000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      windowsHide: true,
    },
    {
      name: 'thumbtack-worker',
      script: 'C:\\Workspace\\Active\\SEO-Agents-App\\scripts\\thumbtack-worker.mjs',
      cwd: 'C:\\Workspace\\Active\\SEO-Agents-App',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        PORT: '8796',
        THUMBTACK_BIND: '127.0.0.1',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      windowsHide: true,
    },
  ],
};
