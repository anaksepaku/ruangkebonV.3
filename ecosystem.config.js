module.exports = {
  apps: [{
    name: 'my-app',
    script: './server.js', // file yang sama folder
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '800M',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
};
