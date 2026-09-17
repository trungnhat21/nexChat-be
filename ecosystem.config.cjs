module.exports = {
    apps: [
        {
            name: "nex-chat-be",
            script: "dist/main.js",
            cwd: __dirname,
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            watch: false,
            max_memory_restart: "512M",
            env_production: {
                NODE_ENV: "production",
            },
        },
    ],
};
