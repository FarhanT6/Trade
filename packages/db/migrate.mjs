#!/usr/bin/env node
// Minimal forward-only SQL migration runner: applies migrations/*.sql in lexical order once.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL ?? 'postgres://meme:meme@localhost:5432/meme_intel';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
const applied = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  if (applied.has(f)) continue;
  const sql = await readFile(path.join(dir, f), 'utf8');
  process.stdout.write(`applying ${f}… `);
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('insert into schema_migrations(name) values ($1)', [f]);
    await client.query('commit');
    console.log('ok');
  } catch (e) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(e.message);
    process.exitCode = 1;
    break;
  }
}
await client.end();
