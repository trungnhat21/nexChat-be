pipeline {
    agent any

    stages {
        stage('Deploy Backend') {
            steps {
                sh '''
                    ssh -o StrictHostKeyChecking=no ubuntu@129.146.54.70 '
                        set -e

                        export NVM_DIR="$HOME/.nvm"
                        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"


                        cd /mnt/var/www/nex-chat/nex-chat-be

                        echo "=== Runtime ==="
                        node -v
                        npm -v
                        pm2 -v
                        node -e "if (Number(process.versions.node.split(String.fromCharCode(46))[0]) < 20) process.exit(1)"

                        echo "=== Fetch latest code ==="
                        git fetch origin developer
                        git checkout -f developer
                        git reset --hard origin/developer

                        echo "=== Install dependencies ==="
                        npm ci --include=dev

                        echo "=== Prisma Generate ==="
                        npx prisma generate

                        echo "=== Build NestJS backend ==="
                        npm run build

                        test -f dist/main.js

                        echo "=== Reload NestJS application with PM2 ==="
                        pm2 startOrReload ecosystem.config.cjs --env production
                        pm2 save
                        pm2 describe nex-chat-be

                        echo "=== Deploy completed ==="
                    '
                '''
            }
        }
    }
}
