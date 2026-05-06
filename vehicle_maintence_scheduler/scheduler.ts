import { initLogger, Log } from "../logging_middleware/src/logger";

interface Task {
  TaskID: string;
  Duration: number;
  Impact: number;
}

interface Depot {
  ID: number;
  MechanicHours: number;
}

interface ScheduledDepot {
  depotID: number;
  budget: number;
  selectedTasks: Task[];
  totalDuration: number;
  totalImpact: number;
}

interface ApiDepotResponse {
  depots: Depot[];
}

interface ApiVehicleResponse {
  vehicles: Task[];
}

const BASE_URL = "http://20.207.122.201/evaluation-service";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? "";

initLogger({ accessToken: ACCESS_TOKEN, consoleOutput: true });

async function fetchDepots(): Promise<Depot[]> {
  await Log("backend", "info", "service", "Fetching depots from evaluation API");
  const res = await fetch(`${BASE_URL}/depots`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    await Log("backend", "error", "service", `Depot API responded with status ${res.status}`);
    throw new Error(`Depot API error: ${res.status}`);
  }
  const data: ApiDepotResponse = await res.json();
  await Log("backend", "info", "service", `Fetched ${data.depots.length} depots successfully`);
  return data.depots;
}

async function fetchVehicles(): Promise<Task[]> {
  await Log("backend", "info", "service", "Fetching vehicles (tasks) from evaluation API");
  const res = await fetch(`${BASE_URL}/vehicles`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    await Log("backend", "error", "service", `Vehicle API responded with status ${res.status}`);
    throw new Error(`Vehicle API error: ${res.status}`);
  }
  const data: ApiVehicleResponse = await res.json();
  await Log("backend", "info", "service", `Fetched ${data.vehicles.length} vehicles successfully`);
  return data.vehicles;
}

function knapsack(tasks: Task[], budget: number): Task[] {
  const n = tasks.length;
  const W = budget;

  const dp = new Int32Array((n + 1) * (W + 1));

  for (let i = 1; i <= n; i++) {
    const task = tasks[i - 1];
    const dur = task.Duration;
    const imp = task.Impact;

    for (let w = 0; w <= W; w++) {

      dp[i * (W + 1) + w] = dp[(i - 1) * (W + 1) + w];

      if (dur <= w) {
        const withItem = dp[(i - 1) * (W + 1) + (w - dur)] + imp;
        if (withItem > dp[i * (W + 1) + w]) {
          dp[i * (W + 1) + w] = withItem;
        }
      }
    }
  }

  const selected: Task[] = [];
  let w = W;
  for (let i = n; i >= 1; i--) {
    if (dp[i * (W + 1) + w] !== dp[(i - 1) * (W + 1) + w]) {
      selected.push(tasks[i - 1]);
      w -= tasks[i - 1].Duration;
    }
  }

  return selected.reverse();
}

async function main() {
  await Log("backend", "info", "handler", "Vehicle Maintenance Scheduler starting");

  let depots: Depot[];
  let vehicles: Task[];

  try {
    [depots, vehicles] = await Promise.all([fetchDepots(), fetchVehicles()]);
  } catch (err) {
    await Log("backend", "fatal", "handler", `Failed to fetch data from API: ${err}`);
    process.exit(1);
  }

  await Log(
    "backend",
    "info",
    "handler",
    `Processing ${depots.length} depots with ${vehicles.length} total tasks`
  );

  const results: ScheduledDepot[] = [];

  for (const depot of depots) {
    await Log(
      "backend",
      "debug",
      "service",
      `Running knapsack for Depot ${depot.ID} — budget: ${depot.MechanicHours} hours, tasks: ${vehicles.length}`
    );

    const selected = knapsack(vehicles, depot.MechanicHours);
    const totalDuration = selected.reduce((s, t) => s + t.Duration, 0);
    const totalImpact = selected.reduce((s, t) => s + t.Impact, 0);

    const scheduledDepot: ScheduledDepot = {
      depotID: depot.ID,
      budget: depot.MechanicHours,
      selectedTasks: selected,
      totalDuration,
      totalImpact,
    };

    results.push(scheduledDepot);

    await Log(
      "backend",
      "info",
      "service",
      `Depot ${depot.ID}: selected ${selected.length} tasks — ` +
        `${totalDuration}h used / ${depot.MechanicHours}h budget — ` +
        `total impact: ${totalImpact}`
    );
  }

  console.log("\n" + "═".repeat(72));
  console.log("  VEHICLE MAINTENANCE SCHEDULE");
  console.log("═".repeat(72));

  for (const depot of results) {
    console.log(`\n▸ Depot ${depot.depotID}`);
    console.log(
      `  Budget: ${depot.budget}h  |  Used: ${depot.totalDuration}h  |  Impact: ${depot.totalImpact}`
    );
    console.log(`  Tasks scheduled (${depot.selectedTasks.length}):`);
    for (const task of depot.selectedTasks) {
      console.log(`    • ${task.TaskID}  [${task.Duration}h, impact=${task.Impact}]`);
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log("  SUMMARY");
  console.log("═".repeat(72));

  const grandImpact = results.reduce((s, d) => s + d.totalImpact, 0);
  const grandHours = results.reduce((s, d) => s + d.totalDuration, 0);
  const grandBudget = results.reduce((s, d) => s + d.budget, 0);
  console.log(`  Total depots    : ${results.length}`);
  console.log(`  Total tasks     : ${results.reduce((s, d) => s + d.selectedTasks.length, 0)}`);
  console.log(`  Total hours used: ${grandHours} / ${grandBudget}`);
  console.log(`  Total impact    : ${grandImpact}`);
  console.log("═".repeat(72) + "\n");

  await Log(
    "backend",
    "info",
    "handler",
    `Scheduling complete — grand total impact: ${grandImpact}, hours used: ${grandHours}/${grandBudget}`
  );
}

main().catch(async (err) => {
  await Log("backend", "fatal", "handler", `Unhandled error in scheduler: ${err}`);
  console.error(err);
  process.exit(1);
});
