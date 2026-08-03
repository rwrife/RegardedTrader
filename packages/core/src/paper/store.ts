import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PaperOrder, PaperPosition, TradePlan } from '../schemas/index.js';

const OrdersFile = z.object({
  version: z.literal(1),
  orders: z.array(PaperOrder),
});
type OrdersFile = z.infer<typeof OrdersFile>;

const PositionsFile = z.object({
  version: z.literal(1),
  positions: z.array(PaperPosition),
});
type PositionsFile = z.infer<typeof PositionsFile>;

const PlansFile = z.object({
  version: z.literal(1),
  plans: z.array(
    z.object({
      id: z.string().min(1),
      symbol: z.string().min(1),
      createdAt: z.string(),
      plan: TradePlan,
    }),
  ),
});
type PlansFile = z.infer<typeof PlansFile>;

export interface PaperStoreOptions {
  homeDir?: string;
}

export class PaperStore {
  private readonly baseDir: string;
  private readonly ordersPath: string;
  private readonly positionsPath: string;
  private readonly plansPath: string;

  constructor(opts: PaperStoreOptions = {}) {
    const home = opts.homeDir?.trim() || process.env.REGARDEDTRADER_HOME?.trim() || join(homedir(), '.regardedtrader');
    this.baseDir = join(home, 'paper');
    this.ordersPath = join(this.baseDir, 'orders.json');
    this.positionsPath = join(this.baseDir, 'positions.json');
    this.plansPath = join(this.baseDir, 'plans.json');
  }

  async listOrders(): Promise<z.infer<typeof PaperOrder>[]> {
    const f = await this.readOrdersFile();
    return f.orders.slice();
  }

  async listPositions(): Promise<z.infer<typeof PaperPosition>[]> {
    const f = await this.readPositionsFile();
    return f.positions.slice();
  }

  async append(order: z.infer<typeof PaperOrder>, position: z.infer<typeof PaperPosition>): Promise<void> {
    const [orders, positions] = await Promise.all([this.readOrdersFile(), this.readPositionsFile()]);
    await Promise.all([
      this.writeJson(this.ordersPath, { version: 1, orders: orders.orders.concat(order) }),
      this.writeJson(this.positionsPath, { version: 1, positions: positions.positions.concat(position) }),
    ]);
  }

  async cachePlans(
    symbol: string,
    plans: Array<{ id: string; plan: z.infer<typeof TradePlan> }>,
  ): Promise<void> {
    const cur = await this.readPlansFile();
    const now = new Date().toISOString();
    const entries = plans.map((p) => ({
      id: p.id,
      symbol,
      createdAt: now,
      plan: p.plan,
    }));
    await this.writeJson(this.plansPath, {
      version: 1,
      plans: cur.plans.filter((x) => !entries.find((e) => e.id === x.id)).concat(entries),
    });
  }

  async findPlan(planId: string): Promise<z.infer<typeof TradePlan> | null> {
    const cur = await this.readPlansFile();
    const found = [...cur.plans].reverse().find((f) => f.id === planId);
    return found?.plan ?? null;
  }

  async listPlans(): Promise<Array<{ id: string; symbol: string; createdAt: string; plan: z.infer<typeof TradePlan> }>> {
    const cur = await this.readPlansFile();
    return cur.plans.slice();
  }

  private async readOrdersFile(): Promise<OrdersFile> {
    return this.readJson(this.ordersPath, OrdersFile, { version: 1, orders: [] });
  }

  private async readPositionsFile(): Promise<PositionsFile> {
    return this.readJson(this.positionsPath, PositionsFile, { version: 1, positions: [] });
  }

  private async readPlansFile(): Promise<PlansFile> {
    return this.readJson(this.plansPath, PlansFile, { version: 1, plans: [] });
  }

  private async readJson<T>(
    path: string,
    schema: z.ZodType<T>,
    fallback: T,
  ): Promise<T> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = schema.safeParse(JSON.parse(raw));
      if (!parsed.success) return fallback;
      return parsed.data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw e;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  }
}
