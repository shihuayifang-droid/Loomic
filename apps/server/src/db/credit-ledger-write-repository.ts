import type { PriceDetail } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * BL-14 第 3 条 / GN-07 —— 待定价消费流水（工单 31B · T2）。
 *
 * 价格为 `pending`（待定价）时任务照常执行、按 0 扣费，但**必须留下一条消费流水**：
 * 「这个模型被用过一次，还没定价」。没有这条行，待定价与「压根没跑过」在账面上
 * 无法区分，BL-14 的验收 3 也就没有运行时证据。
 *
 * 三条口径（工单 31B 裁决 1、2）都在这里落地：
 *
 * 1. **不新增 enum 值**：`transaction_type` 写字面量 `'generation_deduct'`。待定价
 *    的标记放在 `metadata` 里 —— `{ price_pending: true, rule_id, price_detail }`。
 *    加 enum 值要连带改迁移、shared 的 `creditTransactionTypeSchema`、`database.ts`
 *    两处和响应 schema，而 PG 在同一个事务里不能使用刚加的 enum 值；现在没有任何
 *    读方需要区分 consume 与 generation_deduct。
 * 2. **金额 0 的流水直接 INSERT，不走 RPC**：`deduct_credits` 继续只负责 active 价格
 *    大于 0 的真实扣费，所以运行时 RPC 计数（审计 `server.rpcCallsRuntime`）不变。
 *    `balance_after` 取同一事务里读到的 `credit_balances.balance`，没有余额行时取 0。
 * 3. **固定 SQL**，一条读、一条写，参数一律 bind：模型 id / 规则 id 是用户可控的值，
 *    拼进 SQL 就是把账本的写法交给调用方。时间由数据库的 `now()` 默认值给，不在这里
 *    拼时间戳 —— 这一行的时间与它所属的事务是同一个时刻。
 */
export type CreditLedgerWriteRepository = {
  /**
   * 记一条金额 0、带 `price_pending` 标记的消费流水。
   *
   * `jobId` 为 null 表示这条流水不属于任何后台任务（同步出图路由不建 job）。
   * 返回新行的 id，调用方可以用它做归因；它**不会**被写回任务的 `credits_tx_id`，
   * 因为那一列的意思是「哪一笔扣费买下了这个任务」，而待定价没有扣费。
   */
  recordPendingConsume(input: {
    workspaceId: string;
    userId: string;
    jobId: string | null;
    description: string;
    ruleId: string;
    priceDetail: PriceDetail;
  }): Promise<{ transactionId: string }>;
};

export const RECORD_PENDING_CONSUME = "recordPendingConsume";

export type CreditLedgerWriteRepositoryOperation = typeof RECORD_PENDING_CONSUME;

/**
 * 失败形态。消息只由固定操作名拼出来：驱动错误里可能带着整条 SQL、主机名或连接串，
 * 不能顺着 message 漏进日志或 HTTP body。原错误挂在 `cause` 上，调用方仍能分类，
 * 但驱动原文不会被本模块转述出去（与 `pricing-rule-repository.ts` 同一写作规矩）。
 */
export class CreditLedgerWriteRepositoryError extends Error {
  readonly operation: CreditLedgerWriteRepositoryOperation;

  constructor(operation: CreditLedgerWriteRepositoryOperation, cause: unknown) {
    super(
      `credit ledger write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "CreditLedgerWriteRepositoryError";
    this.operation = operation;
  }
}

/**
 * 同一事务里的余额读数。
 *
 * `select` 而不是 `update ... returning`：这一行账**不动余额**（金额 0），所以不需要
 * 行锁；拿到的 `balance` 只是用来填 `balance_after`，让这条流水与真实扣费流水
 * 在账本里是同一形状。
 */
const READ_BALANCE_SQL = `
select b.balance
  from public.credit_balances b
 where b.workspace_id = $1::uuid
`;

/**
 * 待定价消费流水。
 *
 * `transaction_type` 与 `amount` 是**字面量**：它们不是参数，这个仓储也就只可能写
 * 出这一种流水。`metadata` 用 `$6::jsonb` 传，形状由调用方的 `PriceDetail` 决定
 * （GN-01 契约），这里不做二次拼装。
 */
const INSERT_PENDING_CONSUME_SQL = `
insert into public.credit_transactions (
  workspace_id,
  user_id,
  transaction_type,
  amount,
  balance_after,
  job_id,
  description,
  metadata
) values (
  $1::uuid,
  $2::uuid,
  'generation_deduct',
  0,
  $3::int,
  $4::uuid,
  $5::text,
  $6::jsonb
)
returning id::text as id
`;

/**
 * 构建 PostgreSQL 实现。pool 走 getter，构造仓储本身不读 `DATABASE_URL`、不连接、
 * 也不会在装配期失败；没有 pool 只会在真正写的时候变成
 * `CreditLedgerWriteRepositoryError`。
 */
export function createCreditLedgerWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CreditLedgerWriteRepository {
  return {
    async recordPendingConsume(input) {
      // 参数先校验：坏参数不该开连接，也不该被报成数据库失败。
      const workspaceId = requireArgument(RECORD_PENDING_CONSUME, input.workspaceId, "workspaceId");
      const userId = requireArgument(RECORD_PENDING_CONSUME, input.userId, "userId");
      const ruleId = requireArgument(RECORD_PENDING_CONSUME, input.ruleId, "ruleId");
      const description = requireArgument(
        RECORD_PENDING_CONSUME,
        input.description,
        "description",
      );
      const jobId =
        input.jobId === null
          ? null
          : requireArgument(RECORD_PENDING_CONSUME, input.jobId, "jobId");

      const metadata = JSON.stringify({
        price_pending: true,
        rule_id: ruleId,
        price_detail: input.priceDetail,
      });

      try {
        const pool = options.getTransactionPool();

        // 读余额与写流水必须在同一个事务里：`balance_after` 是「写这条流水的那一刻的
        // 余额」，分两个事务取会让两个数字各自自洽、拼起来却是错的。
        return await withPrivilegedTransaction(pool, null, async (client) => {
          const balanceResult = await client.query(READ_BALANCE_SQL, [workspaceId]);
          const balance = readBalance(RECORD_PENDING_CONSUME, balanceResult.rows);

          const inserted = await client.query(INSERT_PENDING_CONSUME_SQL, [
            workspaceId,
            userId,
            balance,
            jobId,
            description,
            metadata,
          ]);

          return { transactionId: requireInsertedId(RECORD_PENDING_CONSUME, inserted.rows) };
        });
      } catch (error) {
        // 已经是本模块的错误（参数校验 / 行映射）就原样抛出，不叠一层同样的包装。
        if (error instanceof CreditLedgerWriteRepositoryError) throw error;

        throw new CreditLedgerWriteRepositoryError(RECORD_PENDING_CONSUME, error);
      }
    },
  };
}

/**
 * 绑定值必须是真字符串。uuid / 时间的**形状**不在这里预检：非法值会作为 bind
 * 参数交给 PostgreSQL 自己拒绝（SQLSTATE 22P02），事务回滚、连接仍可用。
 */
function requireArgument(
  operation: CreditLedgerWriteRepositoryOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error(`credit ledger write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * 余额：零行 = 这个工作区还没有余额行（`trg_init_workspace_credits` 之前建的旧库），
 * 按 0 记 —— 工单 31B 裁决 2 的明文口径，不是兜底猜测。多于一行说明
 * `UNIQUE (workspace_id)` 被破坏，那才是真的坏了，所以拒绝。
 */
function readBalance(
  operation: CreditLedgerWriteRepositoryOperation,
  rows: readonly unknown[],
): number {
  if (rows.length === 0) return 0;
  if (rows.length > 1) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error("credit balance read returned more than one row"),
    );
  }

  const row = rows[0];

  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error("credit balance read returned a row that is not an object"),
    );
  }

  const balance = (row as Record<string, unknown>)["balance"];

  if (typeof balance !== "number" || !Number.isInteger(balance)) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error('credit balance read returned no usable "balance"'),
    );
  }

  return balance;
}

/** `insert ... returning id` 永远恰好一行；零行/多行说明语句与映射器不一致。 */
function requireInsertedId(
  operation: CreditLedgerWriteRepositoryOperation,
  rows: readonly unknown[],
): string {
  if (rows.length !== 1) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error("credit ledger insert did not return exactly one id"),
    );
  }

  const row = rows[0];

  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error("credit ledger insert returned a row that is not an object"),
    );
  }

  const id = (row as Record<string, unknown>)["id"];

  if (typeof id !== "string" || id.length === 0) {
    throw new CreditLedgerWriteRepositoryError(
      operation,
      new Error('credit ledger insert returned no usable "id"'),
    );
  }

  return id;
}
