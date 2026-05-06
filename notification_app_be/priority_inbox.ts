import { initLogger, Log } from "../logging_middleware/src/logger";

const BASE_URL    = "http://20.207.122.201/evaluation-service";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? "";
const DEFAULT_TOP_N = 10;

type NotificationType = "Placement" | "Result" | "Event";

interface RawNotification {
  ID: string;
  Type: NotificationType;
  Message: string;
  Timestamp: string;    
}

interface ApiNotificationResponse {
  notifications: RawNotification[];
}

interface ScoredNotification {
  id: string;
  type: NotificationType;
  message: string;
  timestamp: string;
  score: number;
  hoursSince: number;
}

const TYPE_WEIGHT: Record<NotificationType, number> = {
  Placement: 3,
  Result:    2,
  Event:     1,
};

class MinHeap {
  private heap: ScoredNotification[] = [];

  get size(): number { return this.heap.length; }
  get min(): ScoredNotification { return this.heap[0]; }

  push(item: ScoredNotification): void {
    this.heap.push(item);
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): ScoredNotification | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].score <= this.heap[i].score) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.heap[l].score < this.heap[smallest].score) smallest = l;
      if (r < n && this.heap[r].score < this.heap[smallest].score) smallest = r;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }

  toSortedDesc(): ScoredNotification[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }
}

function parseTimestamp(ts: string): Date {

  return new Date(ts.replace(" ", "T") + "Z");
}

function computeScore(notification: RawNotification, now: Date): number {
  const weight = TYPE_WEIGHT[notification.Type] ?? 1;
  const created = parseTimestamp(notification.Timestamp);
  const hoursSince = (now.getTime() - created.getTime()) / (1000 * 60 * 60);
  return weight / (1 + hoursSince);
}

async function fetchNotifications(): Promise<RawNotification[]> {
  await Log("backend", "info", "api", "Fetching notifications from evaluation API");

  const res = await fetch(`${BASE_URL}/notifications`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });

  if (!res.ok) {
    const body = await res.text();
    await Log("backend", "error", "api", `Notifications API error ${res.status}: ${body}`);
    throw new Error(`Notifications API error: ${res.status}`);
  }

  const data: ApiNotificationResponse = await res.json();
  await Log("backend", "info", "api", `Fetched ${data.notifications.length} notifications`);
  return data.notifications;
}

function getTopN(notifications: RawNotification[], n: number): ScoredNotification[] {
  const now = new Date();
  const heap = new MinHeap();

  for (const notif of notifications) {
    const score = computeScore(notif, now);
    const created = parseTimestamp(notif.Timestamp);
    const hoursSince = (now.getTime() - created.getTime()) / (1000 * 60 * 60);

    const scored: ScoredNotification = {
      id: notif.ID,
      type: notif.Type,
      message: notif.Message,
      timestamp: notif.Timestamp,
      score,
      hoursSince: Math.round(hoursSince * 10) / 10,
    };

    if (heap.size < n) {
      heap.push(scored);
    } else if (score > heap.min.score) {
      heap.pop();
      heap.push(scored);
    }
  }

  return heap.toSortedDesc();
}

async function main() {
  initLogger({ accessToken: ACCESS_TOKEN, consoleOutput: true });

  const topN = parseInt(process.argv[2] ?? String(DEFAULT_TOP_N), 10);

  await Log("backend", "info", "handler", `Priority Inbox starting — fetching top ${topN} notifications`);

  let notifications: RawNotification[];
  try {
    notifications = await fetchNotifications();
  } catch (err) {
    await Log("backend", "fatal", "handler", `Failed to fetch notifications: ${err}`);
    process.exit(1);
  }

  await Log(
    "backend",
    "info",
    "handler",
    `Computing priority scores for ${notifications.length} notifications`
  );

  const topNotifications = getTopN(notifications, topN);

  await Log(
    "backend",
    "info",
    "handler",
    `Top ${topN} priority notifications computed successfully`
  );

  console.log("\n" + "═".repeat(80));
  console.log(`  PRIORITY INBOX — TOP ${topN} NOTIFICATIONS`);
  console.log("═".repeat(80));
  console.log(
    `  Score formula: typeWeight / (1 + hoursSinceCreated)`
  );
  console.log(`  Weights: Placement=3  Result=2  Event=1`);
  console.log("─".repeat(80));

  topNotifications.forEach((n, i) => {
    const rank = String(i + 1).padStart(2, " ");
    const typeTag = n.type.padEnd(10);
    const score = n.score.toFixed(4).padStart(8);
    console.log(`  ${rank}. [${typeTag}] score=${score}  (${n.hoursSince}h ago)`);
    console.log(`      ID: ${n.id}`);
    console.log(`      "${n.message}"`);
    console.log(`      At: ${n.timestamp}`);
    console.log();
  });

  console.log("═".repeat(80));
  console.log(`  Total notifications fetched : ${notifications.length}`);
  console.log(`  Top N returned              : ${topNotifications.length}`);
  console.log("═".repeat(80) + "\n");

  console.log("JSON Output:");
  console.log(JSON.stringify({ topN, notifications: topNotifications }, null, 2));
}

main().catch(async (err) => {
  await Log("backend", "fatal", "handler", `Unhandled error in priority inbox: ${err}`);
  console.error(err);
  process.exit(1);
});
