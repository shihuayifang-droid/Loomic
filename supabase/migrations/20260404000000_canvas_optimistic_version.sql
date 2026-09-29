-- Optimistic concurrency for canvas content.
--
-- WHY
-- Every one of the six writers of canvases.content did a read-modify-write with
-- no protection:
--
--   select content        -- both writers read the same array
--   ...modify in JS...
--   update set content    -- the later write replaces the whole array
--
-- So an image the agent had just appended was silently erased by the next full
-- save from the browser. Confirmed on canvas 57143771: three successful
-- generations recorded in background_jobs (and three objects in Storage) while
-- content held a single element. The loss only became visible after a reload,
-- at which point it was permanent.
--
-- With a version column every writer can say "update only if nobody else wrote
-- since I read", and a conflict becomes a retry (agent-side, incremental edits)
-- or a 409 the client merges (browser-side, whole-content replacement) instead
-- of silent data loss.
ALTER TABLE public.canvases
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.canvases.version IS
  'Optimistic concurrency counter. Every content write must be conditioned on '
  'the version it read and must increment it. Never edit content without it.';
