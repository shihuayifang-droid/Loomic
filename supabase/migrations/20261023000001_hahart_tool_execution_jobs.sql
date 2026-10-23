-- Server-side tools (remove background, quick edit, ...) run as one job type;
-- payload.tool_id says which tool.
alter type public.background_job_type add value if not exists 'tool_execution';
select pgmq.create('tool_execution_jobs');
