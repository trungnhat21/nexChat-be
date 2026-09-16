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

                        echo "=== Checkout developer ==="
                        git checkout developer

                        OLD_COMMIT=$(git rev-parse HEAD)

                        echo "=== Fetch latest code ==="
                        git fetch origin
                        git reset --hard origin/developer

                        NEW_COMMIT=$(git rev-parse HEAD)

                        echo "Old commit: $OLD_COMMIT"
                        echo "New commit: $NEW_COMMIT"

                        echo "=== Check dependencies ==="
                        if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" \
                            | grep -Eq "^(package.json|package-lock.json)$"; then

                            echo "Dependencies changed -> npm i -f"
                            npm i -f
                        else
                            echo "Dependencies unchanged -> skip npm install"
                        fi

                        echo "=== Prisma DB Pull ==="
                        npx prisma db pull

                        echo "=== Prisma Generate ==="
                        npx prisma generate

                        echo "=== Build backend ==="
                        npm run build

                        echo "=== Restart PM2 ==="
                        pm2 restart nex-chat-be

                        echo "=== Deploy completed ==="
                    '
                '''
            }
        }
    }
}
