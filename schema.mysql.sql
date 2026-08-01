-- this trip, btw — MySQL schema (D-020: PHP + MySQL on DreamHost)
-- Behavioral mirror of schema.sql (D1). Apply once on the DreamHost MySQL host:
--   mysql -h <DB_HOST> -u <DB_USER> -p <DB_NAME> < schema.mysql.sql
-- worker.js + schema.sql remain the reference implementation this must match.

CREATE TABLE trips (
  slug            VARCHAR(16) PRIMARY KEY,
  name            VARCHAR(60) NOT NULL DEFAULT 'our trip',
  tier            ENUM('plan','keep','works') NOT NULL,
  edit_hash       CHAR(64) NOT NULL,
  view_hash       CHAR(64) NOT NULL,
  labels_json     TEXT NOT NULL,
  stripe_session  VARCHAR(255) NOT NULL UNIQUE,
  created         BIGINT NOT NULL,
  expires         BIGINT NULL,
  updated         BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- unified pin: stops, posts, sealed drops, quests are one object
CREATE TABLE pins (
  id            VARCHAR(24) PRIMARY KEY,
  slug          VARCHAR(16) NOT NULL,
  kind          ENUM('stop','post','sealed','quest') NOT NULL,
  track         VARCHAR(16) NULL,
  date          VARCHAR(10) NULL,
  ts            BIGINT NULL,
  lat           DOUBLE NOT NULL,
  lng           DOUBLE NOT NULL,
  title         VARCHAR(300) NOT NULL DEFAULT '',
  lodging       VARCHAR(300) NOT NULL DEFAULT '',
  notes         TEXT,
  photo         VARCHAR(300) NOT NULL DEFAULT '',
  spotify       VARCHAR(300) NOT NULL DEFAULT '',
  path          TEXT NULL,                                -- user-drawn boat/rail leg geometry: JSON [[lat,lng],...] (D-027)
  fly           TINYINT NOT NULL DEFAULT 0,
  mode          VARCHAR(16) NOT NULL DEFAULT 'drive',
  craft         VARCHAR(24) NOT NULL DEFAULT '',          -- D-048: a small craft on this leg.
                                                          -- With mode='water' it IS the vehicle
                                                          -- for the leg; on any other mode it is
                                                          -- cargo riding on that leg's track.
  here          TINYINT NOT NULL DEFAULT 0,
  near_only     TINYINT NOT NULL DEFAULT 0,              -- D-050: a post you have to have been
                                                          -- near to read. Same machinery as a
                                                          -- sealed drop, applied to a post.
  seq           BIGINT NOT NULL DEFAULT 0,
  opened_by     TEXT,
  claimed_team  VARCHAR(16) NOT NULL DEFAULT '',
  claimed_by    VARCHAR(40) NOT NULL DEFAULT '',
  author        VARCHAR(40) NOT NULL DEFAULT '',
  updated       BIGINT NOT NULL,
  deleted       TINYINT NOT NULL DEFAULT 0,
  KEY pins_sync (slug, updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notes (
  id       VARCHAR(24) PRIMARY KEY,
  slug     VARCHAR(16) NOT NULL,
  title    VARCHAR(120) NOT NULL DEFAULT '',
  body     TEXT,
  ord      BIGINT NOT NULL DEFAULT 0,
  updated  BIGINT NOT NULL,
  deleted  TINYINT NOT NULL DEFAULT 0,
  KEY notes_sync (slug, updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- per-person access (D-023): optional named members, each with their own
-- word-phrase (hashed like all others). Additive — the shared edit/view
-- phrases still work; a member phrase grants EDIT plus an identity (handle)
-- so stops/posts/movement can be attributed to a person. No email is stored.
CREATE TABLE members (
  id           VARCHAR(24) PRIMARY KEY,
  slug         VARCHAR(16) NOT NULL,
  handle       VARCHAR(40) NOT NULL,
  phrase_hash  CHAR(64) NOT NULL,
  created      BIGINT NOT NULL,
  deleted      TINYINT NOT NULL DEFAULT 0,
  KEY members_slug (slug),
  KEY members_auth (slug, phrase_hash, deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- failed password guesses, per trip per hour window
CREATE TABLE gate (
  slug VARCHAR(16) NOT NULL,
  win  BIGINT NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, win)
) ENGINE=InnoDB;

-- ── accounts (D-046) ────────────────────────────────────────────────────────────────────
-- An account is an email and a password, and nothing else about a person. No name, no
-- profile, no behaviour. It exists so someone can find their trips again and so we can reach
-- them when we must — Peter, 2026-07-27: "we do not profile and do not sell, but we'll need
-- an email to service them better, and we'll keep that as safe as we can."
--
-- The person→trips link below is plaintext on purpose (D-053). D-038 forbade it and Peter
-- reversed that knowingly: a database dump can now say which trips belong to which email.
-- That is the trade for an account that works the way people expect.
CREATE TABLE accounts (
  id          VARCHAR(24) PRIMARY KEY,
  email       VARCHAR(190) NOT NULL,
  pass_hash   VARCHAR(255) NULL,              -- password_hash(); NULL until they set one (D-067)
  verified    TINYINT NOT NULL DEFAULT 0,
  created     BIGINT NOT NULL,
  last_seen   BIGINT NULL,
  UNIQUE KEY accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A session is a random token the browser holds; we store only its SHA-256, the same way
-- trip phrases are stored (D-016). A database dump yields no usable cookie.
CREATE TABLE sessions (
  id          CHAR(64) PRIMARY KEY,           -- sha256(token)
  account_id  VARCHAR(24) NOT NULL,
  created     BIGINT NOT NULL,
  expires     BIGINT NOT NULL,
  KEY sessions_acct (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Failed sign-ins, per email, per hour. Mirrors the `gate` table's shape for trip phrases:
-- slow the guessing without ever letting an attacker lock a real person out.
CREATE TABLE login_gate (
  email VARCHAR(190) NOT NULL,
  win   BIGINT NOT NULL,
  hits  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (email, win)
) ENGINE=InnoDB;

-- Outbound mail, per address, per hour (D-076). Same shape and same purpose as login_gate:
-- slow an abuser without ever letting them lock a real person out. Both endpoints that send
-- mail take the address from an unauthenticated body, which is survivable only while an
-- account requires a Stripe payment. Open signup removes that, and an unthrottled mailer is
-- then a harassment tool aimed at strangers. Counted by address and hour, nothing else.
CREATE TABLE mail_gate (
  email VARCHAR(190) NOT NULL,
  win   BIGINT NOT NULL,
  hits  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (email, win)
) ENGINE=InnoDB;

-- Which trips are yours (D-053). `role` says how: you bought it, or you hold a personal link.
CREATE TABLE account_trips (
  account_id VARCHAR(24) NOT NULL,
  slug       VARCHAR(16) NOT NULL,
  role       VARCHAR(8) NOT NULL DEFAULT 'owner',   -- owner | member
  added      BIGINT NOT NULL,
  PRIMARY KEY (account_id, slug),
  KEY account_trips_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Password resets (D-056). The token is random and only its SHA-256 is stored, the same rule
-- as sessions and trip phrases: a database dump yields nothing anyone can redeem.
CREATE TABLE resets (
  id         CHAR(64) PRIMARY KEY,              -- sha256(token)
  account_id VARCHAR(24) NOT NULL,
  created    BIGINT NOT NULL,
  expires    BIGINT NOT NULL,
  used       TINYINT NOT NULL DEFAULT 0,
  KEY resets_acct (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
