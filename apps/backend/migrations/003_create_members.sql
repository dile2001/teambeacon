CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT members_team_fk
        FOREIGN KEY (team_id)
        REFERENCES teams(id)
);
