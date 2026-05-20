# AlgoCode — Notification Service

> Asynchronous, event-driven notification delivery for the AlgoCode online judge platform. Consumes verdict results from the BullMQ queue and delivers submission outcome notifications to users — decoupled from the execution pipeline.

---

## Table of Contents

- [Overview](#overview)
- [System Position](#system-position)
- [Why a Dedicated Notification Service?](#why-a-dedicated-notification-service)
- [Key Engineering Decisions](#key-engineering-decisions)
- [Tech Stack](#tech-stack)
- [Event Flow](#event-flow)
- [Notification Types](#notification-types)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Part of the AlgoCode Platform](#part-of-the-algocode-platform)

---

## Overview

When a user submits code on AlgoCode, they don't wait for a synchronous response. The submission is queued, the Evaluator processes it asynchronously, and once the verdict is ready, the Notification Service is responsible for telling the user what happened.

This service listens on a BullMQ result queue, processes verdict events, and delivers notifications — via email, in-app notification, or future channels — without the Evaluator or API Gateway needing to know or care about how delivery works.

---

## System Position

```
┌──────────────────────────────────────────────────────────┐
│                     AlgoCode Platform                     │
│                                                           │
│   Client ──► API Gateway ──► [submission enqueued]       │
│                                    │                      │
│                                    ▼                      │
│                             BullMQ Queue                  │
│                           (submissions)                   │
│                                    │                      │
│                                    ▼                      │
│                         Evaluator Service                  │
│                     (runs code, produces verdict)         │
│                                    │                      │
│                                    ▼                      │
│                             BullMQ Queue                  │
│                              (results)                    │
│                                    │                      │
│                                    ▼                      │
│                      ┌─────────────────────────┐         │
│                      │   Notification Service   │         │
│                      │  Consumer picks verdict  │         │
│                      │         │                │         │
│                      │         ▼                │         │
│                      │  Deliver notification    │         │
│                      │  (email / in-app)        │         │
│                      └─────────────────────────┘         │
│                                    │                      │
│                                    ▼                      │
│                                  User                     │
└──────────────────────────────────────────────────────────┘
```

---

## Why a Dedicated Notification Service?

### Problem: Tightly coupling delivery to execution is fragile
If the Evaluator sent notifications directly, a broken email provider would block the verdict from being recorded. A slow notification channel would slow down the execution pipeline. The two concerns have completely different failure modes and scaling profiles.

### Solution: Decouple via queue
The Evaluator's only responsibility is to produce a verdict and put it on a queue. It doesn't know or care what happens next. The Notification Service is the only consumer — it can fail, retry, and scale completely independently of the execution pipeline.

Benefits:
- **Resilience** — a notification failure doesn't affect verdict recording; BullMQ retries the job automatically
- **Extensibility** — adding a new delivery channel (SMS, Slack, webhook) means adding a handler here, not touching the Evaluator
- **Decoupled scaling** — notification throughput can be scaled independently; at high submission volumes, add more workers here without changing anything else

---

## Key Engineering Decisions

### 1. BullMQ consumer with automatic retries
The service registers a BullMQ worker on the results queue. On failure (e.g. email provider timeout), BullMQ automatically retries the job with configurable backoff. Failed jobs beyond the retry limit go to a dead-letter queue for inspection — no verdict notification is silently dropped.

```js
const worker = new Worker('results', processVerdictJob, {
  connection: redisConfig,
  concurrency: 5,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
});
```

### 2. Event-driven, not polling
The service never polls the database for new verdicts. It reacts to queue events — no wasted cycles, no lag introduced by polling intervals. When a verdict lands on the queue, the worker wakes up within milliseconds.

### 3. Nodemailer for email delivery
Email notifications use Nodemailer with a configurable SMTP transport. This means the service works with any SMTP provider — Gmail in development, SendGrid or AWS SES in production — by changing environment variables, not code.

### 4. Notification content driven by verdict type
Each verdict type maps to a distinct notification template. A user getting an `AC` (Accepted) gets a different message from one getting `WA` or `TLE`. Templates are kept in a dedicated `templates/` directory to separate content from delivery logic.

### 5. Structured logging per job
Every consumed job is logged with its `submissionId`, `userId`, `verdict`, and delivery outcome. This creates a full audit trail: if a user claims they never received a notification, the logs show exactly what happened at every step.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js | Event-loop model suits queue consumption |
| Queue | BullMQ + Redis | Reliable delivery, retry logic, dead-letter queue |
| Email | Nodemailer | Provider-agnostic SMTP transport |
| Logging | Winston | Structured per-job logs with correlation IDs |

---

## Event Flow

### 1. Verdict event consumed from queue

```json
// Job payload from BullMQ results queue
{
  "submissionId": "sub_abc123",
  "userId": "usr_xyz789",
  "problemId": "prob_001",
  "problemTitle": "Two Sum",
  "verdict": "AC",
  "language": "javascript",
  "executionTimeMs": 42,
  "memoryUsedMb": 14,
  "timestamp": "2025-06-01T10:30:00Z"
}
```

### 2. Notification assembled from template

```
Subject: ✅ Accepted — Two Sum

Your solution for "Two Sum" has been accepted.

Verdict:       Accepted (AC)
Language:      JavaScript
Runtime:       42ms
Memory:        14MB

Keep it up!
— AlgoCode
```

### 3. Delivery attempted with retry on failure

```
Job sub_abc123 → attempt 1 → SMTP timeout → retry in 2s
Job sub_abc123 → attempt 2 → delivered ✓ → job marked complete
```

---

## Notification Types

| Verdict | Subject Line | Tone |
|---|---|---|
| `AC` — Accepted | ✅ Accepted — {problem} | Celebratory |
| `WA` — Wrong Answer | ❌ Wrong Answer — {problem} | Informational |
| `TLE` — Time Limit Exceeded | ⏱ Time Limit Exceeded — {problem} | Informational |
| `MLE` — Memory Limit Exceeded | 💾 Memory Limit Exceeded — {problem} | Informational |
| `RE` — Runtime Error | ⚠️ Runtime Error — {problem} | Informational |
| `CE` — Compilation Error | 🔧 Compilation Error — {problem} | Informational |

---

## Project Structure

```
src/
├── config/
│   ├── redis.js           # BullMQ / Redis connection config
│   ├── mailer.js          # Nodemailer SMTP transport setup
│   └── logger.js          # Winston logger
├── consumers/
│   └── verdict.js         # BullMQ Worker — consumes result queue
├── handlers/
│   └── email.js           # Email delivery logic per verdict type
├── templates/
│   ├── accepted.js        # AC notification template
│   ├── wrongAnswer.js     # WA notification template
│   ├── timeLimitExceeded.js
│   ├── memoryLimitExceeded.js
│   ├── runtimeError.js
│   └── compilationError.js
└── index.js               # Bootstrap — connects Redis, starts workers
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- Redis running locally or via Docker
- SMTP credentials (Gmail, SendGrid, Mailtrap, etc.)

### Installation

```bash
git clone https://github.com/Algocode-dev/Notification-service.git
cd Notification-service
npm install
```

### Redis via Docker (quickest setup)

```bash
docker run -d \
  --name redis-algocode \
  -p 6379:6379 \
  redis:7-alpine
```

### Run

```bash
# Development
npm run dev

# Production
npm start
```

The worker will connect to Redis and immediately begin consuming from the `results` queue. It logs each consumed job to console and file.

---

## Environment Variables

Create a `.env` file in the root:

```env
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Queue names — must match Evaluator Service config
RESULT_QUEUE_NAME=results

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM="AlgoCode <no-reply@algocode.dev>"

# Worker
WORKER_CONCURRENCY=5
JOB_ATTEMPTS=3
```

> **Development tip:** Use [Mailtrap](https://mailtrap.io) as your SMTP provider during local development — it captures all outgoing emails without actually sending them.

---

## Part of the AlgoCode Platform

| Service | Repo | Description |
|---|---|---|
| API Gateway | [API_Gateway](https://github.com/Algocode-dev/API_Gateway) | Auth (JWT + RBAC), routing, entry point |
| Problem Service | [AlgoCode-problem-service](https://github.com/Algocode-dev/AlgoCode-problem-service) | Problem and test case management |
| Evaluator Service | [Algocode-Evaluator_Service](https://github.com/Algocode-dev/Algocode-Evaluator_Service) | Sandboxed code execution engine |
| **Notification Service** | **You are here** | Async event-driven result delivery |
