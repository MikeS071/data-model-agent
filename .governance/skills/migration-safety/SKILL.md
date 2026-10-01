---
name: migration-safety
description: Plan or review a database schema or data migration against real data, deployment order, and recovery needs.
---

# Migration safety

Identify the current schema, real callers, data volume, database engine, and deployment sequence before changing persisted structure. Separate the intended end state from the path that gets there. For a live system, assess locks, long transactions, backfill cost, mixed-version compatibility, and constraints on existing rows using engine-specific behavior.

Prefer staged expansion and removal when old and new application versions may coexist. Make backfills resumable or safely repeatable where interruption is possible. Verify the migration and affected reads/writes on representative disposable data; never run destructive or production migration commands merely to test a plan.

State how to detect failure and recover, including when reversal is unsafe and a forward repair is needed. Preserve already deployed migration history unless the project's migration tool and rollout plan explicitly permit a change. Treat engine-specific SQL, rollback syntax, and zero-downtime claims as facts to verify for the actual target.
