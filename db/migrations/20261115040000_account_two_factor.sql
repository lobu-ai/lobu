-- migrate:up
-- lobu:no-quiesce — additive opt-in fields; existing authentication remains compatible.

ALTER TABLE public."user"
    ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public."twoFactor" (
    id text PRIMARY KEY,
    "userId" text NOT NULL UNIQUE REFERENCES public."user"(id) ON DELETE CASCADE,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    -- squawk-ignore prefer-bigint-over-int -- Better Auth counter is bounded by the ten-attempt lockout and resets after verification.
    "failedVerificationCount" integer NOT NULL DEFAULT 0,
    "lockedUntil" timestamptz NULL
);

-- migrate:down

-- Retain enrolled factors on rollback. Removing them would silently disable MFA.
