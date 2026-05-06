# Notification System Design

---

## Stage 1

### REST API Design

#### Core Entities & Actions

The notification platform supports three core actions for a logged-in student:
1. Fetch all notifications (with pagination)
2. Fetch a single notification
3. Mark a notification as read
4. Mark all notifications as read

Real-time delivery is handled via **Server-Sent Events (SSE)** (described below).

---

### Endpoints

#### `GET /api/v1/notifications`

Fetch paginated notifications for the authenticated student.

**Headers**
```
Authorization: Bearer <token>
```

**Query Parameters**

| Param    | Type   | Required | Description                          |
|----------|--------|----------|--------------------------------------|
| `page`   | number | No       | Page number, default `1`             |
| `limit`  | number | No       | Items per page, default `20`, max `100` |
| `type`   | string | No       | Filter by type: `Placement`, `Event`, `Result` |
| `isRead` | bool   | No       | Filter by read status                |

**Response `200 OK`**
```json
{
  "notifications": [
    {
      "id": "uuid",
      "studentID": "uuid",
      "type": "Placement",
      "message": "Google hiring drive on May 20",
      "isRead": false,
      "createdAt": "2026-04-22T17:51:30Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 134,
    "totalPages": 7
  }
}
```

---

#### `GET /api/v1/notifications/:id`

Fetch a single notification by ID.

**Headers**
```
Authorization: Bearer <token>
```

**Response `200 OK`**
```json
{
  "id": "uuid",
  "studentID": "uuid",
  "type": "Result",
  "message": "mid-sem results published",
  "isRead": false,
  "createdAt": "2026-04-22T17:50:54Z"
}
```

**Response `404 Not Found`**
```json
{ "error": "Notification not found" }
```

---

#### `PATCH /api/v1/notifications/:id/read`

Mark a single notification as read.

**Headers**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Response `200 OK`**
```json
{ "id": "uuid", "isRead": true }
```

---

#### `PATCH /api/v1/notifications/read-all`

Mark all unread notifications as read for the authenticated student.

**Headers**
```
Authorization: Bearer <token>
```

**Response `200 OK`**
```json
{ "updated": 12 }
```

---

#### `POST /api/v1/notifications` *(internal / admin)*

Create a new notification (called by internal services, not the student).

**Headers**
```
Authorization: Bearer <internal-service-token>
Content-Type: application/json
```

**Request Body**
```json
{
  "studentID": "uuid",
  "type": "Placement",
  "message": "Amazon SDE hiring — apply by May 30"
}
```

**Response `201 Created`**
```json
{
  "id": "uuid",
  "studentID": "uuid",
  "type": "Placement",
  "message": "Amazon SDE hiring — apply by May 30",
  "isRead": false,
  "createdAt": "2026-05-06T10:00:00Z"
}
```

---

### Real-Time Notifications — Server-Sent Events (SSE)

#### `GET /api/v1/notifications/stream`

Opens a persistent SSE connection. The server pushes new notifications to the student as they arrive. SSE is chosen over WebSockets because:
- Notifications are **server → client only** (no bidirectional need)
- SSE works natively over HTTP/1.1 with automatic reconnection
- Simpler infrastructure — no upgrade handshake or separate WS server

**Headers**
```
Authorization: Bearer <token>
Accept: text/event-stream
```

**Stream event format**
```
event: notification
data: {"id":"uuid","type":"Placement","message":"Google hiring","isRead":false,"createdAt":"..."}

event: ping
data: {}
```

The server sends a `ping` event every 30 seconds to keep the connection alive and detect stale clients.

---

### JSON Schemas

#### Notification Object
```json
{
  "id":        { "type": "string", "format": "uuid" },
  "studentID": { "type": "string", "format": "uuid" },
  "type":      { "type": "string", "enum": ["Placement", "Event", "Result"] },
  "message":   { "type": "string", "maxLength": 512 },
  "isRead":    { "type": "boolean", "default": false },
  "createdAt": { "type": "string", "format": "date-time" }
}
```

#### Pagination Object
```json
{
  "page":       { "type": "integer", "minimum": 1 },
  "limit":      { "type": "integer", "minimum": 1, "maximum": 100 },
  "total":      { "type": "integer" },
  "totalPages": { "type": "integer" }
}
```

---

## Stage 2

### Persistent Storage Choice: PostgreSQL

**Why PostgreSQL?**
- Strong ACID guarantees — critical for "mark as read" state correctness
- Native `UUID` type, `ENUM` support, `TIMESTAMPTZ`
- Rich indexing options (B-tree, partial indexes) to handle the query patterns below
- JSON columns available if we later want to attach metadata to notifications
- Mature ecosystem, easy to run managed (RDS, Supabase, etc.)

---

### DB Schema

```sql
-- Enum for notification type
CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');

-- Core notifications table
CREATE TABLE notifications (
  id          UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID              NOT NULL,
  type        notification_type NOT NULL,
  message     TEXT              NOT NULL,
  is_read     BOOLEAN           NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Index: fetch unread notifications for a student, newest first (the common read path)
CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;

-- Index: fetch all notifications for a student (paginated list)
CREATE INDEX idx_notifications_student_created
  ON notifications (student_id, created_at DESC);
```

---

### Queries (based on Stage 1 APIs)

#### Fetch paginated notifications for a student
```sql
SELECT id, student_id, type, message, is_read, created_at
FROM   notifications
WHERE  student_id = $1
ORDER  BY created_at DESC
LIMIT  $2
OFFSET $3;
```

#### Fetch unread notifications for a student
```sql
SELECT id, student_id, type, message, is_read, created_at
FROM   notifications
WHERE  student_id = $1
  AND  is_read = FALSE
ORDER  BY created_at DESC;
```

#### Mark a single notification as read
```sql
UPDATE notifications
SET    is_read = TRUE
WHERE  id = $1
  AND  student_id = $2
RETURNING id, is_read;
```

#### Mark all notifications as read
```sql
UPDATE notifications
SET    is_read = TRUE
WHERE  student_id = $1
  AND  is_read = FALSE;
```

#### Insert a new notification
```sql
INSERT INTO notifications (student_id, type, message)
VALUES ($1, $2, $3)
RETURNING *;
```

---

### Problems as Data Volume Grows & Solutions

| Problem | Cause | Solution |
|---|---|---|
| Slow student notification queries | Full table scans as rows → millions | Partial index on `(student_id, created_at DESC) WHERE is_read = FALSE` (already above) |
| Index bloat on `notifications` | High insert rate from mass notifications | Use `FILLFACTOR 70` on the table; autovacuum tuning |
| Single Postgres bottleneck | 50 k students × many notifications | **Read replicas** for GET endpoints; primary only for writes |
| `mark-all-read` locks rows for long time | 50 k rows updated in one transaction | Batch updates in chunks of 1 000 with `LIMIT` + loop |
| Historical data slowing queries | Old read notifications never purged | **Table partitioning** by `created_at` (monthly); archive partitions to cold storage |
| Connection exhaustion | Many concurrent students | **PgBouncer** connection pooler in front of Postgres |

---

## Stage 3

### Query Analysis

The query in question:
```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

**Why is this slow at scale?**

With 50 000 students and 5 000 000 notifications, this query performs a **full sequential scan** of the `notifications` table because there is no composite index on `(studentID, isRead, createdAt)`. PostgreSQL must read every row, filter it, and then sort — O(N) scan + O(k log k) sort, where N = 5 M and k = matching rows.

**Is `SELECT *` a problem?**
Yes. `SELECT *` fetches all columns (including large `message` text), increasing I/O and network transfer. Always project only the columns you need.

**Is adding an index on every column safe?**
No — this is harmful advice. Indexes:
- Consume disk space proportional to table size
- Must be maintained on every `INSERT`, `UPDATE`, `DELETE`, adding write latency
- For a high-write notification table (bulk inserts on placement drives), over-indexing degrades throughput significantly

**Recommended fix:**

```sql
-- Partial composite index: only indexes unread rows, keeping the index small
CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, created_at DESC)
  WHERE is_read = FALSE;
```

**Improved query:**
```sql
SELECT id, type, message, created_at
FROM   notifications
WHERE  student_id = 1042
  AND  is_read    = FALSE
ORDER  BY created_at DESC;
```

This query now uses an **Index Scan** on `idx_notifications_student_unread` — effectively O(log N + k) instead of O(N).

**Query to find all students who got a Placement notification in the last 7 days:**

```sql
SELECT DISTINCT student_id
FROM   notifications
WHERE  type       = 'Placement'
  AND  created_at >= NOW() - INTERVAL '7 days';
```

Supporting index:
```sql
CREATE INDEX idx_notifications_type_created
  ON notifications (type, created_at DESC);
```

---

## Stage 4

### Notification Fetching Performance — Reducing DB Load

**Problem:** Notifications are fetched on every page load for every student → DB overwhelmed.

---

### Strategy 1 — Application-Level Caching (Redis)

Cache the notification list per student in Redis with a short TTL (e.g. 30–60 seconds).

**Flow:**
1. On GET `/notifications`, check Redis key `notif:student:{id}`
2. Cache hit → return immediately (no DB)
3. Cache miss → query DB, write result to Redis with TTL, return
4. On new notification insert → invalidate (or update) the student's cache key

**Tradeoffs:**
- ✅ Massive reduction in read DB queries (cache hit rate typically >90% for active users)
- ✅ Sub-millisecond response for cached requests
- ⚠️ Stale data window equal to TTL (acceptable for notifications — 30 s is fine)
- ⚠️ Cache invalidation logic must be maintained; bugs cause stale reads
- ⚠️ Adds operational complexity (Redis cluster, memory limits)

---

### Strategy 2 — Pagination + Limit Query Scope

Instead of fetching all notifications, always paginate and return only recent unread ones.

**Changes:**
- Default `limit=20`, `page=1` — never return the full history
- Use cursor-based pagination (by `created_at`) instead of OFFSET for large tables (OFFSET scans skipped rows)

**Tradeoffs:**
- ✅ Each query is fast and bounded — DB does far less work per request
- ✅ No additional infrastructure needed
- ⚠️ Client must implement pagination UI
- ⚠️ Doesn't help if 1 000 students all load page 1 simultaneously (still 1 000 queries)

---

### Strategy 3 — Read Replica for GET Requests

Route all read (GET) queries to a PostgreSQL read replica; writes go to the primary.

**Tradeoffs:**
- ✅ Horizontally scalable — add replicas as load grows
- ✅ Completely transparent to the application layer (connection string switch)
- ⚠️ Replication lag (typically <1 s) means a student might not immediately see a notification they just received
- ⚠️ Cost of running replica instances

---

### Recommended Combined Approach

1. **Redis cache** (Strategy 1) for the unread notification count and the first page of notifications — these are fetched on every page load and are the hottest path.
2. **Cursor pagination** (Strategy 2) for subsequent pages — eliminates OFFSET cost.
3. **Read replica** (Strategy 3) as traffic grows past a single DB node's capacity.

---

## Stage 5

### Analysis of `notify_all` Pseudocode

```
function notify_all(student_ids, message):
  for student_id in student_ids:
    send_email(student_id, message)   # calls Email API
    save_to_db(student_id, message)   # DB insert
    push_to_app(student_id, message)  # real-time push
```

**Shortcomings:**

1. **Sequential loop** — processing 50 000 students one-by-one is extremely slow. A single failure (e.g. the email API timing out) blocks all subsequent students.
2. **Tight coupling** — email, DB write, and push are called synchronously in the same loop iteration. If `send_email` fails halfway (as observed for 200 students), the DB has partial state and real-time pushes haven't happened yet for those students.
3. **No retry / error handling** — a transient email API failure at student 10 000 aborts the remaining 40 000.
4. **All-or-nothing atomicity is broken** — DB inserts succeed for some students, emails fail for others; state is inconsistent.
5. **No back-pressure** — fires all 50 000 requests concurrently or sequentially with no rate limiting, overwhelming downstream APIs.

---

### Redesigned Approach: Message Queue + Worker Pattern

**Core principle:** decouple "recording the notification" (DB write) from "delivering it" (email + push). The DB write is the source of truth; delivery is best-effort with retries.

**Revised Pseudocode:**

```
function notify_all(student_ids, message):
  # Step 1: Bulk-insert all notifications into DB atomically
  # This is fast and reliable — if it fails, nothing was sent yet
  notification_records = bulk_insert_db(student_ids, message)
  # notification_records = [{id, student_id, message}, ...]

  # Step 2: Enqueue a delivery job for each notification
  for record in notification_records:
    enqueue(queue="notification_delivery", payload={
      notification_id: record.id,
      student_id:      record.student_id,
      message:         record.message
    })

  # Done — returns immediately; workers handle the rest

# ── Worker (runs N parallel instances) ──────────────────────────────────────
function delivery_worker():
  while true:
    job = dequeue("notification_delivery")   # blocks until job available

    try:
      send_email(job.student_id, job.message)
      push_to_app(job.student_id, job.message)
      acknowledge(job)                        # remove from queue

    except TransientError:
      retry_with_backoff(job, max_retries=5)  # re-enqueue with delay

    except PermanentError:
      move_to_dead_letter_queue(job)          # log, alert, do not retry
      log_error("Delivery failed permanently", job)
```

**Why this is better:**

| Concern | Old | New |
|---|---|---|
| Email fails midway | Remaining students not notified | Job re-queued; only failed students retried |
| DB + email atomicity | Broken | DB written first (source of truth); delivery is async best-effort |
| Speed | Sequential, ~50 000 serial calls | Bulk DB insert + parallel workers |
| Back-pressure | None | Queue acts as buffer; workers consume at safe rate |
| Observability | None | Dead-letter queue captures all failures for alerting |

**Should DB save and email happen together?**

No — they should be **separated**. The DB insert is fast, reliable, and idempotent. Email delivery is slow, rate-limited, and failure-prone. Coupling them means a flaky email API corrupts your data consistency. The DB is the record of what was sent; email is a side effect that can be retried independently.

---

## Stage 6

### Priority Inbox — Top N Most Important Unread Notifications

#### Problem Statement

Display the top N unread notifications to a student, ordered by **priority** — a combination of:
- **Weight** (type importance): `Placement > Result > Event`
- **Recency** (more recent = higher priority)

New notifications keep coming in. We must efficiently maintain the top-N as the stream grows.

---

### Priority Score Formula

```
priority_score = type_weight × recency_factor

type_weight:
  Placement → 3
  Result    → 2
  Event     → 1

recency_factor = 1 / (1 + hours_since_created)
  (so a notification from 1 hour ago scores higher than one from 10 hours ago)

final_score = type_weight / (1 + hours_since_notification_created)
```

This produces a real-valued score where a fresh Placement notification always outranks an old Event, but a very recent Event can outrank an old Placement.

---

### Implementation

We use a **Min-Heap of size N** to maintain the top-N efficiently.

**Algorithm:**
1. Fetch all unread notifications from the API (or DB)
2. Iterate through each notification, compute its priority score
3. Maintain a min-heap of size N:
   - If heap has fewer than N items → push
   - Else if current score > heap minimum → pop min, push current
4. Return heap contents sorted descending by score

**Complexity:**
- Time: O(M log N) where M = total unread notifications, N = top-N size
- Space: O(N) for the heap

This is far better than sorting all M notifications O(M log M) and slicing.

---

### Maintaining Top-N as New Notifications Arrive

Since new notifications keep coming in, we need an efficient update strategy:

**Approach — Lazy Re-score with Invalidation:**
1. Cache the current top-N heap in Redis (keyed by `priority_inbox:{student_id}`)
2. When a new notification arrives for a student (via the SSE stream or a webhook):
   - Compute its score
   - If score > minimum score in cached heap → push to heap, pop old minimum, re-cache
   - Else → discard (it won't make it into top-N)
3. Periodically (every 5 minutes) recompute the full heap from DB to correct for score decay over time (recency factor decreases as notifications age)

This means updates to the priority inbox are O(log N) per new notification — extremely efficient.

---

### Code

See `notification_app_be/priority_inbox.ts` for the full implementation.

---

### Output

The implementation fetches live notifications from the evaluation API, computes priority scores, and outputs the top-N list. Screenshots of output are included in the repository.
