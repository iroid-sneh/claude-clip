// pm2 config for the team share server on the dev box:
//   pm2 start ecosystem.config.cjs && pm2 save
// Settings come from .env.production (copy .env.example). Needs Node >= 22.6.
module.exports = {
  apps: [
    {
      name: 'claude-clip-share',
      cwd: __dirname,
      script: 'node',
      args: '--experimental-strip-types --env-file=.env.production server/share.ts',
      interpreter: 'none',
      autorestart: true,
      max_memory_restart: '1G',
    },
  ],
}
