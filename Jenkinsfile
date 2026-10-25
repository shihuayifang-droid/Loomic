// HaHart P0 CI pipeline (OP-12).
// Declarative pipeline only: no plugin-specific steps beyond core `sh` / `echo`.
// Design notes, per-stage requirement mapping, known debt and how to create the
// job on the .37 Jenkins: see deploy/CI.md.
//
// Every `sh` command below is copied verbatim from the command list in the
// OP-12 ticket. Do not introduce new npm/pnpm scripts here.

pipeline {
    // .37 already has a node labelled `any`.
    agent { label 'any' }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 45, unit: 'MINUTES')
    }

    environment {
        CI = 'true'
        NEXT_PUBLIC_HAHART_AUTH_PROVIDER = 'self'
        NEXT_PUBLIC_SERVER_BASE_URL = 'http://127.0.0.1:3001'
    }

    stages {
        // Other packages consume @loomic/shared/dist, so it must be built first.
        stage('Build shared') {
            steps {
                sh 'pnpm --filter @loomic/shared build'
            }
        }

        // Both typechecks must pass; either one failing fails the stage.
        // This stage is the hook for the OP-12 acceptance check
        // "commit a deliberate typecheck error -> pipeline fails".
        stage('Typecheck') {
            steps {
                sh 'pnpm --filter @loomic/server typecheck'
                sh 'pnpm --filter @loomic/web exec tsc --noEmit'
            }
        }

        // Server suite only. `pnpm --filter @loomic/web test` is intentionally
        // NOT part of this pipeline yet: it has pre-existing failing tests and
        // would make CI permanently red. See deploy/CI.md for the debt + plan.
        stage('Unit tests') {
            steps {
                sh 'pnpm --filter @loomic/server test'
            }
        }

        // Invariants must run with --allow-skips (backlog item T-163):
        // two legacy Supabase check scripts can never have their env values in
        // this deployment, so without the flag the gate is red forever.
        // --allow-skips reports them as SKIP instead of FAIL.
        stage('Invariants') {
            steps {
                sh 'node scripts/check-invariants.mjs --allow-skips'
            }
        }

        // Web build produces out/ , which the Playwright run needs.
        // E2E runs against mocked providers: no real API calls, no billing.
        stage('Web build + E2E') {
            steps {
                sh 'pnpm --filter @loomic/web build'
                sh 'pnpm --filter @loomic/web e2e'
            }
        }
    }

    post {
        always {
            echo "HaHart CI finished: job=${env.JOB_NAME} build=${env.BUILD_NUMBER} result=${currentBuild.currentResult}"
            echo "reminder: deploy/CI.md documents why web unit tests are out of scope for now (pre-existing failures)."
        }
    }
}
