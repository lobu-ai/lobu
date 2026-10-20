-- migrate:up
-- lobu:no-quiesce -- additive column with a constant default; old code never reads or writes it.
-- Per-agent conversation starters: up to three {title,message} prompts shown
-- on an empty web chat and as Slack assistant thread-start prompts. Constant
-- default, so no table rewrite.
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS starters jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.agents.starters IS
    'Conversation starters ({title,message}[], max 3) offered on an empty chat and as Slack assistant thread-start prompts.';

-- migrate:down

ALTER TABLE public.agents DROP COLUMN IF EXISTS starters;
