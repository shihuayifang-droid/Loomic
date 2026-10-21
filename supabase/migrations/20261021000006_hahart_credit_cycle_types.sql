-- 工单37O · BL-44 / BL-45 第 4 步（1/2）：给流水类型枚举补三个值。
--
-- 为什么单独一个文件：
--   PostgreSQL 不允许在「添加枚举值的同一事务」里使用这个新值。迁移按文件逐个执行，
--   所以这里只做 add value，用到这三个值的发放函数放在下一个迁移
--   （20261021000007_hahart_credit_cycle_grants.sql）。先例：
--   20260930000001_hahart_job_status_retrying.sql。
--
--   cycle_grant   月初团队池发放（BL-44）
--   cycle_reset   月初清零上月剩余（BL-44，不滚存）
--   daily_expire  前一天未花完的每日赠送过期（BL-45）

alter type public.credit_transaction_type add value if not exists 'cycle_grant';
alter type public.credit_transaction_type add value if not exists 'cycle_reset';
alter type public.credit_transaction_type add value if not exists 'daily_expire';
