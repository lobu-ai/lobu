-- migrate:up
-- lobu:no-quiesce — additive opt-in fields; existing authentication remains compatible.

ALTER TABLE public."user"
    ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false;

CREATE TABLE public."twoFactor" (
    id text PRIMARY KEY,
    "userId" text NOT NULL UNIQUE REFERENCES public."user"(id) ON DELETE CASCADE,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    "failedVerificationCount" integer NOT NULL DEFAULT 0,
    "lockedUntil" timestamptz NULL
);

-- migrate:down

-- Retain enrolled factors on rollback. Removing them would silently disable MFA.
