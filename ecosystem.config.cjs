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
  ],
};
